import { soundUrl, type ClientMessage, type ServerMessage, type Sound } from "../protocol";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const isControl = location.pathname === "/control";
const enable = element<HTMLButtonElement>("enable");
const activity = element("activity");
const buffers = new Map<string, AudioBuffer>();
let sounds: Sound[] = [];
let socket: WebSocket;
let context: AudioContext | undefined;
let gain: GainNode | undefined;
let loading = false;
let configLoaded = false;
let configVersion = "";
let reconnectAttempt = 0;
let autoEnableAttempted = false;

element("listener").hidden = isControl;
element("controller").hidden = !isControl;
document.title = `${isControl ? "Control" : "Listen"} · Remote Sound`;

function send(message: ClientMessage) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function isReady() {
  return configLoaded && !loading && sounds.length > 0 && context?.state === "running" && sounds.every(sound => buffers.has(sound.name));
}

function updateAudio() {
  if (isControl) return;
  const ready = isReady();
  enable.disabled = loading || !configLoaded || ready;
  enable.textContent = loading ? "Loading…" : ready ? "Sound enabled" : "Enable sound";
  send({ type: "ready", ready });
}

async function loadAudio() {
  if (!context || loading) return;
  const version = configVersion;
  loading = true;
  updateAudio();
  try {
    const audioContext = context;
    const decoded = await Promise.all(sounds.map(async sound => {
      const response = await fetch(soundUrl(sound.filename));
      if (!response.ok) throw new Error(`Could not load ${sound.name}.`);
      return [sound.name, await audioContext.decodeAudioData(await response.arrayBuffer())] as const;
    }));
    if (version === configVersion) {
      buffers.clear();
      for (const [name, buffer] of decoded) buffers.set(name, buffer);
    }
  } catch (error) {
    activity.textContent = `Loading failed. Tap Enable sound to retry. ${error instanceof Error ? error.message : ""}`;
  } finally {
    loading = false;
    updateAudio();
    if (version !== configVersion) void loadAudio();
  }
}

async function enableAudio(automatic = false) {
  if (!automatic) activity.textContent = "";
  try {
    if (!context) {
      context = new AudioContext();
      gain = context.createGain();
      gain.gain.value = Number(element<HTMLInputElement>("volume").value) / 100;
      gain.connect(context.destination);
      context.addEventListener("statechange", updateAudio);
    }
    // A blocked startup resume can stay pending until a user gesture. Keep the
    // button usable so a click can call resume again on the same context.
    await context.resume();
    if (!sounds.every(sound => buffers.has(sound.name))) await loadAudio();
    updateAudio();
  } catch {
    if (!automatic) activity.textContent = "Audio unavailable. Tap Enable sound to retry.";
    updateAudio();
  }
}

enable.addEventListener("click", () => void enableAudio());

element<HTMLInputElement>("volume").addEventListener("input", event => {
  const value = Number((event.target as HTMLInputElement).value);
  element("volume-value").textContent = `${value}%`;
  if (gain) gain.gain.value = value / 100;
});

function renderSounds() {
  const container = element("sounds");
  container.replaceChildren();
  for (const sound of sounds) {
    const button = document.createElement("button");
    button.className = "sound";
    button.disabled = socket?.readyState !== WebSocket.OPEN;
    button.setAttribute("aria-label", `Play ${sound.name}`);
    button.textContent = sound.name;
    button.addEventListener("click", () => {
      if (send({ type: "play", name: sound.name })) activity.textContent = `Sending ${sound.name}…`;
      else activity.textContent = "Disconnected.";
    });
    container.append(button);
  }
}

function handleMessage(message: ServerMessage) {
  switch (message.type) {
    case "config": {
      sounds = message.sounds;
      configLoaded = true;
      const version = JSON.stringify(sounds);
      if (version !== configVersion) {
        configVersion = version;
        buffers.clear();
        if (context) void loadAudio();
      }
      if (isControl) renderSounds();
      else {
        updateAudio();
        if (!autoEnableAttempted) {
          autoEnableAttempted = true;
          void enableAudio(true);
        }
      }
      break;
    }
    case "presence":
      element("device-count").textContent = `${message.ready} of ${message.connected} devices ready`;
      break;
    case "play": {
      if (isControl) break;
      const buffer = buffers.get(message.name);
      if (!isReady() || !buffer || !context || !gain) {
        activity.textContent = "Enable sound to listen.";
        updateAudio();
        break;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.addEventListener("ended", () => source.disconnect(), { once: true });
      source.start();
      activity.textContent = `Played: ${message.name}`;
      break;
    }
    case "sent":
      activity.textContent = message.ready
        ? `Sent: ${message.name}`
        : "No devices ready.";
      break;
    case "error":
      activity.textContent = message.message;
      break;
  }
}

function connect() {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", isControl ? "control" : "listener");
  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    element("connection").textContent = "Connected";
  });
  socket.addEventListener("message", event => {
    try { handleMessage(JSON.parse(event.data) as ServerMessage); }
    catch { activity.textContent = "An unexpected event was received."; }
  });
  socket.addEventListener("close", () => {
    element("connection").textContent = "Reconnecting…";
    element("device-count").textContent = "Connection unavailable";
    for (const button of document.querySelectorAll<HTMLButtonElement>(".sound")) button.disabled = true;
    setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempt++, 10000));
  });
  socket.addEventListener("error", () => socket.close());
}

connect();
