import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server";
import { loadSounds } from "../src/config";
import { soundUrl, type ServerMessage } from "../src/protocol";

const configuredSounds = await loadSounds(join(import.meta.dir, "../sounds.json"), join(import.meta.dir, "../public"));
const firstSound = configuredSounds[0];
const nextSound = configuredSounds[1] ?? firstSound;
const server = await createServer({ port: 0, hostname: "127.0.0.1" });
const base = server.url.origin;
const clients: WebSocket[] = [];
afterAll(() => {
  for (const socket of clients) socket.close();
  server.stop(true);
});

async function connect(role: "listener" | "control") {
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws?role=${role}`);
  clients.push(socket);
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    socket,
    messages,
    async next(type: ServerMessage["type"], predicate: (message: any) => boolean = () => true) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(message => message.type === type && predicate(message));
        if (index >= 0) return messages.splice(index, 1)[0] as any;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for ${type}`);
    },
  };
}

describe("HTTP and WebSockets", () => {
  test("accepts HTTP and WebSockets through IPv4 and IPv6 loopback", async () => {
    const dualStack = await createServer({ port: 0, hostname: "::" });
    try {
      for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
        const origin = `http://${host}:${dualStack.port}`;
        expect((await fetch(origin)).status).toBe(200);
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`${origin.replace("http", "ws")}/ws?role=listener`);
          const timeout = setTimeout(() => {
            socket.close();
            reject(new Error(`WebSocket timed out for ${host}`));
          }, 2000);
          socket.addEventListener("message", event => {
            if (JSON.parse(String(event.data)).type === "config") {
              clearTimeout(timeout);
              socket.close();
              resolve();
            }
          });
          socket.addEventListener("error", () => {
            clearTimeout(timeout);
            socket.close();
            reject(new Error(`WebSocket failed for ${host}`));
          });
        });
      }
    } finally {
      dualStack.stop(true);
    }
  });

  test("serves both pages and configured MP3s, without exposing project files", async () => {
    for (const path of ["/", "/control"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Remote Sound");
    }
    const mp3 = await fetch(`${base}${soundUrl(firstSound.filename)}`);
    expect(mp3.status).toBe(200);
    expect(mp3.headers.get("content-type")).toContain("audio/mpeg");
    expect((await mp3.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    for (const path of ["/sounds.json", "/src/server.ts", "/public/missing.mp3", "/public/%2e%2e%2fsounds.json"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${base}/ws?role=invalid`)).status).toBe(400);
    expect((await fetch(`${base}/ws?role=control`, { headers: { Origin: "https://elsewhere.example" } })).status).toBe(403);
  });

  test("broadcasts to every listener, reports readiness, rejects invalid events, and accepts reconnects", async () => {
    const listenerA = await connect("listener");
    const listenerB = await connect("listener");
    const control = await connect("control");
    expect((await control.next("config")).sounds).toEqual(configuredSounds);
    listenerA.socket.send(JSON.stringify({ type: "ready", ready: true }));
    await control.next("presence", message => message.connected === 2 && message.ready === 1);
    control.socket.send(JSON.stringify({ type: "play", name: firstSound.name }));
    const first = await listenerA.next("play");
    const second = await listenerB.next("play");
    expect(first.name).toBe(firstSound.name);
    expect(second.eventId).toBe(first.eventId);
    expect((await control.next("sent")).ready).toBe(1);
    expect(control.messages.some(message => message.type === "play")).toBe(false);

    for (const payload of ["not JSON", "null", JSON.stringify({ type: "play", name: "unknown" })]) {
      control.socket.send(payload);
      await control.next("error");
    }
    listenerA.socket.send(JSON.stringify({ type: "play", name: firstSound.name }));
    await listenerA.next("error");
    listenerA.socket.close();
    await control.next("presence", message => message.connected === 1 && message.ready === 0);
    const reconnected = await connect("listener");
    await reconnected.next("config");
    control.socket.send(JSON.stringify({ type: "play", name: nextSound.name }));
    expect((await reconnected.next("play")).name).toBe(nextSound.name);
    listenerB.socket.close();
    reconnected.socket.close();
    control.socket.close();
  });
});

test("config rejects empty lists, duplicate names, missing files, and path traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-sound-test-"));
  const config = join(directory, "sounds.json");
  try {
    await Bun.write(join(directory, "sample.mp3"), "test");
    for (const invalid of [[], [{ name: "Missing", filename: "missing.mp3" }], [{ name: "Unsafe", filename: "../sample.mp3" }], [{ name: "Same", filename: "sample.mp3" }, { name: "Same", filename: "sample.mp3" }]]) {
      await Bun.write(config, JSON.stringify(invalid));
      await expect(loadSounds(config, directory)).rejects.toThrow();
    }
    await Bun.write(config, JSON.stringify([{ name: "Sample", filename: "sample.mp3" }]));
    expect(await loadSounds(config, directory)).toEqual([{ name: "Sample", filename: "sample.mp3" }]);
  } finally {
    // Only the unique temporary fixture directory created by this test is removed.
    await rm(directory, { recursive: true, force: true });
  }
});
