import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import page from "./web/index.html";
import { loadSounds } from "./config";
import { soundUrl, type ServerMessage, type Sound } from "./protocol";

type Peer = { role: "listener" | "control"; ready: boolean };
const projectDir = join(import.meta.dir, "..");

export async function createServer(options: {
  port?: number;
  hostname?: string;
  configPath?: string;
  publicDir?: string;
} = {}) {
  const publicDir = options.publicDir ?? join(projectDir, "public");
  const sounds = await loadSounds(options.configPath ?? join(projectDir, "sounds.json"), publicDir);
  const byName = new Map<string, Sound>(sounds.map(sound => [sound.name, sound]));
  const files = new Map(sounds.map(sound => [soundUrl(sound.filename), join(publicDir, sound.filename)]));
  const peers = new Set<ServerWebSocket<Peer>>();
  const presence = () => {
    const listeners = [...peers].filter(peer => peer.data.role === "listener");
    return { type: "presence" as const, connected: listeners.length, ready: listeners.filter(peer => peer.data.ready).length };
  };
  const send = (peer: ServerWebSocket<Peer>, message: ServerMessage) => peer.send(JSON.stringify(message));
  const updatePresence = () => {
    const message = presence();
    for (const peer of peers) send(peer, message);
  };

  return Bun.serve<Peer>({
    // Accept both localhost addresses (::1 and 127.0.0.1), plus LAN clients.
    hostname: options.hostname ?? process.env.HOST ?? "::",
    port: options.port ?? Number(process.env.PORT ?? 3000),
    development: false,
    routes: { "/": page, "/control": page },
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) return new Response("Origin not allowed", { status: 403 });
        const role = url.searchParams.get("role");
        if (role !== "listener" && role !== "control") return new Response("Invalid role", { status: 400 });
        if (server.upgrade(request, { data: { role, ready: false } })) return;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const file = files.get(url.pathname);
      if (file) return new Response(Bun.file(file), { headers: { "Cache-Control": "no-cache" } });
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 4096,
      idleTimeout: 120,
      sendPings: true,
      open(peer) {
        peers.add(peer);
        send(peer, { type: "config", sounds });
        updatePresence();
      },
      message(peer, raw) {
        try {
          const message = JSON.parse(String(raw));
          if (message?.type === "ready" && peer.data.role === "listener" && typeof message.ready === "boolean") {
            peer.data.ready = message.ready;
            updatePresence();
            return;
          }
          if (message?.type === "play" && peer.data.role === "control" && typeof message.name === "string" && byName.has(message.name)) {
            const event: ServerMessage = { type: "play", name: message.name, eventId: crypto.randomUUID() };
            for (const listener of peers) if (listener.data.role === "listener") send(listener, event);
            send(peer, { type: "sent", name: message.name, ready: presence().ready });
            return;
          }
          send(peer, { type: "error", message: "Invalid event or unknown sound." });
        } catch {
          send(peer, { type: "error", message: "Expected a JSON event." });
        }
      },
      close(peer) {
        peers.delete(peer);
        updatePresence();
      },
    },
  });
}

if (import.meta.main) {
  const server = await createServer();
  console.log(`Remote Sound listening on ${server.url}`);
  console.log(`Listener: http://localhost:${server.port}/`);
  console.log(`Control:  http://localhost:${server.port}/control`);
}
