/**
 * The call's drawing board: what is on it, who may draw, and the ops that change it. Pure: every one in the call applies
 * the same ops in the same order (the call's channel keeps them in order) and gets the same board. Each one checks the
 * rights itself, so a stroke of someone not allowed is drawn by nobody.
 *
 * The board is 1600 × 900 (its own units, any screen shows it whole); points are whole numbers, x then y.
 */

export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 900;

/** A pen, a see-through marker, or an eraser that rubs out what is under it (drawn as a stroke of its own). */
export type Tool = "pen" | "marker" | "eraser";
export type ShapeTool = "line" | "arrow" | "rect" | "ellipse";
export type Point = [number, number];

export type Stroke =
  | { kind: "path"; id: string; by: string; tool: Tool; color: string; size: number; pts: number[] }
  | { kind: "shape"; id: string; by: string; tool: ShapeTool; color: string; size: number; a: Point; b: Point }
  | { kind: "text"; id: string; by: string; color: string; size: number; at: Point; text: string };

export type Board = {
  /** Who opened it; null: no board in this call. */
  owner: string | null;
  /** Everyone may draw, or only the owner and `allowed`. */
  everyone: boolean;
  allowed: string[];
  strokes: Stroke[];
};

/** The whole board as it goes to one who comes later. */
export type Snapshot = { owner: string; everyone: boolean; allowed: string[]; strokes: Stroke[] };

export type Op =
  | { t: "open"; owner: string }
  | { t: "close" }
  | { t: "perm"; everyone: boolean; allowed: string[] }
  | { t: "hello" }
  | { t: "snap"; board: Snapshot }
  | { t: "s"; id: string; tool: Tool; color: string; size: number; pts: number[] }
  | { t: "p"; id: string; pts: number[] }
  | { t: "shape"; id: string; tool: ShapeTool; color: string; size: number; a: Point; b: Point }
  | { t: "text"; id: string; color: string; size: number; at: Point; text: string }
  | { t: "x"; ids: string[] }
  | { t: "clear" }
  | { t: "laser"; at: Point };

/** One packet of ops from one sender: `n` grows with every packet (an old one played again is dropped). */
export type Packet = { n: number; ops: Op[] };

export const emptyBoard = (): Board => ({ owner: null, everyone: false, allowed: [], strokes: [] });

/** Whether `user` may draw on `board`. */
export function canDraw(board: Board, user: string): boolean {
  return board.owner !== null && (board.owner === user || board.everyone || board.allowed.includes(user));
}

/** What `from` sent, applied in order: ops one has no right to are skipped. */
export function applyOps(board: Board, from: string, ops: Op[]): Board {
  let next = board;
  for (const op of ops) next = applyOne(next, from, op);
  return next;
}

function applyOne(board: Board, from: string, op: Op): Board {
  const owner = board.owner === from;
  switch (op.t) {
    case "open":
      // A board is opened where none is, or anew by its owner (back after a restart): nobody takes another's over.
      return (board.owner === null || owner) && op.owner === from ? { owner: from, everyone: false, allowed: [], strokes: [] } : board;
    case "close":
      return owner ? emptyBoard() : board;
    case "perm":
      return owner ? { ...board, everyone: op.everyone, allowed: op.allowed.filter((u) => u !== from) } : board;
    case "snap":
      // The board as its owner has it, for one who came later (or the owner's own when nothing is open here yet).
      if (op.board.owner !== from) return board;
      if (board.owner !== null && board.owner !== from) return board;
      return { owner: from, everyone: op.board.everyone, allowed: op.board.allowed, strokes: op.board.strokes };
    case "hello":
    case "laser":
      return board;
    case "clear":
      return owner ? { ...board, strokes: [] } : board;
    case "x": {
      const ids = new Set(op.ids);
      return { ...board, strokes: board.strokes.filter((s) => !ids.has(s.id) || !(owner || s.by === from)) };
    }
    default:
      break;
  }
  if (!canDraw(board, from)) return board;
  // A stroke's id starts with whose it is: nobody adds to another's.
  if (!op.id.startsWith(`${from}:`)) return board;
  switch (op.t) {
    case "s":
      if (board.strokes.some((s) => s.id === op.id)) return board;
      return { ...board, strokes: [...board.strokes, { kind: "path", id: op.id, by: from, tool: op.tool, color: op.color, size: op.size, pts: op.pts }] };
    case "p":
      return {
        ...board,
        strokes: board.strokes.map((s) => (s.id === op.id && s.kind === "path" ? { ...s, pts: [...s.pts, ...op.pts].slice(0, MAX_POINTS * 2) } : s)),
      };
    case "shape":
      if (board.strokes.some((s) => s.id === op.id)) return board;
      return { ...board, strokes: [...board.strokes, { kind: "shape", id: op.id, by: from, tool: op.tool, color: op.color, size: op.size, a: op.a, b: op.b }] };
    case "text":
      if (board.strokes.some((s) => s.id === op.id)) return board;
      return { ...board, strokes: [...board.strokes, { kind: "text", id: op.id, by: from, color: op.color, size: op.size, at: op.at, text: op.text }] };
  }
}

/** The strokes of a board there is room for, and their points. */
const MAX_STROKES = 5000;
const MAX_POINTS = 4000;

export function snapshotOf(board: Board): Snapshot {
  return { owner: board.owner ?? "", everyone: board.everyone, allowed: board.allowed, strokes: board.strokes };
}

// ---- Erasing.

function distanceToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** A rubbing of the eraser: it is seen only by what it rubs out, so it is never picked up as a stroke. */
const isRubbing = (s: Stroke) => s.kind === "path" && s.tool === "eraser";

/** The topmost stroke within `reach` of (x, y): what the eraser takes. */
export function strokeAt(board: Board, x: number, y: number, reach: number): Stroke | null {
  for (let i = board.strokes.length - 1; i >= 0; i--) {
    const s = board.strokes[i]!;
    if (isRubbing(s)) continue;
    const near = reach + s.size / 2;
    if (s.kind === "path") {
      if (s.pts.length === 2 && Math.hypot(x - s.pts[0]!, y - s.pts[1]!) <= near) return s;
      for (let k = 2; k < s.pts.length; k += 2) {
        if (distanceToSegment(x, y, s.pts[k - 2]!, s.pts[k - 1]!, s.pts[k]!, s.pts[k + 1]!) <= near) return s;
      }
    } else if (s.kind === "shape") {
      const [ax, ay] = s.a;
      const [bx, by] = s.b;
      if (s.tool === "line" || s.tool === "arrow") {
        if (distanceToSegment(x, y, ax, ay, bx, by) <= near) return s;
      } else if (s.tool === "rect") {
        const edges: [number, number, number, number][] = [
          [ax, ay, bx, ay],
          [bx, ay, bx, by],
          [bx, by, ax, by],
          [ax, by, ax, ay],
        ];
        if (edges.some(([x1, y1, x2, y2]) => distanceToSegment(x, y, x1, y1, x2, y2) <= near)) return s;
      } else {
        const cx = (ax + bx) / 2;
        const cy = (ay + by) / 2;
        const rx = Math.max(1, Math.abs(bx - ax) / 2);
        const ry = Math.max(1, Math.abs(by - ay) / 2);
        const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
        if (Math.abs(d - 1) * Math.min(rx, ry) <= near) return s;
      }
    } else {
      const width = s.text.length * s.size * 0.6;
      if (x >= s.at[0] - reach && x <= s.at[0] + width + reach && y >= s.at[1] - s.size - reach && y <= s.at[1] + reach) return s;
    }
  }
  return null;
}

/** Whether the segment (a, b) touches the box (x0, y0)–(x1, y1): clipped to it (Liang–Barsky), something is left. */
function segmentInBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let from = 0;
  let to = 1;
  const sides: [number, number][] = [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) from = Math.max(from, r);
    else to = Math.min(to, r);
    if (from > to) return false;
  }
  return true;
}

/** The outline of a stroke as segments [ax, ay, bx, by] (an ellipse in 48 of them); a text is its box, crossed. */
function outline(s: Stroke): [number, number, number, number][] {
  if (s.kind === "path") {
    if (s.pts.length === 2) return [[s.pts[0]!, s.pts[1]!, s.pts[0]!, s.pts[1]!]];
    const out: [number, number, number, number][] = [];
    for (let k = 2; k < s.pts.length; k += 2) out.push([s.pts[k - 2]!, s.pts[k - 1]!, s.pts[k]!, s.pts[k + 1]!]);
    return out;
  }
  if (s.kind === "text") {
    const lines = s.text.split("\n");
    const width = Math.max(...lines.map((line) => line.length)) * s.size * 0.6;
    const [x, y] = s.at;
    const top = y - s.size;
    const bottom = y + (lines.length - 1) * s.size * 1.2 + s.size * 0.25;
    return [
      [x, top, x + width, top],
      [x + width, top, x + width, bottom],
      [x + width, bottom, x, bottom],
      [x, bottom, x, top],
      [x, top, x + width, bottom],
    ];
  }
  const [ax, ay] = s.a;
  const [bx, by] = s.b;
  if (s.tool === "line" || s.tool === "arrow") return [[ax, ay, bx, by]];
  if (s.tool === "rect") {
    return [
      [ax, ay, bx, ay],
      [bx, ay, bx, by],
      [bx, by, ax, by],
      [ax, by, ax, ay],
    ];
  }
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const rx = Math.abs(bx - ax) / 2;
  const ry = Math.abs(by - ay) / 2;
  const at = (k: number): [number, number] => [cx + rx * Math.cos((k / 48) * Math.PI * 2), cy + ry * Math.sin((k / 48) * Math.PI * 2)];
  return Array.from({ length: 48 }, (_, k) => [...at(k), ...at(k + 1)] as [number, number, number, number]);
}

/** Every stroke a drawn-out area touches (its line, not what it holds inside): what «стереть область» takes. */
export function strokesIn(board: Board, a: Point, b: Point): Stroke[] {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  return board.strokes.filter((s) => !isRubbing(s) && outline(s).some(([ax, ay, bx, by]) => segmentInBox(ax, ay, bx, by, x0, y0, x1, y1)));
}

// ---- Pieces of a snapshot, small enough for the call's channel.

export type Chunk = { t: "chunk"; id: string; part: number; of: number; data: string };
const CHUNK_TEXT = 11_000;

export function chunkSnapshot(snapshot: Snapshot, id: string): Chunk[] {
  const text = JSON.stringify(snapshot);
  const of = Math.max(1, Math.ceil(text.length / CHUNK_TEXT));
  return Array.from({ length: of }, (_, part) => ({ t: "chunk", id, part, of, data: text.slice(part * CHUNK_TEXT, (part + 1) * CHUNK_TEXT) }));
}

/** The snapshot op once every piece of it came (in any order); null while some are missing or it is not a board. */
export function joinChunks(chunks: Chunk[]): Op | null {
  if (chunks.length === 0) return null;
  const of = chunks[0]!.of;
  const parts = new Map(chunks.filter((c) => c.of === of && c.id === chunks[0]!.id).map((c) => [c.part, c.data]));
  if (parts.size !== of) return null;
  const text = Array.from({ length: of }, (_, i) => parts.get(i) ?? "").join("");
  const board = readSnapshot(safeParse(text));
  return board ? { t: "snap", board } : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- What comes from the call is read, never taken as it is.

const ID_RE = /^[A-Za-z0-9_-]{1,64}:\d{1,9}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A text without control characters, but with its lines. */
const plain = (text: string) => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
const int = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : null);
const size = (v: unknown) => {
  const n = int(v, 200);
  return n === null || n < 1 ? null : n;
};
const point = (v: unknown): Point | null => {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const x = int(v[0], BOARD_WIDTH);
  const y = int(v[1], BOARD_HEIGHT);
  return x === null || y === null ? null : [x, y];
};
const points = (v: unknown): number[] | null => {
  if (!Array.isArray(v) || v.length % 2 !== 0 || v.length > MAX_POINTS * 2) return null;
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const n = int(v[i], i % 2 === 0 ? BOARD_WIDTH : BOARD_HEIGHT);
    if (n === null) return null;
    out.push(n);
  }
  return out;
};
const users = (v: unknown): string[] | null => (Array.isArray(v) && v.length <= 100 && v.every((u) => typeof u === "string" && USER_RE.test(u)) ? (v as string[]) : null);

function readStroke(v: unknown): Stroke | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== "string" || !ID_RE.test(s.id) || typeof s.by !== "string" || !USER_RE.test(s.by) || !s.id.startsWith(`${s.by}:`)) return null;
  const color = typeof s.color === "string" && COLOR_RE.test(s.color) ? s.color : null;
  const width = size(s.size);
  if (!color || width === null) return null;
  if (s.kind === "path" && (s.tool === "pen" || s.tool === "marker" || s.tool === "eraser")) {
    const pts = points(s.pts);
    return pts ? { kind: "path", id: s.id, by: s.by, tool: s.tool, color, size: width, pts } : null;
  }
  if (s.kind === "shape" && (s.tool === "line" || s.tool === "arrow" || s.tool === "rect" || s.tool === "ellipse")) {
    const a = point(s.a);
    const b = point(s.b);
    return a && b ? { kind: "shape", id: s.id, by: s.by, tool: s.tool, color, size: width, a, b } : null;
  }
  if (s.kind === "text" && typeof s.text === "string" && s.text.length <= 500) {
    const at = point(s.at);
    return at ? { kind: "text", id: s.id, by: s.by, color, size: width, at, text: plain(s.text) } : null;
  }
  return null;
}

function readSnapshot(v: unknown): Snapshot | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const allowed = users(s.allowed);
  if (typeof s.owner !== "string" || !USER_RE.test(s.owner) || typeof s.everyone !== "boolean" || !allowed || !Array.isArray(s.strokes) || s.strokes.length > MAX_STROKES) return null;
  const strokes = s.strokes.map(readStroke).filter((x): x is Stroke => x !== null);
  return { owner: s.owner, everyone: s.everyone, allowed, strokes };
}

function readOp(v: unknown): Op | Chunk | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const color = typeof o.color === "string" && COLOR_RE.test(o.color) ? o.color : null;
  switch (o.t) {
    case "open":
      return typeof o.owner === "string" && USER_RE.test(o.owner) ? { t: "open", owner: o.owner } : null;
    case "close":
    case "hello":
    case "clear":
      return { t: o.t };
    case "perm": {
      const allowed = users(o.allowed);
      return typeof o.everyone === "boolean" && allowed ? { t: "perm", everyone: o.everyone, allowed } : null;
    }
    case "s": {
      const pts = points(o.pts);
      const width = size(o.size);
      if (typeof o.id !== "string" || !ID_RE.test(o.id) || (o.tool !== "pen" && o.tool !== "marker" && o.tool !== "eraser") || !color || width === null || !pts) return null;
      return { t: "s", id: o.id, tool: o.tool, color, size: width, pts };
    }
    case "p": {
      const pts = points(o.pts);
      return typeof o.id === "string" && ID_RE.test(o.id) && pts ? { t: "p", id: o.id, pts } : null;
    }
    case "shape": {
      const a = point(o.a);
      const b = point(o.b);
      const width = size(o.size);
      const tool = o.tool;
      if (typeof o.id !== "string" || !ID_RE.test(o.id) || (tool !== "line" && tool !== "arrow" && tool !== "rect" && tool !== "ellipse") || !color || width === null || !a || !b) return null;
      return { t: "shape", id: o.id, tool, color, size: width, a, b };
    }
    case "text": {
      const at = point(o.at);
      const width = size(o.size);
      if (typeof o.id !== "string" || !ID_RE.test(o.id) || !color || width === null || !at || typeof o.text !== "string" || o.text.length > 500) return null;
      return { t: "text", id: o.id, color, size: width, at, text: plain(o.text) };
    }
    case "x":
      return Array.isArray(o.ids) && o.ids.length <= 500 && o.ids.every((id) => typeof id === "string" && ID_RE.test(id)) ? { t: "x", ids: o.ids as string[] } : null;
    case "laser": {
      const at = point(o.at);
      return at ? { t: "laser", at } : null;
    }
    case "chunk":
      return typeof o.id === "string" && o.id.length <= 40 && Number.isInteger(o.part) && Number.isInteger(o.of) && (o.of as number) > 0 && (o.of as number) <= 400 && (o.part as number) >= 0 && (o.part as number) < (o.of as number) && typeof o.data === "string" && o.data.length <= CHUNK_TEXT
        ? { t: "chunk", id: o.id, part: o.part as number, of: o.of as number, data: o.data }
        : null;
    default:
      return null;
  }
}

/** A packet as it came from someone in the call (decrypted already); odd ops are dropped, an odd packet is null. */
export function readOps(raw: unknown): { n: number; ops: (Op | Chunk)[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.n !== "number" || !Number.isInteger(p.n) || p.n < 0 || !Array.isArray(p.ops) || p.ops.length > 200) return null;
  return { n: p.n, ops: p.ops.map(readOp).filter((op): op is Op | Chunk => op !== null) };
}
