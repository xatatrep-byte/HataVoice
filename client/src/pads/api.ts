import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PadState } from "./state";

/** The LiveKit topic of sealed pad states. */
export const PAD_TOPIC = "hv-pad";

/** Where the owner of a PC gets the driver for pads (the app never installs it). */
export const DRIVER_PAGE = "https://github.com/nefarius/ViGEmBus/releases/tag/v1.22.0";

/** What Rust tells the windows about playing together (`pads`). */
export type PadEvent =
  | { kind: "asked"; address: string; channel: string; user: string }
  | { kind: "no-driver"; address: string; user: string }
  | { kind: "started"; address: string; channel: string; peer: string; host: boolean; player: number }
  | { kind: "refused"; address: string; user: string; why: "denied" | "full" | "no-driver" | "failed" }
  | { kind: "ended"; address: string; channel: string; peer: string; host: boolean; why: "stopped" | "peer" | "silence" | "failed" };

export type PlayView = { address: string; channel: string; peer: string; player: number };
export type PadsView = { playing: PlayView | null; guests: PlayView[] };

export function onPads(handler: (event: PadEvent) => void): Promise<() => void> {
  return listen<PadEvent>("pads", ({ payload }) => handler(payload));
}

export const padAsk = (address: string, channel: string, host: string): Promise<void> => invoke("pad_ask", { address, channel, host });
export const padAnswer = (address: string, guest: string, allow: boolean): Promise<void> => invoke("pad_answer", { address, guest, allow });
export const padSeal = (state: PadState): Promise<{ to: string; packet: string }> => invoke("pad_seal", { state });
export const padInput = (from: string, packet: string): Promise<void> => invoke("pad_input", { from, packet });
export const padKick = (address: string, guest: string): Promise<void> => invoke("pad_kick", { address, guest });
export const padStopAll = (): Promise<void> => invoke("pad_stop_all");
export const padRelease = (): Promise<void> => invoke("pad_release");
export const padState = (): Promise<PadsView> => invoke("pad_state");
