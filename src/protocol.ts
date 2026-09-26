export type Sound = { name: string; filename: string };
export type ClientMessage =
  | { type: "play"; name: string }
  | { type: "ready"; ready: boolean };
export type ServerMessage =
  | { type: "config"; sounds: Sound[] }
  | { type: "presence"; connected: number; ready: number }
  | { type: "play"; name: string; eventId: string }
  | { type: "sent"; name: string; ready: number }
  | { type: "error"; message: string };

export function soundUrl(filename: string): string {
  return `/public/${encodeURIComponent(filename)}`;
}
