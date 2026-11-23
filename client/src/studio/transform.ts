/**
 * Moving and stretching a source on the studio's preview the way OBS does it: eight handles round the chosen source
 * (corners keep its shape unless Shift is held, sides stretch one way), edges and middles that stick to the frame's edges
 * and middle lines, and a locked source that stays put. Pure: rectangles in the frame's own pixels.
 */
import type { Rect, StudioSource } from "./layout";

export type Point = { x: number; y: number };
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export type Hold = { id: string; part: "move" | Handle; start: Point; rect: Rect };

export const MIN_SIZE = 32;

/** Where a handle of `rect` is. */
export function handlePoint(rect: Rect, handle: Handle): Point {
  const x = handle.includes("w") ? rect.x : handle.includes("e") ? rect.x + rect.width : rect.x + rect.width / 2;
  const y = handle.includes("n") ? rect.y : handle.includes("s") ? rect.y + rect.height : rect.y + rect.height / 2;
  return { x, y };
}

const inside = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * What a press at `point` takes hold of: a handle of the chosen source (within `reach` frame pixels), or the topmost
 * visible source under the point. A locked source is chosen but not held.
 */
export function holdAt(sources: StudioSource[], selected: string | null, point: Point, reach: number): { id: string; hold: Hold | null } | null {
  const chosen = sources.find((s) => s.id === selected && s.visible);
  if (chosen && !chosen.locked) {
    for (const handle of HANDLES) {
      const h = handlePoint(chosen.rect, handle);
      if (Math.abs(h.x - point.x) <= reach && Math.abs(h.y - point.y) <= reach) return { id: chosen.id, hold: { id: chosen.id, part: handle, start: point, rect: chosen.rect } };
    }
  }
  for (let i = sources.length - 1; i >= 0; i--) {
    const s = sources[i]!;
    if (!s.visible || !inside(s.rect, point)) continue;
    return { id: s.id, hold: s.locked ? null : { id: s.id, part: "move", start: point, rect: s.rect } };
  }
  return null;
}

/** `value` moved to the nearest of `lines` within `snap`; the shift it took (0 when none was near). */
function stick(value: number, lines: number[], snap: number): number {
  let best = 0;
  let distance = snap + 1;
  for (const line of lines) {
    const d = Math.abs(line - value);
    if (d <= snap && d < distance) {
      distance = d;
      best = line - value;
    }
  }
  return best;
}

export type DragOptions = { frame: { width: number; height: number }; snap: number; free: boolean };

/** The rectangle after dragging what `hold` holds to `point`. */
export function dragHold(hold: Hold, point: Point, { frame, snap, free }: DragOptions): Rect {
  const dx = point.x - hold.start.x;
  const dy = point.y - hold.start.y;
  const r = hold.rect;
  const xs = [0, frame.width / 2, frame.width];
  const ys = [0, frame.height / 2, frame.height];
  if (hold.part === "move") {
    let x = r.x + dx;
    let y = r.y + dy;
    // The left edge, the middle or the right edge, whichever is nearest a line of the frame.
    const sx = [stick(x, xs, snap), stick(x + r.width / 2, xs, snap), stick(x + r.width, xs, snap)].filter((v) => v !== 0);
    const sy = [stick(y, ys, snap), stick(y + r.height / 2, ys, snap), stick(y + r.height, ys, snap)].filter((v) => v !== 0);
    if (sx.length) x += sx.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
    if (sy.length) y += sy.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
    return { ...r, x: Math.round(x), y: Math.round(y) };
  }
  const handle = hold.part;
  let left = r.x;
  let top = r.y;
  let right = r.x + r.width;
  let bottom = r.y + r.height;
  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;
  if (handle.includes("w")) left += stick(left, xs, snap);
  if (handle.includes("e")) right += stick(right, xs, snap);
  if (handle.includes("n")) top += stick(top, ys, snap);
  if (handle.includes("s")) bottom += stick(bottom, ys, snap);
  const corner = handle.length === 2;
  if (corner && !free) {
    // The corner keeps the source's shape: the bigger of the two stretches wins, from the opposite corner.
    const aspect = r.width / r.height;
    let width = Math.max(MIN_SIZE, right - left);
    let height = Math.max(MIN_SIZE, bottom - top);
    if (width / height > aspect) height = width / aspect;
    else width = height * aspect;
    if (handle.includes("w")) left = right - width;
    else right = left + width;
    if (handle.includes("n")) top = bottom - height;
    else bottom = top + height;
  }
  // Never smaller than the least, never turned inside out: the edge that moves stops.
  if (right - left < MIN_SIZE) {
    if (handle.includes("w")) left = right - MIN_SIZE;
    else right = left + MIN_SIZE;
  }
  if (bottom - top < MIN_SIZE) {
    if (handle.includes("n")) top = bottom - MIN_SIZE;
    else bottom = top + MIN_SIZE;
  }
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

/** A source moved by the arrow keys: a pixel, or ten with Shift. */
export function nudge(rect: Rect, key: string, big: boolean): Rect | null {
  const step = big ? 10 : 1;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
  return d ? { ...rect, x: rect.x + d[0]!, y: rect.y + d[1]! } : null;
}

/** The source in the middle of the frame, its size kept. */
export function centered(rect: Rect, frame: { width: number; height: number }): Rect {
  return { ...rect, x: Math.round((frame.width - rect.width) / 2), y: Math.round((frame.height - rect.height) / 2) };
}
