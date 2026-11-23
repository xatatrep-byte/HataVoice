import { useEffect, useRef } from "react";
import { readStageWalks } from "./stageWalks";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { SceneAct, SceneMember } from "./scene";

/** The window of the characters on the desktop (its label in Rust). */
export const OVERLAY_LABEL = "overlay";
/** What the main window sends it, a few times a second while it is shown. */
export const OVERLAY_EVENT = "overlay-state";
/** What it tells the main window while the characters are being put in their places. */
export const OVERLAY_PLACED = "overlay-placed";
export const OVERLAY_SIZE = "overlay-size";
export const OVERLAY_DONE = "overlay-done";
/** An act chosen in a character's menu on the desktop: the main window does it, as a click on the call's stage would. */
export const OVERLAY_ACT = "overlay-act";
/** How smoothly the desktop window really draws, now and then: shown in the settings («Персонаж»). */
export const OVERLAY_FPS = "overlay-fps";
/** How often the desktop window tells it. */
export const OVERLAY_FPS_MS = 10_000;

/** The desktop window's last word on how it draws: frames a second, whether Windows has it hidden, when it said so. */
export type OverlayHealth = { fps: number | null; hidden: boolean; at: number };
export const useOverlayHealth = create<OverlayHealth>(() => ({ fps: null, hidden: false, at: 0 }));

/** A frames-per-second word as it came from the desktop window, or null for anything else. */
export function readOverlayFps(payload: unknown): { fps: number; hidden: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const { fps, hidden } = payload as { fps?: unknown; hidden?: unknown };
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps < 0 || fps > 1000 || typeof hidden !== "boolean") return null;
  return { fps: Math.round(fps), hidden };
}

/** Where a character stands on the screen: its feet, as parts of the screen's width and height (0–1). */
export type Spot = [number, number];

/** How tall a character is, as a part of the screen's height. */
export const DEFAULT_SIZE = 0.26;
export const MIN_SIZE = 0.12;
export const MAX_SIZE = 0.6;

/** An act as sent: how long ago it began, since the two windows' clocks differ. */
export type SentAct = { key: number; user: string; act: string; to: string | null; age: number };
/** `walks`: where each one walks on the call's stage (see `stageWalks`), for the desktop to walk the same. */
export type OverlayState = { members: SceneMember[]; acts: SentAct[]; arranging: boolean; spots: Record<string, Spot>; size: number; walks?: Record<string, [number, number]> };

const FEED_MS = 100;

/** Shows the call's characters on the desktop, or closes them. */
export function showOverlay(show: boolean): Promise<void> {
  return invoke("overlay_show", { show });
}

/** Lets the mouse drag the characters to their places, or go through them again. */
export function arrangeOverlay(on: boolean): Promise<void> {
  return invoke("overlay_arrange", { on });
}

/** Where the mouse is over the characters' window, in its page's pixels; null when it is elsewhere. */
export function overlayCursor(): Promise<[number, number] | null> {
  return invoke<[number, number] | null>("overlay_cursor");
}

/** The characters' window takes the mouse (a character or its menu is under it), or lets it go through again. */
export function takeMouse(on: boolean): Promise<void> {
  return invoke("overlay_arrange", { on });
}

/** An act's name as one goes between the windows: a word of small Latin letters, as the server's group carries them. */
const ACT_WORD = /^[a-z]{1,24}$/;

/** A size that is one: within the bounds, or the usual one. */
export function clampSize(size: unknown): number {
  return typeof size === "number" && Number.isFinite(size) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, size)) : DEFAULT_SIZE;
}

/** A place on the screen where the whole character shows: feet inside, head under the top edge. */
export function clampSpot([x, y]: Spot, size: number): Spot {
  const top = Math.min(1, size + 0.01);
  return [Math.min(0.98, Math.max(0.02, x)), Math.min(1, Math.max(top, y))];
}

/** Each one where they were put; those never put anywhere stand in a row from the bottom right corner. */
export function spotsFor(ids: string[], saved: Record<string, Spot>, size: number): Record<string, Spot> {
  const spots: Record<string, Spot> = {};
  const step = size * 0.34;
  let free = 0;
  for (const id of ids) {
    const spot = saved[id];
    spots[id] = clampSpot(spot ?? [0.95 - free * step, 1], size);
    if (!spot) free++;
  }
  return spots;
}

/** The acts as the overlay takes them: begun `age` ms before now on its clock. */
export function actsFrom(sent: SentAct[], now: number): SceneAct[] {
  return sent.map(({ age, ...act }) => ({ ...act, startedAt: now - age }));
}

type Answers = {
  /** A character was put somewhere; null: back to the row. */
  onPlaced: (id: string, spot: Spot | null) => void;
  onSize: (size: number) => void;
  onDone: () => void;
  /** An act was chosen on the desktop: ours alone, or with someone (`to`). */
  onAct?: (act: string, to: string | null) => void;
};

/**
 * While `on`, the characters' window is shown and told who is in the call, what they do and where each stands, ten
 * times a second (the voice moves their mouths). It answers where they were put. Off, or when the call ends, it closes.
 */
export function useOverlayFeed(
  on: boolean,
  arranging: boolean,
  members: SceneMember[],
  acts: SceneAct[],
  spots: Record<string, Spot>,
  size: number,
  answers?: Answers,
) {
  const latest = useRef({ arranging, members, acts, spots, size, answers });
  latest.current = { arranging, members, acts, spots, size, answers };

  useEffect(() => {
    if (!on || !isTauri()) return;
    void showOverlay(true).catch(() => {});
    const timer = setInterval(() => {
      const now = performance.now();
      const { arranging, members, acts, spots, size } = latest.current;
      const state: OverlayState = {
        members,
        acts: acts.map(({ startedAt, ...act }) => ({ ...act, age: now - startedAt })),
        arranging,
        spots,
        size,
        walks: readStageWalks(),
      };
      void emitTo(OVERLAY_LABEL, OVERLAY_EVENT, state).catch(() => {});
    }, FEED_MS);
    const stops: (() => void)[] = [];
    let disposed = false;
    const hear = <T,>(event: string, take: (payload: T) => void) =>
      void listen<T>(event, ({ payload }) => take(payload))
        .then((stop) => (disposed ? stop() : stops.push(stop)))
        .catch(() => {});
    hear<{ id: string; spot: Spot | null }>(OVERLAY_PLACED, ({ id, spot }) => {
      const real = Array.isArray(spot) && spot.length === 2 && spot.every((n) => typeof n === "number" && n >= 0 && n <= 1);
      if (typeof id === "string") latest.current.answers?.onPlaced(id, real ? spot : null);
    });
    hear<{ size: number }>(OVERLAY_SIZE, ({ size }) => latest.current.answers?.onSize(clampSize(size)));
    hear<unknown>(OVERLAY_DONE, () => latest.current.answers?.onDone());
    hear<unknown>(OVERLAY_FPS, (payload) => {
      const word = readOverlayFps(payload);
      if (word) useOverlayHealth.setState({ ...word, at: Date.now() });
    });
    hear<{ act: unknown; to: unknown }>(OVERLAY_ACT, ({ act, to }) => {
      if (typeof act !== "string" || !ACT_WORD.test(act)) return;
      if (to !== null && (typeof to !== "string" || to.length > 200)) return;
      latest.current.answers?.onAct?.(act, to);
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      stops.forEach((stop) => stop());
      void showOverlay(false).catch(() => {});
    };
  }, [on]);
}
