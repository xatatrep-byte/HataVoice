/**
 * Keeping characters out of each other. Each has a radius (half its body's width or depth, measured from the model), and
 * nobody stands closer to anyone than the two radii: a spot a character is sent to moves to the nearest free one, those
 * who drift together are pushed apart, and on the desktop a row is spread so that no two overlap.
 */
import type { BodyProfile } from "./clearance";

/** Whoever has nothing measured. */
export const DEFAULT_RADIUS = 0.28;
const MIN_RADIUS = 0.18;
const MAX_RADIUS = 0.62;
/** Air between two who stand side by side. */
export const GAP = 0.08;

/** How far a body (arms and head left out) reaches from its middle, sideways or front to back. */
export function bodyRadius(profile: BodyProfile | null): number {
  if (!profile) return DEFAULT_RADIUS;
  let side = 0;
  for (let i = 0; i < profile.left.length; i++) {
    const l = profile.left[i]!;
    const r = profile.right[i]!;
    if (Number.isFinite(l)) side = Math.max(side, l);
    if (Number.isFinite(r)) side = Math.max(side, r);
  }
  // Depth: the rows of cells with any body in them.
  let first = -1;
  let last = -1;
  for (let z = 0; z < profile.nz; z++) {
    let any = false;
    for (let y = 0; y < profile.ny && !any; y++) {
      const k = y * profile.nz + z;
      any = Number.isFinite(profile.left[k]!) || Number.isFinite(profile.right[k]!);
    }
    if (any) {
      if (first < 0) first = z;
      last = z;
    }
  }
  const depth = first < 0 ? 0 : ((last - first + 1) * profile.step) / 2;
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.max(side, depth) + ARMS));
}

/** The arms hang beside the body the profile leaves them out of: room for them too. */
const ARMS = 0.06;

export type Disc = { x: number; z: number; r: number };
export type Floor = { x: number; back: number; front: number };

const clampTo = (floor: Floor, x: number, z: number) => ({
  x: Math.max(-floor.x, Math.min(floor.x, x)),
  z: Math.max(floor.back, Math.min(floor.front, z)),
});

const fits = (x: number, z: number, r: number, others: Disc[]) => others.every((o) => Math.hypot(o.x - x, o.z - z) >= o.r + r + GAP - 1e-6);

/** The nearest spot to (x, z) on the floor where a body of radius `r` touches nobody in `others`. */
export function freeSpot(x: number, z: number, r: number, others: Disc[], floor: Floor): { x: number; z: number } {
  const wanted = clampTo(floor, x, z);
  if (fits(wanted.x, wanted.z, r, others)) return wanted;
  const step = 0.12;
  for (let ring = 1; ring <= 30; ring++) {
    const radius = ring * step;
    const count = 8 + ring * 4;
    let best: { x: number; z: number; d: number } | null = null;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2;
      const at = clampTo(floor, wanted.x + Math.sin(a) * radius, wanted.z + Math.cos(a) * radius);
      if (!fits(at.x, at.z, r, others)) continue;
      const d = Math.hypot(at.x - wanted.x, at.z - wanted.z);
      if (!best || d < best.d) best = { ...at, d };
    }
    if (best) return { x: best.x, z: best.z };
  }
  return wanted;
}

/**
 * One step of pushing apart those who overlap, `rate` (0–1) of the overlap at a time, each moving half. `apart(i, j)`
 * says whether a pair is to be kept apart at all (two who hug are not). Moves the discs in place.
 */
export function separate(discs: Disc[], rate: number, apart: (i: number, j: number) => boolean = () => true) {
  for (let i = 0; i < discs.length; i++) {
    for (let j = i + 1; j < discs.length; j++) {
      if (!apart(i, j)) continue;
      const a = discs[i]!;
      const b = discs[j]!;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let d = Math.hypot(dx, dz);
      const need = a.r + b.r;
      if (d >= need) continue;
      const push = ((need - d) * rate) / 2;
      if (d < 1e-4) {
        // Exactly on top of each other: apart sideways, by their order.
        dx = 1;
        dz = 0;
        d = 1;
      }
      a.x -= (dx / d) * push;
      a.z -= (dz / d) * push;
      b.x += (dx / d) * push;
      b.z += (dz / d) * push;
    }
  }
}

export type DeskItem = { id: string; x: number; y: number; r: number };

/**
 * The desktop: who stands on about the same line (feet within `sameLine` of each other) is spread so that neighbours do
 * not overlap, as little as possible from where they were put, and kept within [left, right]. Returns x by id.
 */
export function spreadOnDesk(items: DeskItem[], left: number, right: number, sameLine: number): Map<string, number> {
  const result = new Map<string, number>(items.map((i) => [i.id, i.x]));
  const lines: DeskItem[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id))) {
    const line = lines.find((l) => Math.abs(l[0]!.y - item.y) < sameLine);
    if (line) line.push(item);
    else lines.push([item]);
  }
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
    const xs = line.map((i) => i.x);
    // Left to right, each at least two radii from the one before.
    const pushRight = () => {
      for (let k = 1; k < line.length; k++) {
        const min = xs[k - 1]! + line[k - 1]!.r + line[k]!.r + GAP;
        if (xs[k]! < min) xs[k] = min;
      }
    };
    pushRight();
    // A run of those now shoulder to shoulder stands centred on where they were put, not all to one side of it.
    let start = 0;
    for (let k = 1; k <= line.length; k++) {
      const touching = k < line.length && Math.abs(xs[k]! - (xs[k - 1]! + line[k - 1]!.r + line[k]!.r + GAP)) < 1e-9;
      if (touching) continue;
      if (k - start > 1) {
        let wanted = 0;
        let now = 0;
        for (let i = start; i < k; i++) {
          wanted += line[i]!.x;
          now += xs[i]!;
        }
        const shift = (wanted - now) / (k - start);
        for (let i = start; i < k; i++) xs[i] = xs[i]! + shift;
      }
      start = k;
    }
    pushRight();
    // Over the right edge: the whole row slides back, then is held at the left edge.
    const overRight = xs[xs.length - 1]! + line[line.length - 1]!.r - right;
    if (overRight > 0) for (let k = 0; k < xs.length; k++) xs[k] = xs[k]! - overRight;
    for (let k = 0; k < line.length; k++) {
      const min = k === 0 ? left + line[0]!.r : xs[k - 1]! + line[k - 1]!.r + line[k]!.r + GAP;
      if (xs[k]! < min) xs[k] = min;
    }
    // A row wider than the screen squeezes in as evenly as it can.
    const width = right - left;
    const total = line.reduce((s, i) => s + 2 * i.r, 0) + GAP * (line.length - 1);
    if (total > width && line.length > 1) {
      const step = (width - 2 * line[0]!.r) / (line.length - 1);
      for (let k = 0; k < line.length; k++) xs[k] = left + line[0]!.r + k * step;
    }
    line.forEach((item, k) => result.set(item.id, xs[k]!));
  }
  return result;
}

/**
 * Where a character on the desktop strolls to: some steps to one side or the other of where it was put, along the line
 * it stands on (the screen's bottom, a window's edge), never off the screen. `chance` (0–1) picks the way and how far.
 */
export function deskStroll(home: number, chance: number, width: number, reach: number, margin: number): number {
  const x = home + (chance - 0.5) * 2 * reach;
  return Math.max(margin, Math.min(width - margin, x));
}

/**
 * On the desktop the window's own frames may come rarely: Windows and WebView2 hold back a see-through window that sits
 * over everything and lets the mouse through. Frames that do come move the walkers by all the time that passed (a stroll
 * of two heights takes about three seconds), so a window drawing once in a while still has them where they should be.
 */
export const DESK_MAX_STEP_S = 4;

/** A step on the call's stage is this many steps on the desktop (the screen is wider than the stage's floor). */
export const DESK_WALK_SCALE = 2.5;

/** Where a figure put at `home` on the desktop heads when on the call's stage it heads `dx` metres from its place. */
export function deskWalkTarget(home: number, dx: number, width: number, margin: number): number {
  return Math.max(margin, Math.min(width - margin, home + dx * DESK_WALK_SCALE));
}

/** Strolls follow the wall clock: one begins in each stretch of this many ms… */
export const STROLL_SLOT_MS = 30_000;
/** …at a moment up to this far into it, picked by the person and the stretch. */
const STROLL_START_MS = 20_000;

/** A number in [0, 1) from three whole numbers: the same in every window and on every PC. */
function hash01(a: number, b: number, salt: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(salt, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The stroll someone is on: which one (it changes when a new one begins), the side it goes (0 left … 1 right), and how far back or forth on a floor. */
export type Stroll = { slot: number; chance: number; depth: number };

/**
 * The stroll a person with `seed` is on at `wallMs` (ms since 1970). It depends on nothing else, so the call's stage
 * and the characters on the desktop, opened at different times and drawing at different rates, take each stroll at the
 * same moment and to the same side.
 */
export function strollPlan(seed: number, wallMs: number): Stroll {
  const key = Math.round(seed * 1000);
  let slot = Math.floor(wallMs / STROLL_SLOT_MS);
  if (wallMs < slot * STROLL_SLOT_MS + hash01(key, slot, 1) * STROLL_START_MS) slot -= 1;
  return { slot, chance: hash01(key, slot, 2), depth: hash01(key, slot, 3) };
}

/** A frame's time (`frameTime`, ms from the window's own start) on the wall clock: the same moment in every window. */
export function wallTime(timeOrigin: number, frameTime: number): number {
  return timeOrigin + frameTime;
}

/** A frame's step in seconds: the time since the last frame, at most `max` (a first frame counts as a sixtieth). */
export function frameStep(elapsedMs: number, max: number): number {
  return Math.max(0, Math.min(max, elapsedMs / 1000 || 0.016));
}
