import { describe, expect, it } from "vitest";
import {
  aspectCrop,
  boundsOf,
  clampRect,
  coverScale,
  handleAt,
  hitTest,
  history,
  moveLayer,
  newDoc,
  orientedSize,
  redo,
  record,
  resizeLayer,
  flipDoc,
  straightenDoc,
  turnDoc,
  undo,
  type Layer,
  type TextLayer,
} from "./doc";

const measure = (t: TextLayer) => ({ width: t.text.length * t.size * 0.5, height: t.size * 1.2 });
const rect = (over: Partial<Extract<Layer, { kind: "shape" }>> = {}): Layer => ({
  kind: "shape",
  id: "r",
  opacity: 1,
  shape: "rect",
  x1: 100,
  y1: 100,
  x2: 300,
  y2: 200,
  stroke: "#ff0000",
  width: 4,
  fill: null,
  rotation: 0,
  ...over,
});
const text = (over: Partial<TextLayer> = {}): TextLayer => ({
  kind: "text",
  id: "t",
  opacity: 1,
  text: "Привет",
  x: 50,
  y: 400,
  size: 40,
  font: "Manrope",
  color: "#ffffff",
  bold: true,
  italic: false,
  align: "left",
  outline: null,
  background: null,
  rotation: 0,
  ...over,
});

describe("the photo as a document", () => {
  it("turns: a quarter turn swaps the sides; straightening scales up so no corner shows empty", () => {
    const doc = newDoc(1200, 800);
    expect(orientedSize(doc)).toEqual({ width: 1200, height: 800 });
    expect(orientedSize({ ...doc, turn: 1 })).toEqual({ width: 800, height: 1200 });
    expect(coverScale(1200, 800, 0)).toBe(1);
    expect(coverScale(1200, 800, 10)).toBeGreaterThan(1.15);
    expect(coverScale(1200, 800, -10)).toBeCloseTo(coverScale(1200, 800, 10));
  });

  it("a crop stays within the photo, and a shape crop is the biggest in the middle", () => {
    expect(clampRect({ x: -10, y: 5, width: 5000, height: 50 }, 800, 600)).toEqual({ x: 0, y: 5, width: 800, height: 50 });
    expect(aspectCrop(1, 800, 600)).toEqual({ x: 100, y: 0, width: 600, height: 600 });
    expect(aspectCrop(null, 800, 600)).toBeNull();
  });

  it("finds the topmost layer under a point, never a hidden one, and inside a filled shape only", () => {
    const layers: Layer[] = [rect(), text(), rect({ id: "f", x1: 500, y1: 500, x2: 600, y2: 600, fill: "#00ff00" })];
    expect(hitTest(layers, 101, 150, measure, 6)?.id, "on the outline").toBe("r");
    expect(hitTest(layers, 200, 150, measure, 6), "inside an empty rectangle").toBeNull();
    expect(hitTest(layers, 550, 550, measure, 6)?.id, "inside a filled one").toBe("f");
    expect(hitTest(layers, 60, 420, measure, 6)?.id).toBe("t");
    expect(hitTest([{ ...text(), hidden: true }], 60, 420, measure, 6)).toBeNull();
    const turned = rect({ rotation: 90 });
    // Turned a quarter around its middle (200, 150): its left edge now runs along y = 50.
    expect(hitTest([turned], 200, 51, measure, 6)?.id).toBe("r");
  });

  it("moves any layer, and resizes a shape by its corner and a text by its size", () => {
    const moved = moveLayer(rect(), 10, -5) as Extract<Layer, { kind: "shape" }>;
    expect([moved.x1, moved.y1, moved.x2, moved.y2]).toEqual([110, 95, 310, 195]);
    const stroke: Layer = { kind: "brush", id: "b", opacity: 1, mode: "pen", color: "#000000", size: 4, softness: 0, pts: [1, 2, 3, 4] };
    expect((moveLayer(stroke, 1, 1) as { pts: number[] }).pts).toEqual([2, 3, 4, 5]);
    const bigger = resizeLayer(rect(), "se", 50, 20, measure) as Extract<Layer, { kind: "shape" }>;
    expect([bigger.x2, bigger.y2]).toEqual([350, 220]);
    const grown = resizeLayer(text(), "se", 0, 48, measure) as TextLayer;
    expect(grown.size).toBe(80);
  });

  it("knows which handle of the chosen layer is under the pointer", () => {
    const b = boundsOf(rect(), measure);
    expect(b).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(handleAt(rect(), 300, 200, measure, 1)).toBe("se");
    expect(handleAt(rect(), 200, 100 - 28, measure, 1)).toBe("rotate");
    expect(handleAt(rect(), 200, 150, measure, 1)).toBeNull();
  });

  it("keeps a history: back and forth, and a new change drops what was taken back", () => {
    let h = history(newDoc(10, 10));
    h = record(h, { ...h.now, filter: "bw" });
    h = record(h, { ...h.now, filter: "warm" });
    h = undo(h);
    expect(h.now.filter).toBe("bw");
    h = redo(h);
    expect(h.now.filter).toBe("warm");
    h = undo(undo(h));
    expect(h.now.filter).toBe("none");
    expect(undo(h)).toBe(h);
    h = record(h, { ...h.now, amount: 50 });
    expect(redo(h)).toBe(h);
  });

  it("a quarter turn or a flip takes the layers and the crop along", () => {
    const doc = { ...newDoc(400, 200), crop: { x: 0, y: 0, width: 100, height: 50 }, layers: [rect({ x1: 10, y1: 20, x2: 50, y2: 40 }), text({ x: 0, y: 0 })] };
    const turned = turnDoc(doc, measure);
    expect(turned.turn).toBe(1);
    const shape = turned.layers[0] as Extract<Layer, { kind: "shape" }>;
    // (x, y) in 400 × 200 goes to (200 − y, x) in 200 × 400.
    expect([Math.min(shape.x1, shape.x2), Math.min(shape.y1, shape.y2), Math.max(shape.x1, shape.x2), Math.max(shape.y1, shape.y2)]).toEqual([160, 10, 180, 50]);
    expect(turned.crop).toEqual({ x: 150, y: 0, width: 50, height: 100 });
    const t2 = turned.layers[1] as TextLayer;
    expect(t2.rotation).toBe(90);
    const flipped = flipDoc(doc, "x", measure);
    expect(flipped.flipX).toBe(true);
    const f = flipped.layers[0] as Extract<Layer, { kind: "shape" }>;
    expect([Math.min(f.x1, f.x2), Math.max(f.x1, f.x2)]).toEqual([350, 390]);
    expect(flipped.crop).toEqual({ x: 300, y: 0, width: 100, height: 50 });
  });

  it("straightening turns the layers with the photo, and a hidden part keeps covering what it hid", () => {
    const plate: Layer = { kind: "censor", id: "c", opacity: 1, mode: "pixelate", x: 100, y: 700, w: 300, h: 80 };
    const stroke: Layer = { kind: "brush", id: "b", opacity: 1, mode: "pen", color: "#000000", size: 4, softness: 0, pts: [800, 500, 900, 500] };
    const doc = { ...newDoc(1600, 1000), layers: [plate, stroke] };
    const straight = straightenDoc(doc, 12, measure);
    expect(straight.angle).toBe(12);
    // Where the photo's points go: turned 12° around the middle and scaled up to cover the frame.
    const k = coverScale(1600, 1000, 12);
    const a = (12 * Math.PI) / 180;
    const go = (x: number, y: number) => [800 + ((x - 800) * Math.cos(a) - (y - 500) * Math.sin(a)) * k, 500 + ((x - 800) * Math.sin(a) + (y - 500) * Math.cos(a)) * k];
    const hidden = straight.layers[0] as Extract<Layer, { kind: "censor" }>;
    for (const [x, y] of [
      [100, 700],
      [400, 700],
      [100, 780],
      [400, 780],
    ]) {
      const [gx, gy] = go(x!, y!);
      expect(gx! >= hidden.x - 0.01 && gx! <= hidden.x + hidden.w + 0.01 && gy! >= hidden.y - 0.01 && gy! <= hidden.y + hidden.h + 0.01, `corner ${x},${y}`).toBe(true);
    }
    const moved = straight.layers[1] as Extract<Layer, { kind: "brush" }>;
    expect(moved.pts[2]).toBeCloseTo(go(900, 500)[0]!);
    expect(moved.pts[3]).toBeCloseTo(go(900, 500)[1]!);
    const back = straightenDoc(straight, 0, measure);
    expect((back.layers[1] as typeof moved).pts[2]).toBeCloseTo(900);
  });
});
