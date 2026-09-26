# Remote Sound

A Bun + TypeScript soundboard. Open `/` on speaker devices and `/control` on the device sending sounds. Both pages connect to the server over WebSockets, and every control button broadcasts its sound to all listening pages.

## Run

Requires Bun 1.3.8 or newer.

```sh
bun install
bun dev
```

- Listener: http://localhost:3000/
- Controller: http://localhost:3000/control

For another device on the same network, replace `localhost` with the server computer's LAN IP address, for example `http://192.168.1.20:3000/`. Allow inbound TCP port 3000 through the host firewall if necessary. The server binds to `::` by default, accepting IPv6 and IPv4 connections so either localhost address works; `HOST` and `PORT` environment variables override that. Set `HOST=0.0.0.0` if your system has IPv6 disabled.

Each listener attempts to enable sound automatically on startup. If the browser blocks autoplay, tap **Enable sound** once to unlock audio. Keep the page open and the device awake: mobile browsers may suspend audio or network activity in the background or when locked. The page reconnects automatically after a connection loss; tap Enable sound again if the browser suspends audio. Events missed while disconnected or before audio is enabled are not replayed.

## Configure sounds

Edit `sounds.json` in the project root:

```json
[
  { "name": "Chime", "filename": "chime.mp3" },
  { "name": "Success", "filename": "success.mp3" },
  { "name": "Alert", "filename": "alert.mp3" }
]
```

Place MP3 files directly in `public/`. Each sound needs a unique name and a simple filename (letters, numbers, spaces, dots, underscores, and hyphens; no directories). Restart the server after changing the configuration. Missing files, invalid entries, and duplicate names cause a clear startup error. Configured files are served at `/public/<filename>`; other project files are not exposed.

Three original synthesized MP3s are included.

## Commands

```sh
bun start          # Run without file watching
bun run typecheck  # TypeScript checks
bun test           # Config and HTTP/WebSocket integration tests
bun run test:browser # Browser audio, controls, mobile layout, and reconnect checks
```

The optional browser check uses Node.js 22.6+ and Playwright Chromium (the app itself runs entirely on Bun). Install Chromium once with `bunx playwright install chromium` if it is not already available. Screenshots are written to `test-results/`.

No frontend framework or runtime dependencies are needed. Bun bundles the HTML, TypeScript, and CSS automatically. See [Bun's server documentation](https://bun.sh/docs/runtime/http/server).

## WebSocket protocol

Connect to `/ws?role=listener` or `/ws?role=control`. The server sends `{ "type": "config", "sounds": [...] }` on connection and `{ "type": "presence", "connected": 2, "ready": 1 }` whenever listener readiness changes.

- Controller → server: `{ "type": "play", "name": "Chime" }`
- Server → listeners: `{ "type": "play", "name": "Chime", "eventId": "..." }`
- Listener → server: `{ "type": "ready", "ready": true }`
- Server → originating controller: `{ "type": "sent", "name": "Chime", "ready": 1 }`

The ready count indicates clients reporting unlocked, loaded audio, not a playback acknowledgement. Sounds can overlap. Delivery is immediate, with no clock synchronization between devices.

This is a shared soundboard intended for a trusted network. Anyone who can reach `/control` can trigger sounds; there is no login. A single server process owns the live session. For HTTPS deployments, serve both pages and the WebSocket endpoint under the same origin, and ensure the reverse proxy forwards WebSocket upgrades and preserves the public Host and scheme.
