'use strict';
/**
 * Quiz Arena - servidor sin dependencias externas (solo módulos nativos de Node >= 18).
 * Sirve la carpeta /public y gestiona las partidas por WebSocket en /ws.
 *
 * Variables de entorno opcionales:
 *   PORT            puerto (por defecto 3000)
 *   PUBLIC_URL      dirección pública si lo alojas en internet, p. ej. https://mi-juego.onrender.com
 *   GAME_SECONDS    duración de cada minijuego (por defecto 120)
 *   BREAK_SECONDS   descanso entre minijuegos (por defecto 6)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || null;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 50;
const GAMES = 5;
const DUR = (Number(process.env.GAME_SECONDS) || 120) * 1000;
const BRK = (Number(process.env.BREAK_SECONDS) || 6) * 1000;
const MAX_ROOMS = 500;
const AVATARS = 18;
const MAX_MSG = 4096;

/* ------------------------------------------------------------------ HTTP */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => score(a) - score(b));
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }

  if (pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ publicUrl: PUBLIC_URL, lan: lanIPs(), port: PORT, max: MAX_PLAYERS }));
  }
  if (pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ------------------------------------------------------- WebSocket (RFC 6455) */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const conns = new Set();

class Conn {
  constructor(socket) {
    this.s = socket; this.buf = Buffer.alloc(0); this.frag = []; this.fragOp = 0; this.fragLen = 0;
    this.alive = true; this.closed = false; this.ended = false;
    this.onmsg = null; this.onclose = null;
    this.role = null; this.room = null; this.pid = null;
    this.msgCount = 0;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._end());
    socket.on('error', () => this._end());
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > MAX_MSG * 4) return this.close(1009);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) > 0) return this.close(1009);
        len = b.readUInt32BE(6); off = 10;
      }
      if (len > MAX_MSG) return this.close(1009);
      if (!masked) return this.close(1002);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._frame(fin, op, payload);
      if (this.closed) return;
    }
  }
  _frame(fin, op, p) {
    if (op === 0x8) return this.close();
    if (op === 0x9) return this._send(0xA, p);
    if (op === 0xA) { this.alive = true; return; }
    if (op === 0x1 || op === 0x2) {
      if (this.frag.length) return this.close(1002);
      this.fragOp = op; this.frag = [p]; this.fragLen = p.length;
    } else if (op === 0x0) {
      if (!this.frag.length) return this.close(1002);
      this.frag.push(p); this.fragLen += p.length;
      if (this.fragLen > MAX_MSG) return this.close(1009);
    } else return this.close(1002);
    if (fin) {
      const msg = Buffer.concat(this.frag); const o = this.fragOp;
      this.frag = []; this.fragLen = 0;
      if (o === 0x1 && this.onmsg) this.onmsg(msg.toString('utf8'));
    }
  }
  _send(op, payload) {
    if (this.closed || this.s.destroyed) return;
    if (this.s.writableLength > 1e6) return this.close(1013);
    const n = payload.length; let h;
    if (n < 126) h = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
    this.s.write(Buffer.concat([h, payload]));
  }
  send(obj) { this._send(0x1, Buffer.from(JSON.stringify(obj))); }
  ping() { this._send(0x9, Buffer.alloc(0)); }
  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this._send(0x8, p);
    this.closed = true;
    this.s.end();
    setTimeout(() => this.s.destroy(), 1000).unref();
    this._end();
  }
  _end() {
    if (this.ended) return;
    this.ended = true; this.closed = true; conns.delete(this);
    if (this.onclose) this.onclose();
  }
}

server.on('upgrade', (req, socket) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* ignore */ }
  const key = req.headers['sec-websocket-key'];
  if (pathname !== '/ws' || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = new Conn(socket);
  conns.add(c);
  onConnection(c);
});

setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { c.s.destroy(); c._end(); continue; }
    c.alive = false; c.ping();
  }
}, 25000).unref();

/* ----------------------------------------------------------------- Juego */
const rooms = new Map();

function genCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  for (let t = 0; t < 1000; t++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14) || 'Jugador';
const cleanAv = (n) => { n = Number(n) | 0; return n >= 0 && n < AVATARS ? n : 0; };
const validId = (s) => typeof s === 'string' && /^[a-z0-9]{6,24}$/.test(s);
const validCode = (s) => typeof s === 'string' && /^[A-Za-z]{4}$/.test(s);

function ranking(r) {
  return [...r.players.values()].sort((a, b) => b.p - a.p || b.g - a.g || a.joined - b.joined);
}
function stateMsg(r, p) {
  const m = { t: 'state', ph: r.ph, i: r.i, ms: Math.max(0, r.deadline - Date.now()) };
  if (p) { m.p = p.p; m.g = p.g; }
  if (r.ph === 'end') {
    const rk = ranking(r);
    m.r = rk.map((x) => [x.n, x.a, x.p, x.g]);
    if (p) m.me = rk.indexOf(p);
  }
  return m;
}
function lbMsg(r) {
  return { t: 'lb', r: ranking(r).map((x) => ({ n: x.n, a: x.a, p: x.p, g: x.g, on: !!x.conn })) };
}
function sendLobby(r) {
  if (!r.host) return;
  const list = [...r.players.values()].map((x) => ({ n: x.n, a: x.a, on: !!x.conn }));
  r.host.send({ t: 'lobby', list });
}
function pushState(r) {
  if (r.host) { r.host.send(stateMsg(r, null)); if (r.ph !== 'lobby') r.host.send(lbMsg(r)); }
  for (const p of r.players.values()) if (p.conn) p.conn.send(stateMsg(r, p));
}

function startG(r, i) {
  clearTimeout(r.timer);
  r.ph = 'play'; r.i = i; r.deadline = Date.now() + DUR;
  r.timer = setTimeout(() => brk(r, i), DUR);
  for (const p of r.players.values()) p.lastOk = Date.now() - 1500;
  pushState(r);
}
function brk(r, i) {
  clearTimeout(r.timer);
  if (i >= GAMES - 1) return endG(r);
  r.ph = 'break'; r.i = i; r.deadline = Date.now() + BRK;
  r.timer = setTimeout(() => startG(r, i + 1), BRK);
  pushState(r);
}
function endG(r) {
  clearTimeout(r.timer);
  r.ph = 'end'; r.i = GAMES - 1; r.deadline = 0; r.endedAt = Date.now();
  pushState(r);
}

function hostMsg(c, d) {
  let r;
  if (d.code) {
    r = rooms.get(String(d.code).toUpperCase());
    if (!r || r.token !== d.token) return c.send({ t: 'err', e: 'noroom' });
    if (r.host && r.host !== c) { r.host.room = null; r.host.close(1000); }
  } else {
    if (rooms.size >= MAX_ROOMS) return c.send({ t: 'err', e: 'busy' });
    const code = genCode();
    if (!code) return c.send({ t: 'err', e: 'busy' });
    r = { code, token: crypto.randomBytes(12).toString('hex'), host: null, hostGone: 0, players: new Map(),
      ph: 'lobby', i: 0, deadline: 0, timer: null, dirty: false, created: Date.now(), endedAt: 0 };
    rooms.set(code, r);
  }
  r.host = c; r.hostGone = 0; c.role = 'h'; c.room = r;
  c.send({ t: 'hosted', code: r.code, token: r.token, max: MAX_PLAYERS });
  sendLobby(r);
  c.send(stateMsg(r, null));
  if (r.ph !== 'lobby') c.send(lbMsg(r));
}

function playerMsg(c, d) {
  if (!validCode(d.code)) return c.send({ t: 'err', e: 'noroom' });
  const r = rooms.get(d.code.toUpperCase());
  if (!r) return c.send({ t: 'err', e: 'noroom' });
  if (!validId(d.id)) return c.send({ t: 'err', e: 'bad' });
  let p = r.players.get(d.id);
  if (p) {
    if (p.conn && p.conn !== c) { p.conn.room = null; p.conn.close(1000); }
    p.conn = c;
    if (r.ph === 'lobby') { p.n = cleanName(d.n); p.a = cleanAv(d.a); }
  } else {
    if (r.ph !== 'lobby') return c.send({ t: 'err', e: 'started' });
    if (r.players.size >= MAX_PLAYERS) return c.send({ t: 'err', e: 'full' });
    p = { id: d.id, n: cleanName(d.n), a: cleanAv(d.a), p: 0, g: 0, conn: c, lastOk: 0, joined: Date.now() };
    r.players.set(d.id, p);
  }
  c.role = 'p'; c.room = r; c.pid = d.id;
  c.send({ t: 'joined', code: r.code, n: p.n, a: p.a });
  c.send(stateMsg(r, p));
  if (r.ph === 'lobby') sendLobby(r); else r.dirty = true;
}

function okMsg(c, d) {
  const r = c.room;
  if (c.role !== 'p' || !r || r.ph !== 'play') return;
  const p = r.players.get(c.pid);
  if (!p) return;
  const now = Date.now();
  if (now > r.deadline + 800 || now - p.lastOk < 1000) {   // fuera de tiempo o demasiado rápido: no suma
    c.send({ t: 'score', p: p.p, g: p.g });                // y se reenvía el puntaje real para que el cliente se resincronice
    return;
  }
  p.lastOk = now;
  let secs = Number(d.s);
  if (!Number.isFinite(secs)) secs = 30;
  secs = Math.min(60, Math.max(0.6, secs));
  p.p += 100 + Math.max(0, Math.round(50 - secs * 2.5));
  p.g += 1;
  r.dirty = true;
  c.send({ t: 'score', p: p.p, g: p.g });
}

function onConnection(c) {
  c.onmsg = (raw) => {
    if (++c.msgCount > 400) return c.close(1008);   // protección contra spam (se reinicia cada 10 s)
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d !== 'object') return;
    try {
      switch (d.t) {
        case 'host': return hostMsg(c, d);
        case 'join': return playerMsg(c, d);
        case 'ok': return okMsg(c, d);
        case 'start': {
          const r = c.room;
          if (c.role === 'h' && r && r.ph === 'lobby' && r.players.size > 0) startG(r, 0);
          return;
        }
        case 'skip': {
          const r = c.room;
          if (c.role !== 'h' || !r) return;
          if (r.ph === 'play') brk(r, r.i);
          else if (r.ph === 'break') startG(r, r.i + 1);
          return;
        }
        default: return;
      }
    } catch (e) { console.error('Error procesando mensaje:', e); }
  };
  c.onclose = () => {
    const r = c.room;
    if (!r) return;
    if (c.role === 'h') {
      if (r.host === c) { r.host = null; r.hostGone = Date.now(); }
    } else {
      const p = r.players.get(c.pid);
      if (p && p.conn === c) {
        p.conn = null;
        if (r.ph === 'lobby') { r.players.delete(p.id); sendLobby(r); } else r.dirty = true;
      }
    }
  };
}

let tick = 0;
setInterval(() => {
  tick++;
  if (tick % 10 === 0) for (const c of conns) c.msgCount = 0;
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.dirty && r.host && r.ph !== 'lobby') { r.host.send(lbMsg(r)); r.dirty = false; }
    if (tick % 5 === 0 && (r.ph === 'play' || r.ph === 'break')) {
      const ms = Math.max(0, r.deadline - now);
      if (r.host) r.host.send({ t: 'tick', ms });
      for (const p of r.players.values()) if (p.conn) p.conn.send({ t: 'tick', ms });
    }
    const hostLost = !r.host && r.hostGone && now - r.hostGone > 15 * 60 * 1000;
    const finished = r.ph === 'end' && r.endedAt && now - r.endedAt > 30 * 60 * 1000;
    const stale = now - r.created > 6 * 60 * 60 * 1000;
    if (hostLost || finished || stale) {
      clearTimeout(r.timer);
      for (const p of r.players.values()) if (p.conn) p.conn.close(1000);
      if (r.host) r.host.close(1000);
      rooms.delete(code);
    }
  }
}, 1000).unref();

/* --------------------------------------------------------------- Arranque */
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  🎮  Quiz Arena en marcha\n');
  console.log('  Administrador (este equipo):  http://localhost:' + PORT);
  const ips = lanIPs();
  if (ips.length) {
    console.log('  Celulares en el mismo WiFi:');
    for (const ip of ips) console.log('      http://' + ip + ':' + PORT);
  } else {
    console.log('  (No se detectó una red local; los celulares no podrán conectarse a este equipo.)');
  }
  if (PUBLIC_URL) console.log('  PUBLIC_URL: ' + PUBLIC_URL);
  console.log('\n  Abre la dirección de administrador, pulsa "Crear partida" y muestra el QR.\n');
});
