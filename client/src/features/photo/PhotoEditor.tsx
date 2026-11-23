import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Brush,
  Circle,
  Crop,
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  Hand,
  Italic,
  Maximize2,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pipette,
  Redo2,
  RotateCcw,
  RotateCw,
  Shapes,
  Smile,
  Square,
  SquareDashed,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  aspectCrop,
  boundsOf,
  clampRect,
  flipDoc,
  handleAt,
  handlesOf,
  hitTest,
  history,
  layerId,
  moveLayer,
  newDoc,
  orientedSize,
  record,
  redo,
  resizeLayer,
  rotationOf,
  straightenDoc,
  turnDoc,
  turnLayer,
  undo,
  type BrushLayer,
  type CensorLayer,
  type Handle,
  type History,
  type Layer,
  type PhotoDoc,
  type Rect,
  type ShapeLayer,
  type TextLayer,
} from "../../media/photo/doc";
import { drawLayers, fontOf, FONTS, measureText, renderBase, renderDoc, type Picture } from "../../media/photo/render";
import { ColorPicker } from "./ColorPicker";
import { AdjustPanel, FiltersPanel, LayersPanel, StickersPanel } from "./PhotoPanels";
import "./photo.css";

export type PhotoTool = "move" | "crop" | "brush" | "eraser" | "shape" | "text" | "censor" | "picker" | "sticker" | "hand";
type Panel = "color" | "adjust" | "filters" | "layers" | "stickers";

export const PHOTO_TOOLS: { tool: PhotoTool; name: string; key: string; icon: typeof Brush }[] = [
  { tool: "move", name: "Перемещение", key: "V", icon: MousePointer2 },
  { tool: "crop", name: "Рамка и поворот", key: "C", icon: Crop },
  { tool: "brush", name: "Кисть", key: "B", icon: Brush },
  { tool: "eraser", name: "Ластик", key: "E", icon: Eraser },
  { tool: "shape", name: "Фигуры", key: "U", icon: Shapes },
  { tool: "text", name: "Текст", key: "T", icon: Type },
  { tool: "censor", name: "Скрыть", key: "J", icon: SquareDashed },
  { tool: "picker", name: "Пипетка", key: "I", icon: Pipette },
  { tool: "sticker", name: "Наклейки", key: "S", icon: Smile },
  { tool: "hand", name: "Рука", key: "H", icon: Hand },
];

const PANELS: { id: Panel; name: string }[] = [
  { id: "color", name: "Цвет" },
  { id: "adjust", name: "Коррекция" },
  { id: "filters", name: "Фильтры" },
  { id: "layers", name: "Слои" },
  { id: "stickers", name: "Наклейки" },
];

const ASPECTS: { name: string; value: number | "free" | "photo" }[] = [
  { name: "Свободно", value: "free" },
  { name: "Как у фото", value: "photo" },
  { name: "1:1", value: 1 },
  { name: "4:5", value: 4 / 5 },
  { name: "3:4", value: 3 / 4 },
  { name: "4:3", value: 4 / 3 },
  { name: "3:2", value: 3 / 2 },
  { name: "16:9", value: 16 / 9 },
  { name: "9:16", value: 9 / 16 },
];

const PREVIEW_SIDE = 2048;
const MAX_ZOOM = 16;

type Point = [number, number];
type CropHandle = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
type Drag =
  | { k: "draw"; start: PhotoDoc; id: string; last: Point }
  | { k: "box"; start: PhotoDoc; id: string; a: Point }
  | { k: "move"; start: PhotoDoc; id: string; last: Point }
  | { k: "resize"; start: PhotoDoc; id: string; handle: Handle; last: Point }
  | { k: "rotate"; start: PhotoDoc; id: string }
  | { k: "crop"; start: PhotoDoc; handle: CropHandle; from: Rect; a: Point }
  | { k: "text"; start: PhotoDoc; at: Point }
  | { k: "pan"; x: number; y: number; pan: Point };

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** The photo smaller, for the preview (its longest side at most 2048). */
function previewOf(picture: Picture): Picture {
  const k = PREVIEW_SIDE / Math.max(picture.width, picture.height);
  if (k >= 1) return picture;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(picture.width * k);
  canvas.height = Math.round(picture.height * k);
  canvas.getContext("2d")?.drawImage(picture, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** What the photo is written as: a PNG for what may be see-through, else a JPEG. */
export function outputOf(name: string): { type: string; name: string; quality?: number } {
  const stem = name.replace(/\.[^.]+$/, "") || "фото";
  return /\.(png|webp|gif|bmp)$/i.test(name) ? { type: "image/png", name: `${stem}.png` } : { type: "image/jpeg", name: `${stem}.jpg`, quality: 0.92 };
}

type Props = { src: string; name: string; onDone: (bytes: Uint8Array, name: string) => void; onClose: () => void };

/** The photo editor over the window: it loads the photo, then works on it. */
export function PhotoEditor({ src, name, onDone, onClose }: Props) {
  const [picture, setPicture] = useState<Picture | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const image = new Image();
    image.onload = () => setPicture(image);
    image.onerror = () => setBroken(true);
    image.src = src;
  }, [src]);
  if (broken) {
    return (
      <div className="photo-editor photo-editor-note" role="dialog" aria-label="Редактор фото">
        <p>Это фото не открывается.</p>
        <button type="button" className="photo-button" onClick={onClose}>
          Закрыть
        </button>
      </div>
    );
  }
  if (!picture) return <div className="photo-editor photo-editor-note" role="dialog" aria-label="Редактор фото">Открываю фото…</div>;
  return <PhotoWorkspace picture={picture} name={name} onDone={onDone} onClose={onClose} />;
}

/**
 * The photo editor, as photo editors are: the tools down the left (each with its key), the chosen tool's settings on
 * top, the photo in the middle (wheel to zoom, space or the hand to move it), and on the right the colour, the
 * corrections, the filters, the layers and the stickers. Every change can be taken back.
 */
export function PhotoWorkspace({ picture, name, onDone, onClose }: { picture: Picture; name: string; onDone: Props["onDone"]; onClose: () => void }) {
  const preview = useMemo(() => previewOf(picture), [picture]);
  const work = preview.width / picture.width;
  const [h, setH] = useState<History>(() => history(newDoc(picture.width, picture.height)));
  const doc = h.now;
  const [tool, setTool] = useState<PhotoTool>("brush");
  const [panel, setPanel] = useState<Panel>("color");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [color, setColor] = useState("#ef4444");
  const [recent, setRecent] = useState<string[]>([]);
  const [brush, setBrush] = useState({ mode: "pen" as BrushLayer["mode"], size: 12, softness: 0, opacity: 100 });
  const [shape, setShape] = useState({ shape: "rect" as ShapeLayer["shape"], width: 6, fill: false, opacity: 100 });
  const [type, setType] = useState({ font: "Manrope", bold: true, italic: false, align: "left" as TextLayer["align"], outline: true, background: false });
  const [censor, setCensor] = useState<CensorLayer["mode"]>("pixelate");
  const [aspect, setAspect] = useState<number | "free" | "photo">("free");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>([0, 0]);
  const [stage, setStage] = useState({ width: 800, height: 600 });
  const [spaceHand, setSpaceHand] = useState(false);
  const [busy, setBusy] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const sliding = useRef<PhotoDoc | null>(null);
  const before = useRef<PhotoTool>("brush");

  const oriented = orientedSize(doc);
  const full: Rect = { x: 0, y: 0, width: oriented.width, height: oriented.height };
  // What is shown: the whole photo while cropping, else the part kept.
  const view: Rect = tool === "crop" || !doc.crop ? full : doc.crop;
  const fit = Math.max(0.01, Math.min((stage.width - 48) / view.width, (stage.height - 48) / view.height));
  const ds = fit * zoom;
  const cssW = view.width * ds;
  const cssH = view.height * ds;
  const left = stage.width / 2 - cssW / 2 + pan[0];
  const top = stage.height / 2 - cssH / 2 + pan[1];
  const activeTool: PhotoTool = spaceHand ? "hand" : tool;
  const chosen = doc.layers.find((l) => l.id === selected) ?? null;

  // ---- Changing the document: live while a hand moves, kept in the history when it lets go.
  const live = (change: (doc: PhotoDoc) => PhotoDoc) => setH((now) => ({ ...now, now: change(now.now) }));
  const change = (fn: (doc: PhotoDoc) => PhotoDoc) => setH((now) => record(now, fn(now.now)));
  const settle = (start: PhotoDoc) => setH((now) => (now.now === start ? now : { past: [...now.past, start].slice(-80), now: now.now, future: [] }));
  const setLayer = (id: string, fn: (layer: Layer) => Layer) => (doc: PhotoDoc) => ({ ...doc, layers: doc.layers.map((l) => (l.id === id ? fn(l) : l)) });
  const remember = (c: string) => setRecent((all) => [c, ...all.filter((x) => x !== c)].slice(0, 12));
  /** A slider's change: live, the start kept for when it is let go. */
  const slide = (fn: (doc: PhotoDoc) => PhotoDoc) => {
    sliding.current ??= h.now;
    live(fn);
  };
  const slid = () => {
    if (sliding.current) settle(sliding.current);
    sliding.current = null;
  };

  // The stage's size.
  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () => {
      const r = element.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setStage({ width: r.width, height: r.height });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  // The photo before its layers, made again only when what it depends on changes.
  const baseKey = JSON.stringify([doc.turn, doc.flipX, doc.flipY, doc.angle, doc.adjust, doc.filter, doc.amount, doc.layers.filter((l) => l.kind === "censor")]);
  const base = useMemo(() => renderBase(preview, doc, work), [preview, baseKey]);

  // The view: the part shown of the photo, with its layers.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx) return;
    const w = Math.max(1, Math.round(view.width * work));
    const hgt = Math.max(1, Math.round(view.height * work));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== hgt) canvas.height = hgt;
    ctx.clearRect(0, 0, w, hgt);
    ctx.drawImage(base, view.x * work, view.y * work, view.width * work, view.height * work, 0, 0, w, hgt);
    // The text being typed shows in its box instead.
    drawLayers(canvas, doc.layers.filter((l) => l.id !== editing), work, view.x, view.y);
  }, [base, doc.layers, view.x, view.y, view.width, view.height, editing, work]);

  /** Where a pointer is, in the photo. */
  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current!.getBoundingClientRect();
    return [view.x + (e.clientX - r.left - left) / ds, view.y + (e.clientY - r.top - top) / ds];
  };

  // ---- Layers.
  const add = (layer: Layer) => {
    change((d) => ({ ...d, layers: [...d.layers, layer] }));
    setSelected(layer.id);
  };
  const remove = (id: string) => {
    change((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== id) }));
    if (selected === id) setSelected(null);
  };
  const raise = (id: string, step: 1 | -1) =>
    change((d) => {
      const i = d.layers.findIndex((l) => l.id === id);
      const j = i + step;
      if (i < 0 || j < 0 || j >= d.layers.length) return d;
      const layers = d.layers.slice();
      [layers[i], layers[j]] = [layers[j]!, layers[i]!];
      return { ...d, layers };
    });
  const copy = (id: string) => {
    const layer = doc.layers.find((l) => l.id === id);
    if (!layer) return;
    const twin = { ...moveLayer(layer, 24 / ds, 24 / ds), id: layerId() };
    add(twin);
  };

  /** The colour chosen: the chosen layer takes it too. */
  const pickColor = (c: string) => {
    setColor(c);
    if (!chosen) return;
    const recolor = (l: Layer): Layer =>
      l.kind === "text" ? { ...l, color: c } : l.kind === "shape" ? { ...l, stroke: c, fill: l.fill ? c : null } : l.kind === "brush" && l.mode !== "eraser" ? { ...l, color: c } : l;
    slide(setLayer(chosen.id, recolor));
  };
  // A colour put on a layer is kept in the history once the picking stops.
  useEffect(() => {
    if (!sliding.current) return;
    const timer = setTimeout(slid, 400);
    return () => clearTimeout(timer);
  }, [color]);

  // The chosen text's settings follow the bar.
  const setTextStyle = (patch: Partial<typeof type>) => {
    setType((now) => ({ ...now, ...patch }));
    if (chosen?.kind !== "text") return;
    const { outline, background, ...rest } = patch;
    change(
      setLayer(chosen.id, (l) =>
        l.kind !== "text"
          ? l
          : {
              ...l,
              ...rest,
              ...(outline === undefined ? {} : { outline: outline ? contrastOf(l.color) : null }),
              ...(background === undefined ? {} : { background: background ? "rgba(0, 0, 0, 0.55)" : null }),
            },
      ),
    );
  };

  // The text box takes the keys once it is open (opened when the click is over: a press would take its focus away).
  useEffect(() => {
    if (editing) typingRef.current?.focus();
  }, [editing]);

  // ---- Pointer on the stage.
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 1 || (e.button === 0 && activeTool === "hand")) {
      drag.current = { k: "pan", x: e.clientX, y: e.clientY, pan };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button !== 0 || editing) return;
    const p = at(e);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const start = h.now;
    switch (activeTool) {
      case "move": {
        if (chosen) {
          const handle = handleAt(chosen, p[0], p[1], measureText, ds);
          if (handle === "rotate") return void (drag.current = { k: "rotate", start, id: chosen.id });
          if (handle) return void (drag.current = { k: "resize", start, id: chosen.id, handle, last: p });
        }
        const hit = hitTest(doc.layers, p[0], p[1], measureText, 8 / ds);
        setSelected(hit?.id ?? null);
        if (hit) drag.current = { k: "move", start, id: hit.id, last: p };
        return;
      }
      case "brush":
      case "eraser": {
        const id = layerId();
        const layer: BrushLayer = {
          kind: "brush",
          id,
          opacity: activeTool === "eraser" ? 1 : brush.opacity / 100,
          mode: activeTool === "eraser" ? "eraser" : brush.mode,
          color,
          size: brush.size,
          softness: brush.softness,
          pts: [p[0], p[1]],
        };
        live((d) => ({ ...d, layers: [...d.layers, layer] }));
        drag.current = { k: "draw", start, id, last: p };
        return;
      }
      case "shape": {
        const id = layerId();
        const layer: ShapeLayer = { kind: "shape", id, opacity: shape.opacity / 100, shape: shape.shape, x1: p[0], y1: p[1], x2: p[0], y2: p[1], stroke: color, width: shape.width, fill: shape.fill ? color : null, rotation: 0 };
        live((d) => ({ ...d, layers: [...d.layers, layer] }));
        drag.current = { k: "box", start, id, a: p };
        return;
      }
      case "censor": {
        const id = layerId();
        live((d) => ({ ...d, layers: [...d.layers, { kind: "censor", id, opacity: 1, mode: censor, x: p[0], y: p[1], w: 0, h: 0 }] }));
        drag.current = { k: "box", start, id, a: p };
        return;
      }
      case "text":
        // The box opens when the click is over: the press itself would take its focus away.
        e.preventDefault();
        drag.current = { k: "text", start, at: p };
        return;
      case "picker": {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext?.("2d", { willReadFrequently: true });
        if (!canvas || !ctx) return;
        const px = Math.round((p[0] - view.x) * work);
        const py = Math.round((p[1] - view.y) * work);
        const [r, g, b] = ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, px)), Math.max(0, Math.min(canvas.height - 1, py)), 1, 1).data;
        const hex = `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
        setColor(hex);
        remember(hex);
        setTool(before.current === "picker" ? "brush" : before.current);
        return;
      }
      case "crop": {
        const rect = doc.crop ?? full;
        const handle = cropHandleAt(rect, p, ds);
        if (handle) drag.current = { k: "crop", start, handle, from: rect, a: p };
        return;
      }
      case "sticker":
        setPanel("stickers");
        return;
      default:
        return;
    }
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.k === "pan") {
      setPan([d.pan[0] + e.clientX - d.x, d.pan[1] + e.clientY - d.y]);
      return;
    }
    const p = at(e);
    if (d.k === "draw") {
      if (Math.hypot(p[0] - d.last[0], p[1] - d.last[1]) * ds < 1.5) return;
      d.last = p;
      live(setLayer(d.id, (l) => (l.kind === "brush" ? { ...l, pts: [...l.pts, p[0], p[1]] } : l)));
    } else if (d.k === "box") {
      let [bx, by] = p;
      if (e.shiftKey) {
        // Shift keeps a square, a circle, or a line at 45°.
        const dx = bx - d.a[0];
        const dy = by - d.a[1];
        const lineLike = shape.shape === "line" || shape.shape === "arrow";
        if (lineLike) {
          const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          const length = Math.hypot(dx, dy);
          bx = d.a[0] + Math.cos(angle) * length;
          by = d.a[1] + Math.sin(angle) * length;
        } else {
          const side = Math.max(Math.abs(dx), Math.abs(dy));
          bx = d.a[0] + Math.sign(dx || 1) * side;
          by = d.a[1] + Math.sign(dy || 1) * side;
        }
      }
      live(
        setLayer(d.id, (l) =>
          l.kind === "shape" ? { ...l, x2: bx, y2: by } : l.kind === "censor" ? { ...l, x: Math.min(d.a[0], bx), y: Math.min(d.a[1], by), w: Math.abs(bx - d.a[0]), h: Math.abs(by - d.a[1]) } : l,
        ),
      );
    } else if (d.k === "move") {
      const dx = p[0] - d.last[0];
      const dy = p[1] - d.last[1];
      d.last = p;
      live(setLayer(d.id, (l) => moveLayer(l, dx, dy)));
    } else if (d.k === "resize") {
      const dx = p[0] - d.last[0];
      const dy = p[1] - d.last[1];
      d.last = p;
      live(setLayer(d.id, (l) => resizeLayer(l, d.handle, dx, dy, measureText)));
    } else if (d.k === "rotate") {
      live(setLayer(d.id, (l) => turnLayer(l, p[0], p[1], measureText, e.shiftKey)));
    } else if (d.k === "crop") {
      live((doc) => ({ ...doc, crop: dragCrop(d.from, d.handle, p[0] - d.a[0], p[1] - d.a[1], full, aspectValue(aspect, doc)) }));
    }
  };

  /** A text at `p`: the one there to type in, or a new one. */
  const openText = (start: PhotoDoc, p: Point) => {
    const hit = hitTest(doc.layers, p[0], p[1], measureText, 6 / ds);
    sliding.current = start;
    if (hit?.kind === "text") {
      setSelected(hit.id);
      setEditing(hit.id);
      return;
    }
    const id = layerId();
    const size = Math.max(12, Math.round(Math.min(view.width, view.height) / 12));
    const layer: TextLayer = {
      kind: "text",
      id,
      opacity: 1,
      text: "",
      x: p[0],
      y: p[1] - size * 0.6,
      size,
      font: type.font,
      color,
      bold: type.bold,
      italic: type.italic,
      align: type.align,
      outline: type.outline ? contrastOf(color) : null,
      background: type.background ? "rgba(0, 0, 0, 0.55)" : null,
      rotation: 0,
    };
    live((d) => ({ ...d, layers: [...d.layers, layer] }));
    setSelected(id);
    setEditing(id);
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.k === "pan") return;
    if (d.k === "text") return openText(d.start, d.at);
    if (d.k === "draw" || d.k === "box") {
      // A shape too small to be one (a click) is not kept.
      const layer = h.now.layers.find((l) => l.id === d.id);
      const box = layer ? boundsOf(layer, measureText) : null;
      if (d.k === "box" && box && Math.max(box.w, box.h) * ds < 4) {
        setH((now) => ({ ...now, now: d.start }));
        return;
      }
      if (layer && layer.kind !== "censor" && !(layer.kind === "brush" && layer.mode === "eraser")) remember(color);
      if (d.k === "box") setSelected(d.id);
    }
    settle(d.start);
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const r = stageRef.current!.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.max(0.1, Math.min(MAX_ZOOM, zoom * factor));
    // The point under the pointer stays under it.
    const cx = e.clientX - r.left - stage.width / 2;
    const cy = e.clientY - r.top - stage.height / 2;
    const k = next / zoom;
    setPan([cx - (cx - pan[0]) * k, cy - (cy - pan[1]) * k]);
    setZoom(next);
  };
  const zoomBy = (factor: number) => setZoom((z) => Math.max(0.1, Math.min(MAX_ZOOM, z * factor)));
  const fitView = () => {
    setZoom(1);
    setPan([0, 0]);
  };

  // ---- The tool and the crop.
  const chooseTool = (next: PhotoTool) => {
    if (next === "picker") before.current = tool;
    if (next === "sticker") setPanel("stickers");
    if (next !== "move" && next !== "text") setSelected(null);
    setEditing(null);
    // The view changes between the whole photo (cropping) and the part kept.
    if (next === "crop" || tool === "crop") fitView();
    setTool(next);
  };
  const chooseAspect = (value: number | "free" | "photo") => {
    setAspect(value);
    const ratio = aspectValue(value, doc);
    change((d) => ({ ...d, crop: ratio === null ? d.crop : aspectCrop(ratio, oriented.width, oriented.height) }));
  };

  // ---- Keys, as photo editors have them.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1] ?? "";
    if (ctrl && letter === "Z") {
      e.preventDefault();
      setH((now) => (e.shiftKey ? redo(now) : undo(now)));
      return;
    }
    if (ctrl && letter === "Y") return (e.preventDefault(), setH(redo));
    if (ctrl && letter === "J" && chosen) return (e.preventDefault(), copy(chosen.id));
    if (ctrl && e.code === "BracketRight" && chosen) return (e.preventDefault(), raise(chosen.id, 1));
    if (ctrl && e.code === "BracketLeft" && chosen) return (e.preventDefault(), raise(chosen.id, -1));
    if (ctrl && e.code === "Digit0") return (e.preventDefault(), fitView());
    if (ctrl && e.code === "Digit1") return (e.preventDefault(), setZoom(1 / fit));
    if (ctrl && (e.code === "Equal" || e.code === "NumpadAdd")) return (e.preventDefault(), zoomBy(1.25));
    if (ctrl && (e.code === "Minus" || e.code === "NumpadSubtract")) return (e.preventDefault(), zoomBy(0.8));
    if (ctrl) return;
    if ((e.key === "Delete" || e.key === "Backspace") && chosen) return (e.preventDefault(), remove(chosen.id));
    if (e.key === "Escape") return void (tool === "crop" ? chooseTool("move") : setSelected(null));
    if (e.key === "Enter" && tool === "crop") return chooseTool("move");
    if (e.code === "Space") {
      e.preventDefault();
      setSpaceHand(true);
      return;
    }
    if (e.key.startsWith("Arrow") && chosen) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / ds;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as Point;
      change(setLayer(chosen.id, (l) => moveLayer(l, dx, dy)));
      return;
    }
    if (e.code === "BracketLeft") return setBrush((b) => ({ ...b, size: Math.max(1, Math.round(b.size * 0.85)) }));
    if (e.code === "BracketRight") return setBrush((b) => ({ ...b, size: Math.min(400, Math.round(b.size * 1.18) + 1) }));
    const next = PHOTO_TOOLS.find((t) => t.key === letter);
    if (next) chooseTool(next.tool);
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current(e);
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceHand(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ---- Done: the photo drawn whole from the photo itself.
  const finish = async () => {
    setBusy(true);
    setSelected(null);
    try {
      const out = outputOf(name);
      const canvas = renderDoc(picture, doc, 1);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, out.type, out.quality));
      if (!blob) throw new Error("Фото не сохранилось");
      onDone(new Uint8Array(await blob.arrayBuffer()), out.name);
    } finally {
      setBusy(false);
    }
  };

  // ---- What the stage shows over the photo: the chosen layer's box, the crop frame.
  const overlay = () => {
    if (tool === "crop") {
      const c = doc.crop ?? full;
      const r = 7 / ds;
      return (
        <g className="photo-crop">
          <path d={`M${full.x} ${full.y}h${full.width}v${full.height}h${-full.width}z M${c.x} ${c.y}v${c.height}h${c.width}v${-c.height}z`} className="photo-crop-shade" />
          <rect x={c.x} y={c.y} width={c.width} height={c.height} className="photo-crop-frame" strokeWidth={2 / ds} />
          {[1, 2].map((k) => (
            <g key={k} className="photo-crop-grid" strokeWidth={1 / ds}>
              <line x1={c.x + (c.width * k) / 3} y1={c.y} x2={c.x + (c.width * k) / 3} y2={c.y + c.height} />
              <line x1={c.x} y1={c.y + (c.height * k) / 3} x2={c.x + c.width} y2={c.y + (c.height * k) / 3} />
            </g>
          ))}
          {cropHandles(c).map(([key, x, y]) => (
            <rect key={key} x={x - r} y={y - r} width={r * 2} height={r * 2} className="photo-handle" strokeWidth={1.5 / ds} />
          ))}
        </g>
      );
    }
    if (!chosen || editing === chosen.id) return null;
    const b = boundsOf(chosen, measureText);
    const angle = rotationOf(chosen);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const r = 6 / ds;
    const handles = handlesOf(chosen, measureText, ds);
    return (
      <g transform={angle ? `rotate(${angle} ${cx} ${cy})` : undefined} className="photo-selection">
        {chosen.kind === "shape" && (chosen.shape === "line" || chosen.shape === "arrow") ? null : (
          <rect x={b.x} y={b.y} width={b.w} height={b.h} className="photo-selection-box" strokeWidth={1.5 / ds} strokeDasharray={`${5 / ds} ${4 / ds}`} />
        )}
        {handles.some(([k]) => k === "rotate") && <line x1={cx} y1={b.y} x2={cx} y2={b.y - 28 / ds} className="photo-selection-box" strokeWidth={1.5 / ds} />}
        {handles.map(([key, x, y]) =>
          key === "rotate" ? (
            <circle key={key} cx={x} cy={y} r={r * 1.1} className="photo-handle round" strokeWidth={1.5 / ds} />
          ) : (
            <rect key={key} x={x - r} y={y - r} width={r * 2} height={r * 2} className="photo-handle" strokeWidth={1.5 / ds} />
          ),
        )}
      </g>
    );
  };

  const editingLayer = doc.layers.find((l) => l.id === editing && l.kind === "text") as TextLayer | undefined;
  const finishTyping = () => {
    if (!editingLayer) return setEditing(null);
    const start = sliding.current;
    sliding.current = null;
    if (!editingLayer.text.trim()) {
      setH((now) => ({ ...now, now: start ?? { ...now.now, layers: now.now.layers.filter((l) => l.id !== editingLayer.id) } }));
      setSelected(null);
    } else {
      if (start) settle(start);
      remember(editingLayer.color);
    }
    setEditing(null);
  };

  const cursor = { move: "default", crop: "crosshair", brush: "crosshair", eraser: "crosshair", shape: "crosshair", text: "text", censor: "crosshair", picker: "copy", sticker: "default", hand: drag.current?.k === "pan" ? "grabbing" : "grab" }[activeTool];
  const sizeFor = activeTool === "brush" || activeTool === "eraser";

  return (
    <div className="photo-editor" role="dialog" aria-label="Редактор фото">
      <header className="photo-top">
        <button type="button" className="photo-button" onClick={onClose}>
          <X size={16} aria-hidden /> Отмена
        </button>
        <span className="photo-title">{name}</span>
        <div className="photo-row">
          <button type="button" className="photo-mini" aria-label="Назад" title="Назад (Ctrl+Z)" disabled={h.past.length === 0} onClick={() => setH(undo)}>
            <Undo2 size={16} aria-hidden />
          </button>
          <button type="button" className="photo-mini" aria-label="Вперёд" title="Вперёд (Ctrl+Shift+Z)" disabled={h.future.length === 0} onClick={() => setH(redo)}>
            <Redo2 size={16} aria-hidden />
          </button>
          <span className="photo-sep" />
          <button type="button" className="photo-mini" aria-label="Уменьшить" title="Уменьшить (Ctrl+−)" onClick={() => zoomBy(0.8)}>
            <ZoomOut size={16} aria-hidden />
          </button>
          <button type="button" className="photo-zoom" title="Масштаб: 100% (Ctrl+1)" onClick={() => setZoom(1 / fit)}>
            {Math.round(ds * 100)}%
          </button>
          <button type="button" className="photo-mini" aria-label="Увеличить" title="Увеличить (Ctrl++)" onClick={() => zoomBy(1.25)}>
            <ZoomIn size={16} aria-hidden />
          </button>
          <button type="button" className="photo-mini" aria-label="Вписать" title="Вписать в окно (Ctrl+0)" onClick={fitView}>
            <Maximize2 size={16} aria-hidden />
          </button>
        </div>
        <button type="button" className="photo-button primary" disabled={busy} onClick={() => void finish()}>
          {busy ? "Сохраняю…" : "Готово"}
        </button>
      </header>
      <div className="photo-options" role="toolbar" aria-label="Настройки инструмента">
        <b className="photo-options-name">{PHOTO_TOOLS.find((t) => t.tool === tool)?.name}</b>
        {(tool === "brush" || tool === "eraser") && (
          <>
            {tool === "brush" &&
              (["pen", "marker", "neon"] as const).map((mode) => (
                <button key={mode} type="button" className="photo-chip" aria-pressed={brush.mode === mode} onClick={() => setBrush((b) => ({ ...b, mode }))}>
                  {{ pen: "Обычная", marker: "Маркер", neon: "Неон" }[mode]}
                </button>
              ))}
            <Range label="Размер" value={brush.size} min={1} max={400} suffix=" px" onChange={(size) => setBrush((b) => ({ ...b, size }))} />
            <Range label="Мягкость" value={brush.softness} min={0} max={100} suffix="%" onChange={(softness) => setBrush((b) => ({ ...b, softness }))} />
            {tool === "brush" && <Range label="Непрозрачность" value={brush.opacity} min={5} max={100} suffix="%" onChange={(opacity) => setBrush((b) => ({ ...b, opacity }))} />}
            {tool === "eraser" && <span className="photo-hint">Стирает нарисованное, само фото не трогает</span>}
          </>
        )}
        {tool === "shape" && (
          <>
            {(
              [
                ["rect", Square, "Прямоугольник"],
                ["ellipse", Circle, "Эллипс"],
                ["line", Minus, "Линия"],
                ["arrow", MoveUpRight, "Стрелка"],
              ] as const
            ).map(([kind, Icon, title]) => (
              <button key={kind} type="button" className="photo-mini" aria-label={title} title={title} aria-pressed={shape.shape === kind} onClick={() => setShape((s) => ({ ...s, shape: kind }))}>
                <Icon size={16} aria-hidden />
              </button>
            ))}
            <Range
              label="Толщина"
              value={shape.width}
              min={0}
              max={80}
              suffix=" px"
              onChange={(width) => {
                setShape((s) => ({ ...s, width }));
                if (chosen?.kind === "shape") slide(setLayer(chosen.id, (l) => ({ ...l, width }) as Layer));
              }}
              onCommit={slid}
            />
            <label className="photo-check">
              <input
                type="checkbox"
                checked={chosen?.kind === "shape" ? chosen.fill !== null : shape.fill}
                onChange={(e) => {
                  const fill = e.currentTarget.checked;
                  setShape((s) => ({ ...s, fill }));
                  if (chosen?.kind === "shape") change(setLayer(chosen.id, (l) => ({ ...l, fill: fill ? color : null }) as Layer));
                }}
              />
              Заливка
            </label>
            <span className="photo-hint">Shift — ровный квадрат, круг или линия под 45°</span>
          </>
        )}
        {(tool === "text" || chosen?.kind === "text") && (
          <>
            <select className="photo-select" aria-label="Шрифт" value={chosen?.kind === "text" ? chosen.font : type.font} onChange={(e) => setTextStyle({ font: e.currentTarget.value })}>
              {FONTS.map((font) => (
                <option key={font} value={font} style={{ fontFamily: font }}>
                  {font}
                </option>
              ))}
            </select>
            {chosen?.kind === "text" && (
              <Range
                label="Размер"
                value={Math.round(chosen.size)}
                min={8}
                max={Math.max(400, Math.round(chosen.size))}
                suffix=" px"
                onChange={(size) => slide(setLayer(chosen.id, (l) => ({ ...l, size }) as Layer))}
                onCommit={slid}
              />
            )}
            <button type="button" className="photo-mini" aria-label="Жирный" title="Жирный" aria-pressed={chosen?.kind === "text" ? chosen.bold : type.bold} onClick={() => setTextStyle({ bold: !(chosen?.kind === "text" ? chosen.bold : type.bold) })}>
              <Bold size={16} aria-hidden />
            </button>
            <button type="button" className="photo-mini" aria-label="Курсив" title="Курсив" aria-pressed={chosen?.kind === "text" ? chosen.italic : type.italic} onClick={() => setTextStyle({ italic: !(chosen?.kind === "text" ? chosen.italic : type.italic) })}>
              <Italic size={16} aria-hidden />
            </button>
            {(
              [
                ["left", AlignLeft, "По левому краю"],
                ["center", AlignCenter, "По центру"],
                ["right", AlignRight, "По правому краю"],
              ] as const
            ).map(([align, Icon, title]) => (
              <button key={align} type="button" className="photo-mini" aria-label={title} title={title} aria-pressed={(chosen?.kind === "text" ? chosen.align : type.align) === align} onClick={() => setTextStyle({ align })}>
                <Icon size={16} aria-hidden />
              </button>
            ))}
            <label className="photo-check">
              <input type="checkbox" checked={chosen?.kind === "text" ? chosen.outline !== null : type.outline} onChange={(e) => setTextStyle({ outline: e.currentTarget.checked })} />
              Обводка
            </label>
            <label className="photo-check">
              <input type="checkbox" checked={chosen?.kind === "text" ? chosen.background !== null : type.background} onChange={(e) => setTextStyle({ background: e.currentTarget.checked })} />
              Подложка
            </label>
          </>
        )}
        {tool === "censor" && (
          <>
            {(["pixelate", "blur", "black"] as const).map((mode) => (
              <button key={mode} type="button" className="photo-chip" aria-pressed={censor === mode} onClick={() => setCensor(mode)}>
                {{ pixelate: "Квадраты", blur: "Размытие", black: "Чёрным" }[mode]}
              </button>
            ))}
            <span className="photo-hint">Обведи номер, адрес или лицо — прочитать потом нельзя</span>
          </>
        )}
        {tool === "crop" && (
          <>
            {ASPECTS.map((a) => (
              <button key={a.name} type="button" className="photo-chip" aria-pressed={aspect === a.value} onClick={() => chooseAspect(a.value)}>
                {a.name}
              </button>
            ))}
            <span className="photo-sep" />
            <button type="button" className="photo-mini" aria-label="Повернуть влево" title="Повернуть влево" onClick={() => change((d) => turnDoc(turnDoc(turnDoc(d, measureText), measureText), measureText))}>
              <RotateCcw size={16} aria-hidden />
            </button>
            <button type="button" className="photo-mini" aria-label="Повернуть вправо" title="Повернуть вправо" onClick={() => change((d) => turnDoc(d, measureText))}>
              <RotateCw size={16} aria-hidden />
            </button>
            <button type="button" className="photo-mini" aria-label="Отразить по горизонтали" title="Отразить по горизонтали" onClick={() => change((d) => flipDoc(d, "x", measureText))}>
              <FlipHorizontal2 size={16} aria-hidden />
            </button>
            <button type="button" className="photo-mini" aria-label="Отразить по вертикали" title="Отразить по вертикали" onClick={() => change((d) => flipDoc(d, "y", measureText))}>
              <FlipVertical2 size={16} aria-hidden />
            </button>
            <Range
              label="Выпрямить"
              value={doc.angle}
              min={-45}
              max={45}
              suffix="°"
              // From the photo as it was when the slider was taken: a hidden part grows once, not at every step.
              onChange={(angle) => slide((d) => straightenDoc(sliding.current ?? d, angle, measureText))}
              onCommit={slid}
            />
            <button type="button" className="photo-chip" disabled={!doc.crop && !doc.angle} onClick={() => change((d) => ({ ...straightenDoc(d, 0, measureText), crop: null }))}>
              Сбросить
            </button>
            <button type="button" className="photo-chip primary" onClick={() => chooseTool("move")}>
              Применить
            </button>
          </>
        )}
        {(tool === "move" || tool === "sticker") && !chosen && <span className="photo-hint">Нажми на слой, чтобы выбрать: тяни, чтобы двигать, за углы — менять размер, за кружок — поворачивать</span>}
        {chosen && tool !== "crop" && (
          <span className="photo-options-end">
            <button type="button" className="photo-chip" onClick={() => copy(chosen.id)}>
              Копия
            </button>
            <button type="button" className="photo-chip danger" onClick={() => remove(chosen.id)}>
              Удалить
            </button>
          </span>
        )}
      </div>
      <div className="photo-body">
        <nav className="photo-tools" aria-label="Инструменты">
          {PHOTO_TOOLS.map(({ tool: t, name: title, key, icon: Icon }) => (
            <button key={t} type="button" className="photo-tool" aria-pressed={tool === t} aria-label={title} title={`${title} (${key})`} onClick={() => chooseTool(t)}>
              <Icon size={19} aria-hidden />
            </button>
          ))}
          <span className="photo-tools-color" style={{ background: color }} title="Текущий цвет" aria-hidden />
        </nav>
        <div
          ref={stageRef}
          className="photo-stage"
          style={{ cursor }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={onWheel}
          onDoubleClick={(e) => {
            if (tool !== "move") return;
            const p = at(e);
            const hit = hitTest(doc.layers, p[0], p[1], measureText, 8 / ds);
            if (hit?.kind === "text") {
              sliding.current = h.now;
              setSelected(hit.id);
              setEditing(hit.id);
            }
          }}
        >
          <canvas ref={canvasRef} className="photo-canvas" style={{ left, top, width: cssW, height: cssH }} />
          <svg className="photo-overlay" style={{ left, top, width: cssW, height: cssH }} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} aria-hidden>
            {overlay()}
          </svg>
          {sizeFor && <BrushRing size={brush.size * ds} stage={stageRef} />}
          {editingLayer && (
            <textarea
              ref={typingRef}
              className="photo-typing"
              aria-label="Текст на фото"
              placeholder="Текст"
              value={editingLayer.text}
              rows={Math.max(1, editingLayer.text.split("\n").length)}
              style={{
                left: left + (editingLayer.x - view.x) * ds,
                top: top + (editingLayer.y - view.y) * ds,
                font: fontOf({ ...editingLayer, size: editingLayer.size * ds }),
                color: editingLayer.color,
                textAlign: editingLayer.align,
                minWidth: Math.max(80, editingLayer.size * ds * 2),
                transform: editingLayer.rotation ? `rotate(${editingLayer.rotation}deg)` : undefined,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const text = e.currentTarget.value.slice(0, 2000);
                live(setLayer(editingLayer.id, (l) => ({ ...l, text }) as Layer));
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
                  e.preventDefault();
                  finishTyping();
                }
              }}
              onBlur={finishTyping}
            />
          )}
        </div>
        <aside className="photo-side">
          <div className="photo-tabs" role="tablist" aria-label="Панели">
            {PANELS.map((p) => (
              <button key={p.id} type="button" role="tab" className="photo-tab" aria-selected={panel === p.id} onClick={() => setPanel(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
          {panel === "color" && <ColorPicker color={color} onChange={pickColor} recent={recent} onPick={() => chooseTool("picker")} />}
          {panel === "adjust" && <AdjustPanel adjust={doc.adjust} onChange={(adjust) => slide((d) => ({ ...d, adjust }))} onCommit={slid} />}
          {panel === "filters" && (
            <FiltersPanel
              picture={preview}
              filter={doc.filter}
              amount={doc.amount}
              onFilter={(filter) => slide((d) => ({ ...d, filter, amount: d.filter === filter ? d.amount : 100 }))}
              onAmount={(amount) => slide((d) => ({ ...d, amount }))}
              onCommit={slid}
            />
          )}
          {panel === "layers" && (
            <LayersPanel
              layers={doc.layers}
              selected={selected}
              actions={{
                onSelect: (id) => {
                  setSelected(id);
                  if (tool !== "text") setTool("move");
                },
                onHide: (id) => change(setLayer(id, (l) => ({ ...l, hidden: !l.hidden }))),
                onRaise: raise,
                onCopy: copy,
                onDelete: remove,
                onOpacity: (id, opacity) => slide(setLayer(id, (l) => ({ ...l, opacity }))),
                onCommit: slid,
              }}
            />
          )}
          {panel === "stickers" && (
            <StickersPanel
              onPut={(emoji) => {
                const size = Math.round(Math.min(view.width, view.height) / 4);
                add({ kind: "sticker", id: layerId(), opacity: 1, emoji, x: view.x + view.width / 2, y: view.y + view.height / 2, size, rotation: 0 });
                setTool("move");
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

/** A slider with its name and value, for the settings bar. */
function Range({ label, value, min, max, suffix, onChange, onCommit }: { label: string; value: number; min: number; max: number; suffix: string; onChange: (v: number) => void; onCommit?: () => void }) {
  return (
    <label className="photo-range">
      <span>{label}</span>
      <input type="range" min={min} max={max} value={value} aria-label={label} onChange={(e) => onChange(Number(e.currentTarget.value))} onPointerUp={onCommit} onKeyUp={onCommit} />
      <span className="photo-range-value">
        {value}
        {suffix}
      </span>
    </label>
  );
}

/** The brush's size, a ring over the pointer. */
function BrushRing({ size, stage }: { size: number; stage: React.RefObject<HTMLDivElement | null> }) {
  const ring = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const move = (e: PointerEvent) => {
      const r = element.getBoundingClientRect();
      if (ring.current) {
        ring.current.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`;
        ring.current.style.opacity = "1";
      }
    };
    const leave = () => ring.current && (ring.current.style.opacity = "0");
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
    };
  }, [stage]);
  return <div ref={ring} className="photo-ring" style={{ width: Math.max(4, size), height: Math.max(4, size) }} aria-hidden />;
}

/** Black or white, whichever stands out on `color` (a text's outline). */
export function contrastOf(color: string): string {
  const n = Number.parseInt(color.slice(1), 16) || 0;
  const light = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return light > 150 ? "#000000" : "#ffffff";
}

function aspectValue(value: number | "free" | "photo", doc: PhotoDoc): number | null {
  if (value === "free") return null;
  if (value === "photo") {
    const o = orientedSize(doc);
    return o.width / o.height;
  }
  return value;
}

function cropHandles(c: Rect): [CropHandle, number, number][] {
  return [
    ["nw", c.x, c.y],
    ["n", c.x + c.width / 2, c.y],
    ["ne", c.x + c.width, c.y],
    ["e", c.x + c.width, c.y + c.height / 2],
    ["se", c.x + c.width, c.y + c.height],
    ["s", c.x + c.width / 2, c.y + c.height],
    ["sw", c.x, c.y + c.height],
    ["w", c.x, c.y + c.height / 2],
  ];
}

/** The crop handle under a point (inside the frame: moving it). */
export function cropHandleAt(c: Rect, [x, y]: Point, scale: number): CropHandle | null {
  const reach = 12 / scale;
  for (const [handle, hx, hy] of cropHandles(c)) if (Math.abs(x - hx) <= reach && Math.abs(y - hy) <= reach) return handle;
  return x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height ? "move" : null;
}

/** The crop after its `handle` was dragged by (dx, dy): within the photo, of the shape asked for. */
export function dragCrop(from: Rect, handle: CropHandle, dx: number, dy: number, full: Rect, ratio: number | null): Rect {
  if (handle === "move") {
    return { ...from, x: Math.max(0, Math.min(full.width - from.width, from.x + dx)), y: Math.max(0, Math.min(full.height - from.height, from.y + dy)) };
  }
  let { x, y, width, height } = from;
  if (handle.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (handle.includes("e")) width += dx;
  if (handle.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (handle.includes("s")) height += dy;
  if (ratio) {
    // The side dragged sets the other.
    if (handle === "n" || handle === "s") width = height * ratio;
    else height = width / ratio;
    if (handle.includes("n")) y = from.y + from.height - height;
    if (handle.includes("w")) x = from.x + from.width - width;
  }
  return clampRect({ x, y, width, height }, full.width, full.height);
}
