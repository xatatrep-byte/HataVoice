import { describe, expect, it } from "vitest";
import { mouseButton, sendableKey, videoPoint, wheelUnits } from "./capture";

describe("remote control capture", () => {
  it("finds the point on the picture, not on the bars around it", () => {
    // A 16:9 picture in a square element: bars above and below.
    const box = { left: 100, top: 50, width: 400, height: 400 };
    expect(videoPoint(box, 1920, 1080, 100, 137.5)).toEqual({ x: 0, y: 0 });
    expect(videoPoint(box, 1920, 1080, 500, 362.5)).toEqual({ x: 65535, y: 65535 });
    expect(videoPoint(box, 1920, 1080, 300, 250)).toEqual({ x: 32768, y: 32768 });
    expect(videoPoint(box, 1920, 1080, 300, 60), "over the bar").toBeNull();
    expect(videoPoint(box, 0, 0, 300, 250), "no picture yet").toBeNull();
  });

  it("turns the wheel into Windows steps, down being negative", () => {
    expect(wheelUnits(100, 0)).toBe(-120);
    expect(wheelUnits(-100, 0)).toBe(120);
    expect(wheelUnits(3, 1)).toBe(-120);
    expect(wheelUnits(1, 2)).toBe(-360);
    expect(wheelUnits(100_000, 0)).toBe(-1200);
  });

  it("knows the buttons and keys it sends", () => {
    expect([0, 1, 2, 3].map(mouseButton)).toEqual(["left", "middle", "right", null]);
    expect(sendableKey("KeyA")).toBe(true);
    expect(sendableKey("ArrowUp")).toBe(true);
    expect(sendableKey("Unidentified")).toBe(false);
    expect(sendableKey("")).toBe(false);
  });
});
