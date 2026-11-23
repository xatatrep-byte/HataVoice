/**
 * The photo editor's document: the photo (turned, flipped, straightened, cropped, corrected, filtered) and the layers on
 * it — brush strokes, shapes, texts, stickers, hidden parts — each one that can be chosen, moved, resized and turned,
 * with a history to go back and forth in. Layers live in the turned photo's own pixels (before the crop). Pure.
 */
import { NO_ADJUST, type Adjust } from "./pixels";

export type Rect = { x: number; y: number; width: number; height: number };
/** Quarter turns clockwise. */
export type Turn = 0 | 1 | 2 | 3;

type Base = { id: string; opacity: number; hidden?: boolean };
export type BrushLayer = Base & {
  kind: "brush";
  /** A pen, a see-through marker, a glowing neon line, or an eraser of what was drawn (not of the photo). */
  mode: "pen" | "marker" | "neon" | "eraser";
  color: string;
  size: number;
  /** 0 a hard edge … 100 a soft one. */
  softness: number;
  pts: number[];
};
export type ShapeLayer = Base & {
  kind: "shape";
  shape: "rect" | "ellipse" | "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  width: number;
  fill: string | null;
  /** Degrees clockwise, around its middle (rectangles and ellipses). */
  rotation: number;
};
export type TextLayer = Base & {
  kind: "text";
  text: string;
  /** Its box's top left corner. */
  x: number;
  y: number;
  size: number;
  font: string;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  /** A line around the letters, or a plate under them. */
  outline: string | null;
  background: string | null;
  rotation: number;
};
export type StickerLayer = Base & { kind: "sticker"; emoji: string; x: number; y: number; size: number; rotation: number };
/** A part made unreadable: squares, a blur, or black. */
export type CensorLayer = Base & { kind: "censor"; mode: "pixelate" | "blur" | "black"; x: number; y: number; w: number; h: number };
export type Layer = BrushLayer | ShapeLayer | TextLayer | StickerLayer | CensorLayer;

export type PhotoDoc = {
  /** The photo as it came. */
  width: number;
  height: number;
  turn: Turn;
  flipX: boolean;
  flipY: boolean;
  /** Straightening, degrees (−45…45); the photo is scaled up so no corner shows empty. */
  angle: number;
  /** The part kept, in the turned photo's pixels; null: all of it. */
  crop: Rect | null;
  adjust: Adjust;
  filter: string;
  /** How strongly the filter shows, 0–100. */
  amount: number;
  layers: Layer[];
};

export const newDoc = (width: number, height: number): PhotoDoc => ({
  width,
  height,
  turn: 0,
  flipX: false,
  flipY: false,
  angle: 0,
  crop: null,
  adjust: { ...NO_ADJUST },
  filter: "none",
  amount: 100,
  layers: [],
});

export function orientedSize(doc: Pick<PhotoDoc, "width" | "height" | "turn">): { width: number; height: number } {
  return doc.turn % 2 === 1 ? { width: doc.height, height: doc.width } : { width: doc.width, height: doc.height };
}

/** How much a `width` × `height` photo turned by `angle` degrees is scaled so it still covers its frame. */
export function coverScale(width: number, height: number, angle: number): number {
  const a = (Math.abs(angle) * Math.PI) / 180;
  if (a === 0) return 1;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.max((width * c + height * s) / width, (width * s + height * c) / height);
}

/** A part within a picture of `width` × `height`, at least a few pixels each way. */
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const least = Math.min(8, width, height);
  const x = Math.max(0, Math.min(width - least, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height - least, Math.round(rect.y)));
  return {
    x,
    y,
    width: Math.max(least, Math.min(width - x, Math.round(rect.width))),
    height: Math.max(least, Math.min(height - y, Math.round(rect.height))),
  };
}

/** The biggest part of shape `aspect` (width / height) in the middle of the picture; null: no shape (free). */
export function aspectCrop(aspect: number | null, width: number, height: number): Rect | null {
  if (aspect === null) return null;
  let w = width;
  let h = Math.round(width / aspect);
  if (h > height) {
    h = height;
    w = Math.round(height * aspect);
  }
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
}

// ---- Layers: where they are, what is under a point, moving and resizing.

export type Box = { x: number; y: number; w: number; h: number };
export type Measure = (text: TextLayer) => { width: number; height: number };

/** A layer's box, unturned (its turn is around the box's middle). */
export function boundsOf(layer: Layer, measure: Measure): Box {
  switch (layer.kind) {
    case "shape": {
      const x = Math.min(layer.x1, layer.x2);
      const y = Math.min(layer.y1, layer.y2);
      return { x, y, w: Math.abs(layer.x2 - layer.x1), h: Math.abs(layer.y2 - layer.y1) };
    }
    case "text": {
      const { width, height } = measure(layer);
      return { x: layer.x, y: layer.y, w: width, h: height };
    }
    case "sticker":
      return { x: layer.x - layer.size / 2, y: layer.y - layer.size / 2, w: layer.size, h: layer.size };
    case "censor":
      return { x: Math.min(layer.x, layer.x + layer.w), y: Math.min(layer.y, layer.y + layer.h), w: Math.abs(layer.w), h: Math.abs(layer.h) };
    case "brush": {
      let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < layer.pts.length; i += 2) {
        minX = Math.min(minX, layer.pts[i]!);
        maxX = Math.max(maxX, layer.pts[i]!);
        minY = Math.min(minY, layer.pts[i + 1]!);
        maxY = Math.max(maxY, layer.pts[i + 1]!);
      }
      const half = layer.size / 2;
      return { x: minX - half, y: minY - half, w: maxX - minX + layer.size, h: maxY - minY + layer.size };
    }
  }
}

export const rotationOf = (layer: Layer): number => ("rotation" in layer && !(layer.kind === "shape" && (layer.shape === "line" || layer.shape === "arrow")) ? layer.rotation : 0);

/** A point given in the photo, in the layer's own unturned frame. */
export function toLocal(layer: Layer, box: Box, x: number, y: number): [number, number] {
  const angle = rotationOf(layer);
  if (!angle) return [x, y];
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const a = (-angle * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

function toSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function hits(layer: Layer, x: number, y: number, measure: Measure, tolerance: number): boolean {
  const box = boundsOf(layer, measure);
  const [lx, ly] = toLocal(layer, box, x, y);
  const inside = (pad: number) => lx >= box.x - pad && lx <= box.x + box.w + pad && ly >= box.y - pad && ly <= box.y + box.h + pad;
  switch (layer.kind) {
    case "shape": {
      const near = tolerance + layer.width / 2;
      if (layer.shape === "line" || layer.shape === "arrow") return toSegment(lx, ly, layer.x1, layer.y1, layer.x2, layer.y2) <= near;
      if (layer.shape === "rect") {
        if (layer.fill && inside(0)) return true;
        const { x: bx, y: by, w, h } = box;
        return inside(near) && (Math.abs(lx - bx) <= near || Math.abs(lx - bx - w) <= near || Math.abs(ly - by) <= near || Math.abs(ly - by - h) <= near);
      }
      const rx = Math.max(1, box.w / 2);
      const ry = Math.max(1, box.h / 2);
      const d = Math.hypot((lx - box.x - rx) / rx, (ly - box.y - ry) / ry);
      return (layer.fill !== null && d <= 1) || Math.abs(d - 1) * Math.min(rx, ry) <= near;
    }
    case "brush": {
      if (layer.mode === "eraser") return false;
      const near = tolerance + layer.size / 2;
      if (layer.pts.length === 2) return Math.hypot(lx - layer.pts[0]!, ly - layer.pts[1]!) <= near;
      for (let i = 2; i < layer.pts.length; i += 2) {
        if (toSegment(lx, ly, layer.pts[i - 2]!, layer.pts[i - 1]!, layer.pts[i]!, layer.pts[i + 1]!) <= near) return true;
      }
      return false;
    }
    default:
      return inside(tolerance);
  }
}

/** The topmost shown layer under (x, y), within `tolerance` of its line. */
export function hitTest(layers: Layer[], x: number, y: number, measure: Measure, tolerance: number): Layer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (!layer.hidden && hits(layer, x, y, measure, tolerance)) return layer;
  }
  return null;
}

export type Handle = "nw" | "ne" | "sw" | "se" | "start" | "end" | "rotate";

/** How far above its box the turning handle sits, on screen. */
export const ROTATE_GAP = 28;

/** Where each handle of a layer is, in its unturned frame (`scale`: screen pixels per photo pixel). */
export function handlesOf(layer: Layer, measure: Measure, scale: number): [Handle, number, number][] {
  if (layer.kind === "shape" && (layer.shape === "line" || layer.shape === "arrow")) {
    return [
      ["start", layer.x1, layer.y1],
      ["end", layer.x2, layer.y2],
    ];
  }
  const b = boundsOf(layer, measure);
  const out: [Handle, number, number][] = [
    ["nw", b.x, b.y],
    ["ne", b.x + b.w, b.y],
    ["sw", b.x, b.y + b.h],
    ["se", b.x + b.w, b.y + b.h],
  ];
  if (layer.kind !== "brush" && layer.kind !== "censor") out.push(["rotate", b.x + b.w / 2, b.y - ROTATE_GAP / scale]);
  return out;
}

/** The handle of the chosen layer under (x, y), if any. */
export function handleAt(layer: Layer, x: number, y: number, measure: Measure, scale: number): Handle | null {
  const box = boundsOf(layer, measure);
  const [lx, ly] = toLocal(layer, box, x, y);
  const reach = 10 / scale;
  for (const [handle, hx, hy] of handlesOf(layer, measure, scale)) if (Math.hypot(lx - hx, ly - hy) <= reach) return handle;
  return null;
}

/** The layer moved by (dx, dy). */
export function moveLayer(layer: Layer, dx: number, dy: number): Layer {
  switch (layer.kind) {
    case "shape":
      return { ...layer, x1: layer.x1 + dx, y1: layer.y1 + dy, x2: layer.x2 + dx, y2: layer.y2 + dy };
    case "brush":
      return { ...layer, pts: layer.pts.map((v, i) => v + (i % 2 === 0 ? dx : dy)) };
    default:
      return { ...layer, x: layer.x + dx, y: layer.y + dy };
  }
}

/** The layer with `handle` dragged by (dx, dy) in the photo (turned into its own frame first). */
export function resizeLayer(layer: Layer, handle: Handle, dx: number, dy: number, measure: Measure): Layer {
  const angle = (-rotationOf(layer) * Math.PI) / 180;
  const ldx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ldy = dx * Math.sin(angle) + dy * Math.cos(angle);
  const box = boundsOf(layer, measure);
  // The box after the drag: the corner held moves, the opposite one stays.
  let { x, y, w, h } = box;
  if (handle === "nw" || handle === "sw") {
    x += ldx;
    w -= ldx;
  }
  if (handle === "ne" || handle === "se") w += ldx;
  if (handle === "nw" || handle === "ne") {
    y += ldy;
    h -= ldy;
  }
  if (handle === "sw" || handle === "se") h += ldy;
  w = Math.max(4, w);
  h = Math.max(4, h);
  switch (layer.kind) {
    case "shape":
      if (handle === "start") return { ...layer, x1: layer.x1 + dx, y1: layer.y1 + dy };
      if (handle === "end") return { ...layer, x2: layer.x2 + dx, y2: layer.y2 + dy };
      return { ...layer, x1: x, y1: y, x2: x + w, y2: y + h };
    case "censor":
      return { ...layer, x, y, w, h };
    case "text": {
      const size = Math.max(8, Math.round((layer.size * h) / Math.max(1, box.h)));
      const grown = measure({ ...layer, size });
      // The corner held stays where it was.
      const nx = handle === "nw" || handle === "sw" ? box.x + box.w - grown.width : box.x;
      const ny = handle === "nw" || handle === "ne" ? box.y + box.h - grown.height : box.y;
      return { ...layer, size, x: nx, y: ny };
    }
    case "sticker": {
      const size = Math.max(12, Math.round(Math.max(w, h)));
      return { ...layer, size, x: x + w / 2, y: y + h / 2 };
    }
    case "brush": {
      const sx = w / Math.max(1, box.w);
      const sy = h / Math.max(1, box.h);
      return { ...layer, pts: layer.pts.map((v, i) => (i % 2 === 0 ? x + (v - box.x) * sx : y + (v - box.y) * sy)) };
    }
  }
}

/** The layer turned so its top faces (x, y) from its middle (snapping to 15° with `snap`). */
export function turnLayer(layer: Layer, x: number, y: number, measure: Measure, snap: boolean): Layer {
  if (!("rotation" in layer)) return layer;
  const b = boundsOf(layer, measure);
  let degrees = (Math.atan2(y - (b.y + b.h / 2), x - (b.x + b.w / 2)) * 180) / Math.PI + 90;
  if (snap) degrees = Math.round(degrees / 15) * 15;
  degrees = ((Math.round(degrees) % 360) + 360) % 360;
  return { ...layer, rotation: degrees > 180 ? degrees - 360 : degrees };
}

// ---- Turning and flipping the photo, its layers and crop along.

/** Each point (x, y) of the photo moved by `map`; a layer keeps its own look (a text still reads left to right). */
function mapLayer(layer: Layer, map: (x: number, y: number) => [number, number], turn: (rotation: number) => number, measure: Measure): Layer {
  switch (layer.kind) {
    case "brush": {
      const pts: number[] = [];
      for (let i = 0; i < layer.pts.length; i += 2) pts.push(...map(layer.pts[i]!, layer.pts[i + 1]!));
      return { ...layer, pts };
    }
    case "shape": {
      const [x1, y1] = map(layer.x1, layer.y1);
      const [x2, y2] = map(layer.x2, layer.y2);
      return { ...layer, x1, y1, x2, y2, rotation: turn(layer.rotation) };
    }
    case "censor": {
      const [ax, ay] = map(layer.x, layer.y);
      const [bx, by] = map(layer.x + layer.w, layer.y + layer.h);
      return { ...layer, x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
    }
    case "sticker": {
      const [x, y] = map(layer.x, layer.y);
      return { ...layer, x, y, rotation: turn(layer.rotation) };
    }
    case "text": {
      const box = boundsOf(layer, measure);
      const [cx, cy] = map(box.x + box.w / 2, box.y + box.h / 2);
      return { ...layer, x: cx - box.w / 2, y: cy - box.h / 2, rotation: turn(layer.rotation) };
    }
  }
}

function mapRect(rect: Rect, map: (x: number, y: number) => [number, number]): Rect {
  const [ax, ay] = map(rect.x, rect.y);
  const [bx, by] = map(rect.x + rect.width, rect.y + rect.height);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

const wrap = (degrees: number) => {
  const d = ((degrees % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
};

/** The photo turned a quarter clockwise, its layers and crop along. */
export function turnDoc(doc: PhotoDoc, measure: Measure): PhotoDoc {
  const { height } = orientedSize(doc);
  const map = (x: number, y: number): [number, number] => [height - y, x];
  return {
    ...doc,
    turn: ((doc.turn + 1) % 4) as Turn,
    crop: doc.crop && mapRect(doc.crop, map),
    layers: doc.layers.map((layer) => mapLayer(layer, map, (r) => wrap(r + 90), measure)),
  };
}

/** The photo flipped left to right (`x`) or top to bottom (`y`), its layers and crop along. */
export function flipDoc(doc: PhotoDoc, axis: "x" | "y", measure: Measure): PhotoDoc {
  const { width, height } = orientedSize(doc);
  const map = (x: number, y: number): [number, number] => (axis === "x" ? [width - x, y] : [x, height - y]);
  // A flip of the turned photo is the other flip of the photo itself when it lies on its side.
  const sideways = doc.turn % 2 === 1;
  const flipX = (axis === "x") !== sideways ? !doc.flipX : doc.flipX;
  const flipY = (axis === "y") !== sideways ? !doc.flipY : doc.flipY;
  return {
    ...doc,
    flipX,
    flipY,
    crop: doc.crop && mapRect(doc.crop, map),
    layers: doc.layers.map((layer) => mapLayer(layer, map, (r) => wrap(-r), measure)),
  };
}

/**
 * The photo straightened to `angle` degrees, its layers turned and scaled with it around its middle (as the photo turns
 * under them); a hidden part grows to the box around where it went, so what it hid stays hidden.
 */
export function straightenDoc(doc: PhotoDoc, angle: number, measure: Measure): PhotoDoc {
  const delta = angle - doc.angle;
  if (!delta) return doc;
  const { width, height } = orientedSize(doc);
  const cx = width / 2;
  const cy = height / 2;
  const k = coverScale(width, height, angle) / coverScale(width, height, doc.angle);
  const a = (delta * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const map = (x: number, y: number): [number, number] => {
    const dx = (x - cx) * k;
    const dy = (y - cy) * k;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  const layers = doc.layers.map((layer): Layer => {
    switch (layer.kind) {
      case "brush": {
        const pts: number[] = [];
        for (let i = 0; i < layer.pts.length; i += 2) pts.push(...map(layer.pts[i]!, layer.pts[i + 1]!));
        return { ...layer, pts, size: layer.size * k };
      }
      case "shape": {
        if (layer.shape === "line" || layer.shape === "arrow") {
          const [x1, y1] = map(layer.x1, layer.y1);
          const [x2, y2] = map(layer.x2, layer.y2);
          return { ...layer, x1, y1, x2, y2, width: layer.width * k };
        }
        const box = boundsOf(layer, measure);
        const [mx, my] = map(box.x + box.w / 2, box.y + box.h / 2);
        const w = (box.w * k) / 2;
        const h = (box.h * k) / 2;
        return { ...layer, x1: mx - w, y1: my - h, x2: mx + w, y2: my + h, width: layer.width * k, rotation: wrap(layer.rotation + delta) };
      }
      case "text": {
        const box = boundsOf(layer, measure);
        const [mx, my] = map(box.x + box.w / 2, box.y + box.h / 2);
        const grown = { ...layer, size: layer.size * k };
        const size = measure(grown);
        return { ...grown, x: mx - size.width / 2, y: my - size.height / 2, rotation: wrap(layer.rotation + delta) };
      }
      case "sticker": {
        const [x, y] = map(layer.x, layer.y);
        return { ...layer, x, y, size: layer.size * k, rotation: wrap(layer.rotation + delta) };
      }
      case "censor": {
        const corners = [map(layer.x, layer.y), map(layer.x + layer.w, layer.y), map(layer.x, layer.y + layer.h), map(layer.x + layer.w, layer.y + layer.h)];
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        return { ...layer, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      }
    }
  });
  return { ...doc, angle, layers };
}

// ---- History.

export type History = { past: PhotoDoc[]; now: PhotoDoc; future: PhotoDoc[] };
const MAX_STEPS = 80;

export const history = (doc: PhotoDoc): History => ({ past: [], now: doc, future: [] });

/** A change, kept to go back to. */
export function record(h: History, next: PhotoDoc): History {
  if (next === h.now) return h;
  return { past: [...h.past, h.now].slice(-MAX_STEPS), now: next, future: [] };
}

export function undo(h: History): History {
  const before = h.past[h.past.length - 1];
  return before ? { past: h.past.slice(0, -1), now: before, future: [h.now, ...h.future] } : h;
}

export function redo(h: History): History {
  const after = h.future[0];
  return after ? { past: [...h.past, h.now], now: after, future: h.future.slice(1) } : h;
}

let ids = 0;
/** A new layer's id. */
export const layerId = () => `l${Date.now().toString(36)}${(++ids).toString(36)}`;
