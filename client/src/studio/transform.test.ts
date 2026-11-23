import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK, type StudioSource } from "./layout";
import { centered, dragHold, holdAt, nudge, type Hold } from "./transform";

const frame = { width: 1920, height: 1080 };
const src = (id: string, rect: StudioSource["rect"], extra: Partial<StudioSource> = {}): StudioSource => ({ id, kind: "image", name: id, rect, visible: true, look: DEFAULT_LOOK, ...extra });
const opts = { frame, snap: 12, free: false };

describe("moving and stretching on the preview", () => {
  const logo = src("logo", { x: 100, y: 100, width: 200, height: 100 });
  const back = src("back", { x: 0, y: 0, width: 1920, height: 1080 });

  it("takes a handle of the chosen source, or the topmost source under the press", () => {
    expect(holdAt([back, logo], "logo", { x: 300, y: 200 }, 16)?.hold?.part).toBe("se");
    expect(holdAt([back, logo], "logo", { x: 200, y: 98 }, 16)?.hold?.part).toBe("n");
    expect(holdAt([back, logo], null, { x: 150, y: 150 }, 16)).toMatchObject({ id: "logo", hold: { part: "move" } });
    expect(holdAt([back, logo], "logo", { x: 1000, y: 900 }, 16)).toMatchObject({ id: "back", hold: { part: "move" } });
  });

  it("chooses a locked source but does not move it", () => {
    const locked = src("locked", { x: 100, y: 100, width: 200, height: 100 }, { locked: true });
    expect(holdAt([locked], null, { x: 150, y: 150 }, 16)).toEqual({ id: "locked", hold: null });
    expect(holdAt([locked], "locked", { x: 300, y: 200 }, 16)).toEqual({ id: "locked", hold: null });
  });

  it("moves, and sticks to the frame's edges and middle", () => {
    const hold: Hold = { id: "logo", part: "move", start: { x: 150, y: 150 }, rect: logo.rect };
    expect(dragHold(hold, { x: 250, y: 170 }, opts)).toEqual({ x: 200, y: 120, width: 200, height: 100 });
    // Within 12 px of the left edge: on it.
    expect(dragHold(hold, { x: 57, y: 150 }, opts).x).toBe(0);
    // Its middle near the frame's middle: centred.
    expect(dragHold(hold, { x: 150 + 760 + 5, y: 150 }, opts).x).toBe(860);
  });

  it("stretches by a corner keeping the shape, freely with Shift, and by a side one way", () => {
    const corner: Hold = { id: "logo", part: "se", start: { x: 300, y: 200 }, rect: logo.rect };
    expect(dragHold(corner, { x: 500, y: 210 }, opts)).toEqual({ x: 100, y: 100, width: 400, height: 200 });
    expect(dragHold(corner, { x: 500, y: 210 }, { ...opts, free: true })).toEqual({ x: 100, y: 100, width: 400, height: 110 });
    const nw: Hold = { id: "logo", part: "nw", start: { x: 100, y: 100 }, rect: logo.rect };
    expect(dragHold(nw, { x: 0, y: 100 }, opts)).toEqual({ x: 0, y: 50, width: 300, height: 150 });
    const side: Hold = { id: "logo", part: "e", start: { x: 300, y: 150 }, rect: logo.rect };
    expect(dragHold(side, { x: 400, y: 600 }, opts)).toEqual({ x: 100, y: 100, width: 300, height: 100 });
  });

  it("never makes a source smaller than the least, nor turns it inside out", () => {
    const side: Hold = { id: "logo", part: "w", start: { x: 100, y: 150 }, rect: logo.rect };
    expect(dragHold(side, { x: 900, y: 150 }, opts)).toEqual({ x: 268, y: 100, width: 32, height: 100 });
  });

  it("nudges with the arrows and centres", () => {
    expect(nudge(logo.rect, "ArrowRight", false)).toEqual({ ...logo.rect, x: 101 });
    expect(nudge(logo.rect, "ArrowUp", true)).toEqual({ ...logo.rect, y: 90 });
    expect(nudge(logo.rect, "Enter", false)).toBeNull();
    expect(centered(logo.rect, frame)).toEqual({ x: 860, y: 490, width: 200, height: 100 });
  });
});
