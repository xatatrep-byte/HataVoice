import { describe, expect, it } from "vitest";
import { applyPixels, effectiveAdjust, FILTERS, NO_ADJUST, sharpen, type Adjust } from "./pixels";

/** A picture of `w` × `h` of one colour. */
const flat = (w: number, h: number, [r, g, b]: [number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  return data;
};
const at = (data: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
const run = (data: Uint8ClampedArray, w: number, h: number, change: Partial<Adjust>, filter = "none", amount = 100) =>
  applyPixels(data, w, h, effectiveAdjust({ ...NO_ADJUST, ...change }, filter, amount), filter, amount, 1);

describe("the photo's corrections, pixel by pixel", () => {
  it("leave a photo alone when nothing is changed", () => {
    const data = flat(4, 4, [120, 60, 200]);
    run(data, 4, 4, {});
    expect(at(data, 4, 1, 1)).toEqual([120, 60, 200, 255]);
  });

  it("exposure lightens, temperature warms, saturation −100 makes it grey", () => {
    const light = flat(2, 2, [100, 100, 100]);
    run(light, 2, 2, { exposure: 50 });
    expect(at(light, 2, 0, 0)[0]).toBeGreaterThan(180);
    const warm = flat(2, 2, [128, 128, 128]);
    run(warm, 2, 2, { temperature: 60 });
    const [r, , b] = at(warm, 2, 0, 0);
    expect(r!).toBeGreaterThan(128);
    expect(b!).toBeLessThan(128);
    const grey = flat(2, 2, [200, 40, 90]);
    run(grey, 2, 2, { saturation: -100 });
    const [gr, gg, gb] = at(grey, 2, 0, 0);
    expect(new Set([gr, gg, gb]).size).toBe(1);
  });

  it("a vignette darkens the corners, not the middle", () => {
    const data = flat(21, 21, [200, 200, 200]);
    run(data, 21, 21, { vignette: 80 });
    expect(at(data, 21, 10, 10)[0]).toBe(200);
    expect(at(data, 21, 0, 0)[0]!).toBeLessThan(150);
  });

  it("grain is the same every time for the same photo, and keeps its transparency", () => {
    const one = flat(8, 8, [128, 128, 128]);
    one[3] = 10;
    const two = flat(8, 8, [128, 128, 128]);
    two[3] = 10;
    run(one, 8, 8, { grain: 60 });
    run(two, 8, 8, { grain: 60 });
    expect(Array.from(one)).toEqual(Array.from(two));
    expect(one[3]).toBe(10);
    expect(new Set(Array.from(one.filter((_, i) => i % 4 === 0))).size).toBeGreaterThan(3);
  });

  it("each filter changes the photo, by its amount; the black-and-white one leaves no colour", () => {
    expect(FILTERS.length).toBeGreaterThanOrEqual(12);
    for (const filter of FILTERS.filter((f) => f.id !== "none")) {
      const data = flat(6, 6, [180, 90, 60]);
      run(data, 6, 6, {}, filter.id);
      expect(at(data, 6, 3, 3), filter.id).not.toEqual([180, 90, 60, 255]);
    }
    const bw = flat(2, 2, [180, 90, 60]);
    run(bw, 2, 2, {}, "bw");
    const [r, g, b] = at(bw, 2, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
    const none = flat(2, 2, [180, 90, 60]);
    run(none, 2, 2, {}, "bw", 0);
    expect(at(none, 2, 0, 0)).toEqual([180, 90, 60, 255]);
  });

  it("sharpening leaves a flat photo flat and makes an edge stand out", () => {
    const plain = flat(5, 5, [100, 100, 100]);
    sharpen(plain, 5, 5, 80);
    expect(at(plain, 5, 2, 2)).toEqual([100, 100, 100, 255]);
    const edge = flat(6, 3, [50, 50, 50]);
    for (let y = 0; y < 3; y++) for (let x = 3; x < 6; x++) edge.set([200, 200, 200, 255], (y * 6 + x) * 4);
    sharpen(edge, 6, 3, 100);
    expect(at(edge, 6, 3, 1)[0]!).toBeGreaterThan(200);
    expect(at(edge, 6, 2, 1)[0]!).toBeLessThan(50);
  });
});
