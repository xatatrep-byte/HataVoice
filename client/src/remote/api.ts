import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MouseButton } from "./capture";

/** The LiveKit topic of sealed remote-control input. */
export const REMOTE_TOPIC = "hv-rc";

/** What Rust tells the windows about remote control (`remote`). */
export type RemoteEvent =
  | { kind: "asked"; address: string; channel: string; user: string }
  | { kind: "started"; address: string; channel: string; peer: string; host: boolean; keyboard: boolean }
  | { kind: "denied"; address: string; user: string }
  | { kind: "ended"; address: string; peer: string; host: boolean; why: "stopped" | "peer" | "silence" };

/**
 * The LiveKit topic of notes between the two ends of control, outside the sealed input: so far a phone saying whether its
 * accessibility service is on, without which the PC's clicks reach nothing. Only shown, never acted on.
 */
export const REMOTE_NOTE_TOPIC = "hv-rc-note";

export type RemoteNote = { t: "phone-control"; ready: boolean };

export function encodeRemoteNote(note: RemoteNote): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(note));
}

/** A note as it came, or null for anything else. */
export function parseRemoteNote(bytes: Uint8Array): RemoteNote | null {
  if (bytes.length > 256) return null;
  try {
    const word = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (word && typeof word === "object" && (word as RemoteNote).t === "phone-control" && typeof (word as RemoteNote).ready === "boolean") {
      return { t: "phone-control", ready: (word as RemoteNote).ready };
    }
  } catch {
    // Not a note.
  }
  return null;
}

const noteListeners = new Set<(from: string, note: RemoteNote) => void>();

/** Hears notes from the others in the call; returns the stop. */
export function onRemoteNote(listener: (from: string, note: RemoteNote) => void): () => void {
  noteListeners.add(listener);
  return () => noteListeners.delete(listener);
}

/** A note came from `from` (the call hands it here). */
export function heardRemoteNote(from: string, bytes: Uint8Array): void {
  const note = parseRemoteNote(bytes);
  if (note) for (const listener of noteListeners) listener(from, note);
}

export type RemoteSession = { address: string; channel: string; peer: string; host: boolean; keyboard: boolean };

export type ScreenChoice = { index: number; name: string; primary: boolean; x: number; y: number; width: number; height: number };

export type RemoteInput =
  | { t: "move"; x: number; y: number }
  | { t: "button"; b: MouseButton; down: boolean }
  | { t: "wheel"; dx: number; dy: number }
  | { t: "key"; code: string; down: boolean }
  /** Letters as they are, for a phone (it has a field to write into, not a PC's keys). */
  | { t: "text"; s: string }
  | { t: "ping" };

export function onRemote(handler: (event: RemoteEvent) => void): Promise<() => void> {
  return listen<RemoteEvent>("remote", ({ payload }) => handler(payload));
}

export const remoteAsk = (address: string, channel: string, host: string): Promise<void> => invoke("remote_ask", { address, channel, host });

export const remoteAnswer = (address: string, viewer: string, allow: boolean, keyboard: boolean, screen: number | null): Promise<void> =>
  invoke("remote_answer", { address, viewer, allow, keyboard, screen });

export const remoteSeal = (input: RemoteInput, lossy: boolean): Promise<{ to: string; packet: string }> => invoke("remote_seal", { input, lossy });

export const remoteInput = (from: string, packet: string): Promise<void> => invoke("remote_input", { from, packet });

/** A packet checked as `remoteInput` checks it, handed back to be played by a phone's accessibility service. */
export const remoteOpen = (from: string, packet: string): Promise<RemoteInput | null> => invoke("remote_open", { from, packet });

export const remoteStop = (): Promise<void> => invoke("remote_stop");

export const remoteScreens = (): Promise<ScreenChoice[]> => invoke("remote_screens");

/** Bytes as base64url without padding, as Rust reads them. */
export function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const plain = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(plain + "=".repeat((4 - (plain.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
