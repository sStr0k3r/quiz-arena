# 🎮 Quiz Arena

Juego multijugador de minijuegos: el administrador crea una partida, los jugadores entran escaneando un **QR** desde el navegador del celular (sin cuentas, sin instalar nada) y compiten en 5 minijuegos de 2 minutos. Al final hay podio y tabla completa de posiciones.

- Hasta **50 jugadores** por partida.
- Minijuegos: 🧠 Trivia (4 opciones) · 🪢 Ahorcado · 🔀 Palabra revuelta · 🔎 Sopa de letras · ➗ Cálculo rápido.
- Puntaje: 100 por acierto + hasta 50 de bono según la rapidez.
- El administrador ve el ranking en vivo, puede saltar minijuegos y decide cuándo iniciar.
- **Sin dependencias**: solo necesitas Node.js 18 o superior. No hay que ejecutar `npm install`.

## Cómo jugar en una red local (WiFi)

1. Instala Node.js desde https://nodejs.org (versión 18 o superior).
2. Abre una terminal en esta carpeta y ejecuta:
   ```
   node server.js
   ```
3. En el computador del administrador abre **http://localhost:3000**, pulsa **Crear partida** y muestra el QR en la pantalla.
4. Los jugadores, conectados **al mismo WiFi**, escanean el QR (o abren la dirección y escriben el código de 4 letras).
5. Cuando todos estén conectados, el administrador pulsa **▶ Iniciar juego**.

Si hay varias redes en el computador, la pantalla del administrador permite elegir cuál dirección usar en el QR.

**Si los celulares no logran abrir la página:**
- Permite a Node.js en el firewall de Windows/macOS cuando lo pregunte (redes privadas).
- Algunas redes (colegios, universidades, WiFi de invitados) aíslan los dispositivos entre sí. En ese caso conecta todos al **hotspot** del celular del administrador, o usa la opción de internet de abajo.

## Cómo jugar por internet (sin estar en la misma red)

Sube la carpeta a cualquier servicio que ejecute Node.js (por ejemplo Render, Railway, Fly.io o Replit) con el comando de inicio `node server.js`. El servicio te dará una dirección `https://…`; ábrela como administrador y el QR ya apuntará a esa dirección. Los WebSockets funcionan sobre `wss://` automáticamente.

Nota: algunos planes gratuitos “duermen” el servidor tras un rato sin uso; abre la página unos minutos antes de empezar.

## Configuración opcional (variables de entorno)

| Variable | Qué hace | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `PUBLIC_URL` | Dirección pública que se pone en el QR (solo si estás detrás de un proxy y la detectada no es la correcta) | automática |
| `GAME_SECONDS` | Duración de cada minijuego | `120` |
| `BREAK_SECONDS` | Descanso entre minijuegos | `6` |

Ejemplo para probar rápido con minijuegos de 20 segundos: `GAME_SECONDS=20 node server.js` (en Windows PowerShell: `$env:GAME_SECONDS=20; node server.js`).

## Personalizar el contenido

Las preguntas y palabras están al inicio del script de `public/index.html`:

- `TQ`: preguntas de trivia `[pregunta, [4 opciones], índice de la correcta]`
- `HW`: palabras del ahorcado `[PALABRA, pista]`
- `SW`: palabras de la palabra revuelta
- `WW`: palabras de la sopa de letras (máximo 5 letras)
- `AV`: avatares disponibles (si agregas más de 18, cambia también `AVATARS` en `server.js`)

Usa palabras en mayúsculas y sin tildes en `HW`, `SW` y `WW`.

## Cosas a tener en cuenta

- Las partidas viven en la memoria del servidor: si lo reinicias, se pierden. Una partida terminada se borra a los 30 minutos.
- Si un jugador recarga la página o pierde la conexión, vuelve solo a su partida y conserva su puntaje. El administrador también puede recargar y recupera su sala.
- Una vez iniciado el juego no pueden entrar jugadores nuevos.
- Los puntajes los calcula el servidor a partir de los aciertos que informa cada navegador, con límites de velocidad. Es suficiente para jugar entre amigos o en clase, pero alguien con conocimientos técnicos podría hacer trampa; no está pensado para torneos con premios.

## Archivos

```
server.js          servidor HTTP + WebSocket (salas, temporizador, puntajes)
public/index.html  interfaz del administrador y de los jugadores, y los minijuegos
public/qrcode.js   generador de QR (MIT, Kazuhiko Arase)
```
