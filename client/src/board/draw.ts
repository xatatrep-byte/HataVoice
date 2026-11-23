import { BOARD_HEIGHT, BOARD_WIDTH, type Board, type Point, type Stroke } from "./model";
import { LASER_MS } from "./sync";

export const BOARD_PAPER = "#ffffff";

let layer: CanvasRenderingContext2D | null = null;

/** The strokes' layer, the size of the board's canvas (one, used again). */
function layerFor(width: number, height: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!layer) {
    const canvas = document.createElement("canvas");
    layer = canvas.getContext?.("2d") ?? null;
    if (!layer) return null;
  }
  if (layer.canvas.width !== width) layer.canvas.width = width;
  if (layer.canvas.height !== height) layer.canvas.height = height;
  return layer;
}

/** A path through its points, smoothed through their middles. */
function path(ctx: CanvasRenderingContext2D, pts: number[]) {
  ctx.beginPath();
  if (pts.length === 2) {
    ctx.moveTo(pts[0]!, pts[1]!);
    ctx.lineTo(pts[0]! + 0.01, pts[1]!);
    return;
  }
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i]! + pts[i + 2]!) / 2;
    const my = (pts[i + 1]! + pts[i + 3]!) / 2;
    ctx.quadraticCurveTo(pts[i]!, pts[i + 1]!, mx, my);
  }
  ctx.lineTo(pts[pts.length - 2]!, pts[pts.length - 1]!);
}

function arrowHead(ctx: CanvasRenderingContext2D, [ax, ay]: Point, [bx, by]: Point, size: number) {
  const angle = Math.atan2(by - ay, bx - ax);
  const length = Math.max(14, size * 4);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - length * Math.cos(angle - 0.45), by - length * Math.sin(angle - 0.45));
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - length * Math.cos(angle + 0.45), by - length * Math.sin(angle + 0.45));
  ctx.stroke();
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, rubs = true) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (s.kind === "path" && s.tool === "eraser") {
    // The eraser rubs out what was drawn before it (on the strokes' own layer; on paper alone it paints the paper).
    if (rubs) ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = BOARD_PAPER;
    ctx.lineWidth = s.size;
    path(ctx, s.pts);
    ctx.stroke();
  } else if (s.kind === "path") {
    // A marker is wide and lets what is under it show (a highlighter).
    ctx.globalAlpha = s.tool === "marker" ? 0.35 : 1;
    ctx.lineWidth = s.tool === "marker" ? s.size * 2.5 : s.size;
    path(ctx, s.pts);
    ctx.stroke();
  } else if (s.kind === "shape") {
    ctx.lineWidth = s.size;
    const [ax, ay] = s.a;
    const [bx, by] = s.b;
    ctx.beginPath();
    if (s.tool === "line" || s.tool === "arrow") {
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      if (s.tool === "arrow") arrowHead(ctx, s.a, s.b, s.size);
    } else if (s.tool === "rect") {
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    } else {
      ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.max(1, Math.abs(bx - ax) / 2), Math.max(1, Math.abs(by - ay) / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    ctx.font = `600 ${s.size}px Manrope, "Segoe UI", sans-serif`;
    ctx.textBaseline = "alphabetic";
    s.text.split("\n").forEach((line, i) => ctx.fillText(line, s.at[0], s.at[1] + i * s.size * 1.2));
  }
  ctx.restore();
}

/**
 * The board at `scale` (canvas pixels per board unit): the paper, every stroke, the one being drawn, and the lasers of
 * the last moment (fading).
 */
export function drawBoard(ctx: CanvasRenderingContext2D, board: Board, scale: number, preview: Stroke | null, lasers: Map<string, { at: Point; time: number }>, now: number) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = BOARD_PAPER;
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  // The strokes go on a layer of their own, so the eraser rubs them out and never the paper.
  const strokes = layerFor(ctx.canvas.width, ctx.canvas.height);
  if (strokes) {
    strokes.setTransform(1, 0, 0, 1, 0, 0);
    strokes.clearRect(0, 0, strokes.canvas.width, strokes.canvas.height);
    strokes.setTransform(scale, 0, 0, scale, 0, 0);
    for (const stroke of board.strokes) drawStroke(strokes, stroke);
    if (preview) drawStroke(strokes, preview);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(strokes.canvas, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  } else {
    for (const stroke of board.strokes) drawStroke(ctx, stroke, false);
    if (preview) drawStroke(ctx, preview, false);
  }
  for (const { at, time } of lasers.values()) {
    const age = now - time;
    if (age > LASER_MS) continue;
    const fade = 1 - age / LASER_MS;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = "rgba(239, 68, 68, 0.25)";
    ctx.beginPath();
    ctx.arc(at[0], at[1], 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(at[0], at[1], 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Whether any laser still shows at `now` (the view keeps drawing while one does). */
export function lasersShowing(lasers: Map<string, { time: number }>, now: number): boolean {
  for (const { time } of lasers.values()) if (now - time <= LASER_MS) return true;
  return false;
}
