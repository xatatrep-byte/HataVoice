/**
 * The photo editor's drawing: the photo turned, flipped, straightened, corrected and filtered, its hidden parts made
 * unreadable, then the layers on it; cut to the crop for the result. The same code draws the preview (from a smaller
 * copy) and the photo that is sent (from the photo itself).
 */
import { boundsOf, coverScale, orientedSize, rotationOf, type BrushLayer, type Layer, type Measure, type PhotoDoc, type Rect, type TextLayer } from "./doc";
import { applyPixels, effectiveAdjust, sharpen, type Adjust } from "./pixels";

export type Picture = CanvasImageSource & { width: number; height: number };

const canvasOf = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
};

export const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
export const FONTS = ["Manrope", "Arial", "Georgia", "Times New Roman", "Impact", "Comic Sans MS", "Courier New", "Trebuchet MS", "Verdana", "Segoe Script"];

export const fontOf = (t: Pick<TextLayer, "italic" | "bold" | "size" | "font">) => `${t.italic ? "italic " : ""}${t.bold ? 800 : 500} ${t.size}px "${t.font}", sans-serif`;
const LINE = 1.25;
const PLATE = 0.3;

let measuring: CanvasRenderingContext2D | null = null;
/** How big a text's box is (its widest line, its lines; a plate under it adds a margin). */
export const measureText: Measure = (t) => {
  measuring ??= document.createElement("canvas").getContext("2d");
  const lines = t.text.split("\n");
  const pad = t.background ? t.size * PLATE * 2 : 0;
  if (!measuring) return { width: Math.max(...lines.map((l) => l.length)) * t.size * 0.6 + pad, height: lines.length * t.size * LINE + pad };
  measuring.font = fontOf(t);
  const width = Math.max(t.size * 0.5, ...lines.map((line) => measuring!.measureText(line).width));
  return { width: width + pad, height: lines.length * t.size * LINE + pad };
};

/** A path through the points, smoothed through their middles. */
function trace(ctx: CanvasRenderingContext2D, pts: number[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0]!, pts[1]!);
  if (pts.length === 2) {
    ctx.lineTo(pts[0]! + 0.01, pts[1]!);
    return;
  }
  for (let i = 2; i < pts.length - 2; i += 2) ctx.quadraticCurveTo(pts[i]!, pts[i + 1]!, (pts[i]! + pts[i + 2]!) / 2, (pts[i + 1]! + pts[i + 3]!) / 2);
  ctx.lineTo(pts[pts.length - 2]!, pts[pts.length - 1]!);
}

function drawBrush(ctx: CanvasRenderingContext2D, b: BrushLayer) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = b.color;
  if (b.mode === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "#000";
  }
  const soft = (b.softness / 100) * b.size;
  if (b.mode === "marker") {
    ctx.globalAlpha *= 0.45;
    ctx.lineCap = "square";
    ctx.lineWidth = b.size * 2;
  } else ctx.lineWidth = Math.max(0.5, b.size - soft * 0.6);
  if (soft > 0 && b.mode !== "marker") {
    ctx.shadowColor = b.mode === "eraser" ? "#000" : b.color;
    ctx.shadowBlur = soft;
  }
  if (b.mode === "neon") {
    ctx.shadowColor = b.color;
    ctx.shadowBlur = b.size * 1.6;
    trace(ctx, b.pts);
    ctx.stroke();
    ctx.shadowBlur = b.size * 0.6;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, b.size * 0.35);
  }
  trace(ctx, b.pts);
  ctx.stroke();
}

function arrowHead(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, width: number) {
  const angle = Math.atan2(by - ay, bx - ax);
  const length = Math.max(14, width * 4.5);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - length * Math.cos(angle - 0.42), by - length * Math.sin(angle - 0.42));
  ctx.lineTo(bx - length * Math.cos(angle + 0.42), by - length * Math.sin(angle + 0.42));
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

/** One layer (not a hidden part), in photo pixels on `ctx` (its transform already scaled). */
export function drawLayer(ctx: CanvasRenderingContext2D, layer: Layer, measure: Measure = measureText) {
  if (layer.hidden || layer.kind === "censor") return;
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  const box = boundsOf(layer, measure);
  const angle = rotationOf(layer);
  if (angle) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  if (layer.kind === "brush") drawBrush(ctx, layer);
  else if (layer.kind === "shape") {
    ctx.lineWidth = layer.width;
    ctx.strokeStyle = layer.stroke;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (layer.shape === "line" || layer.shape === "arrow") {
      ctx.beginPath();
      ctx.moveTo(layer.x1, layer.y1);
      ctx.lineTo(layer.x2, layer.y2);
      ctx.stroke();
      if (layer.shape === "arrow") arrowHead(ctx, layer.x1, layer.y1, layer.x2, layer.y2, layer.width);
    } else {
      ctx.beginPath();
      if (layer.shape === "rect") ctx.rect(box.x, box.y, box.w, box.h);
      else ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, Math.max(0.5, box.w / 2), Math.max(0.5, box.h / 2), 0, 0, Math.PI * 2);
      if (layer.fill) {
        ctx.fillStyle = layer.fill;
        ctx.fill();
      }
      if (layer.width > 0) ctx.stroke();
    }
  } else if (layer.kind === "text") {
    const pad = layer.background ? layer.size * PLATE : 0;
    if (layer.background) {
      ctx.fillStyle = layer.background;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, layer.size * 0.25);
      ctx.fill();
    }
    ctx.font = fontOf(layer);
    ctx.textBaseline = "top";
    ctx.textAlign = layer.align;
    const inner = box.w - pad * 2;
    const x = box.x + pad + (layer.align === "center" ? inner / 2 : layer.align === "right" ? inner : 0);
    layer.text.split("\n").forEach((line, i) => {
      const y = box.y + pad + i * layer.size * LINE + layer.size * (LINE - 1) * 0.5;
      if (layer.outline) {
        ctx.lineWidth = Math.max(2, layer.size / 7);
        ctx.lineJoin = "round";
        ctx.strokeStyle = layer.outline;
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = layer.color;
      ctx.fillText(line, x, y);
    });
  } else {
    ctx.font = `${layer.size}px ${EMOJI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(layer.emoji, layer.x, layer.y + layer.size * 0.06);
  }
  ctx.restore();
}

/** The parts to hide, made unreadable on the photo (`scale`: canvas pixels per photo pixel). */
function hideParts(canvas: HTMLCanvasElement, layers: Layer[], scale: number) {
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    if (layer.kind !== "censor" || layer.hidden) continue;
    const b = boundsOf(layer, measureText);
    const r = { x: Math.round(b.x * scale), y: Math.round(b.y * scale), w: Math.max(1, Math.round(b.w * scale)), h: Math.max(1, Math.round(b.h * scale)) };
    if (layer.mode === "black") {
      ctx.fillStyle = "#000";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      continue;
    }
    if (layer.mode === "blur") {
      // So strong nothing can be read back, and the edges of the part blurred with what is around it.
      const radius = Math.max(8, Math.min(r.w, r.h) / 5);
      const part = canvasOf(r.w + radius * 4, r.h + radius * 4);
      const p = part.getContext("2d")!;
      p.filter = `blur(${radius}px)`;
      p.drawImage(canvas, r.x - radius * 2, r.y - radius * 2, part.width, part.height, 0, 0, part.width, part.height);
      p.drawImage(part, 0, 0);
      ctx.drawImage(part, radius * 2, radius * 2, r.w, r.h, r.x, r.y, r.w, r.h);
      continue;
    }
    const cell = Math.max(6, Math.round(Math.max(r.w, r.h) / 14));
    const small = canvasOf(Math.ceil(r.w / cell), Math.ceil(r.h / cell));
    small.getContext("2d")!.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
    ctx.imageSmoothingEnabled = true;
  }
}

/** The corrections done on the pixels (blur is the canvas's own). */
const PIXEL_WORK: (keyof Adjust)[] = ["exposure", "brightness", "contrast", "highlights", "shadows", "saturation", "vibrance", "temperature", "tint", "hue", "sharpen", "vignette", "grain", "fade"];

/**
 * The photo as the document has it, before its layers: turned, flipped, straightened, corrected, filtered, hidden parts
 * hidden; `scale` canvas pixels for each pixel of the turned photo. `picture` may be a smaller copy of the photo.
 */
export function renderBase(picture: Picture, doc: PhotoDoc, scale: number): HTMLCanvasElement {
  const { width, height } = orientedSize(doc);
  const canvas = canvasOf(width * scale, height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const a = effectiveAdjust(doc.adjust, doc.filter, doc.amount);
  if (a.blur > 0) ctx.filter = `blur(${((a.blur / 100) * 0.012 * Math.max(canvas.width, canvas.height)).toFixed(2)}px)`;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(((doc.turn * 90 + doc.angle) * Math.PI) / 180);
  const cover = coverScale(width, height, doc.angle);
  ctx.scale((doc.flipX ? -1 : 1) * cover, (doc.flipY ? -1 : 1) * cover);
  ctx.drawImage(picture, (-doc.width * scale) / 2, (-doc.height * scale) / 2, doc.width * scale, doc.height * scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  if (doc.filter !== "none" || PIXEL_WORK.some((key) => a[key] !== 0)) {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (a.sharpen) sharpen(image.data, canvas.width, canvas.height, a.sharpen);
    applyPixels(image.data, canvas.width, canvas.height, a, doc.filter, doc.amount, 7);
    ctx.putImageData(image, 0, 0);
  }
  hideParts(canvas, doc.layers, scale);
  return canvas;
}

/**
 * The layers over `canvas` (`scale` canvas pixels per photo pixel, the canvas's corner at photo point `ox`, `oy`); an
 * eraser rubs out only what was drawn.
 */
export function drawLayers(canvas: HTMLCanvasElement, layers: Layer[], scale: number, ox = 0, oy = 0) {
  const shown = layers.filter((l) => !l.hidden && l.kind !== "censor");
  if (shown.length === 0) return;
  const over = canvasOf(canvas.width, canvas.height);
  const ctx = over.getContext("2d")!;
  ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
  for (const layer of shown) drawLayer(ctx, layer);
  canvas.getContext("2d")!.drawImage(over, 0, 0);
}

/** The finished photo: the document drawn whole at `scale`, cut to its crop. */
export function renderDoc(picture: Picture, doc: PhotoDoc, scale: number): HTMLCanvasElement {
  const canvas = renderBase(picture, doc, scale);
  drawLayers(canvas, doc.layers, scale);
  if (!doc.crop) return canvas;
  const c: Rect = doc.crop;
  const out = canvasOf(c.width * scale, c.height * scale);
  out.getContext("2d")!.drawImage(canvas, c.x * scale, c.y * scale, c.width * scale, c.height * scale, 0, 0, out.width, out.height);
  return out;
}
