import { describe, expect, it } from "vitest";
import { visiblePart } from "./viewBox";

const box = { x: 100, y: 50, width: 700, height: 420 };
const mine = "video box";

describe("where the site in the call goes", () => {
  it("over the whole video box while nothing of the program covers it", () => {
    expect(visiblePart(box, () => mine, (hit) => hit === mine)).toEqual(box);
  });

  it("above the call's buttons that float over the bottom of the box", () => {
    const part = visiblePart(box, (_x, y) => (y > 50 + 420 * 0.8 ? "dock" : mine), (hit) => hit === mine);
    expect(part).toEqual({ x: 100, y: 50, width: 700, height: 336 });
  });

  it("nowhere while a window or a menu is over its middle (a webview would cover them)", () => {
    expect(visiblePart(box, (_x, y) => (y > 120 && y < 400 ? "dialog" : mine), (hit) => hit === mine)).toBeNull();
    expect(visiblePart(box, () => null, (hit) => hit === mine), "out of sight").toBeNull();
    expect(visiblePart({ ...box, width: 0 }, () => mine, (hit) => hit === mine)).toBeNull();
  });
});
