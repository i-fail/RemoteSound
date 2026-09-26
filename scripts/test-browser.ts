import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

const sounds: { name: string; filename: string }[] = JSON.parse(await readFile(new URL("../sounds.json", import.meta.url), "utf8"));
const firstSound = sounds[0].name;

async function startServer(port = 0) {
  const process = spawn("bun", ["src/server.ts"], {
    env: { ...globalThis.process.env, PORT: String(port), HOST: "::" },
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { process.kill(); reject(new Error("Server startup timed out")); }, 15000);
    let output = "";
    process.stdout.on("data", chunk => {
      output += String(chunk);
      const match = output.match(/Listener: (http:\/\/localhost:\d+)\//);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    process.once("error", error => { clearTimeout(timeout); reject(error); });
    process.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
  return {
    base,
    async stop() {
      if (process.exitCode !== null || process.signalCode !== null) return;
      const exited = once(process, "exit");
      process.kill();
      await exited;
    },
  };
}

let server = await startServer();
const base = server.base;
const port = Number(new URL(base).port);
console.log(`Checking browser flow at ${base}`);
const browser = await chromium.launch({ headless: true, timeout: 15000, args: ["--autoplay-policy=document-user-activation-required"] }).catch(async error => { await server.stop(); throw error; });
const errors: string[] = [];
async function waitForText(page: Page, selector: string, text: string) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text), { selector, text });
}

try {
  const listener = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const control = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const page of [listener, control]) {
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
  }
  await listener.addInitScript(() => {
    (window as any).__playedSounds = 0;
    (window as any).__resumeAttempts = 0;
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      (window as any).__resumeAttempts++;
      return resume.call(this);
    };
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      (window as any).__playedSounds++;
      return original.apply(this, args);
    };
  });
  await listener.goto(base);
  // The listener must connect before any control page opens or audio is enabled.
  await waitForText(listener, "#connection", "Connected");
  await listener.waitForFunction(() => !(document.querySelector("#enable") as HTMLButtonElement).disabled);
  await listener.waitForFunction(() => (window as any).__resumeAttempts === 1);
  assert.equal(await listener.locator("#connection").textContent(), "Connected");
  console.log("Listener connected independently, before opening Control.");

  // A successful handshake alone is sufficient; no config/presence event is needed.
  const handshakeOnly = await browser.newPage();
  handshakeOnly.setDefaultTimeout(5000);
  handshakeOnly.on("pageerror", error => errors.push(error.message));
  await handshakeOnly.routeWebSocket("**/ws?role=listener", () => {});
  await handshakeOnly.goto(base);
  await waitForText(handshakeOnly, "#connection", "Connected");
  assert.equal(await handshakeOnly.locator("#enable").isDisabled(), true);
  await handshakeOnly.close();
  console.log("Connected status appears on WebSocket open without server messages.");

  await control.goto(`${base}/control`);
  console.log("Both pages loaded.");
  await waitForText(control, "#device-count", "0 of 1 devices ready");
  assert.equal(await control.locator(".sound").count(), sounds.length);

  // Events before the required user gesture are received but not played.
  await control.getByRole("button", { name: `Play ${firstSound}`, exact: true }).click();
  await waitForText(listener, "#activity", "Enable sound to listen");
  assert.equal(await listener.evaluate(() => (window as any).__playedSounds), 0);

  await listener.getByRole("button", { name: "Enable sound" }).click();
  await waitForText(listener, "#enable", "Sound enabled");
  await waitForText(control, "#device-count", "1 of 1 devices ready");
  console.log("Listener decoded all MP3s and enabled audio.");
  for (const { name } of sounds) {
    await control.getByRole("button", { name: `Play ${name}`, exact: true }).click();
    await waitForText(listener, "#activity", `Played: ${name}`);
    await waitForText(control, "#activity", `Sent: ${name}`);
  }
  assert.equal(await listener.evaluate(() => (window as any).__playedSounds), sounds.length);
  assert.equal(await listener.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await listener.screenshot({ path: "test-results/listener-mobile.png", fullPage: true });
  await control.screenshot({ path: "test-results/control-desktop.png", fullPage: true });

  // The audio context remains unlocked after the server and sockets reconnect.
  await server.stop();
  await waitForText(control, "#connection", "Reconnecting");
  assert.equal(await control.locator(".sound:disabled").count(), sounds.length);
  server = await startServer(port);
  await waitForText(control, "#device-count", "1 of 1 devices ready");
  await control.getByRole("button", { name: `Play ${firstSound}`, exact: true }).click();
  await listener.waitForFunction(expected => (window as any).__playedSounds === expected, sounds.length + 1);
  await control.close();
  await waitForText(listener, "#device-count", "1 of 1 devices ready");
  assert.equal(await listener.locator("#connection").textContent(), "Connected");
  await listener.close();

  // When autoplay is allowed, the listener loads audio and plays without a click.
  const autoplayBrowser = await chromium.launch({ headless: true, timeout: 15000, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const autoListener = await autoplayBrowser.newPage();
    const autoControl = await autoplayBrowser.newPage();
    for (const page of [autoListener, autoControl]) {
      page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
    }
    await autoListener.goto(base);
    await waitForText(autoListener, "#connection", "Connected");
    await waitForText(autoListener, "#enable", "Sound enabled");
    await autoControl.goto(`${base}/control`);
    await waitForText(autoControl, "#device-count", "1 of 1 devices ready");
    await autoControl.getByRole("button", { name: `Play ${firstSound}`, exact: true }).click();
    await waitForText(autoListener, "#activity", `Played: ${firstSound}`);
    console.log("Autoplay enabled audio and played a sound without a listener click.");
  } finally {
    await autoplayBrowser.close();
  }
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: automatic audio enablement, blocked-autoplay button fallback, MP3 playback, mobile layout, and reconnection.");
} finally {
  await browser.close();
  await server.stop();
}
