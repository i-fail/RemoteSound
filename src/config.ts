import { join } from "node:path";
import type { Sound } from "./protocol";

export async function loadSounds(configPath: string, publicDir: string): Promise<Sound[]> {
  const config: unknown = await Bun.file(configPath).json();
  if (!Array.isArray(config) || config.length === 0) {
    throw new Error("sounds.json must be a non-empty array of { name, filename } objects.");
  }
  const names = new Set<string>();
  const sounds: Sound[] = [];
  for (const entry of config) {
    if (!entry || typeof entry.name !== "string" || !entry.name.trim() ||
        typeof entry.filename !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*\.mp3$/i.test(entry.filename)) {
      throw new Error("Each sound needs a name and a simple .mp3 filename (no directories).");
    }
    const name = entry.name.trim();
    if (names.has(name)) throw new Error(`Duplicate sound name: ${name}`);
    names.add(name);
    if (!(await Bun.file(join(publicDir, entry.filename)).exists())) {
      throw new Error(`Missing sound file: public/${entry.filename}`);
    }
    sounds.push({ name, filename: entry.filename });
  }
  return sounds;
}
