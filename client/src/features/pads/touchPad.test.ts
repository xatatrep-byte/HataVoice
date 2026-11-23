import { describe, expect, it } from "vitest";
import { BUTTON } from "../../pads/state";
import { stickAt, touchPad } from "./TouchPad";

describe("the pad on a phone's screen", () => {
  it("keeps the stick inside its circle, up on the screen being up for the pad", () => {
    expect(stickAt(0, 0)).toEqual({ x: 0, y: 0 });
    expect(stickAt(23, 0)).toEqual({ x: 0.5, y: 0 });
    const far = stickAt(460, 0);
    expect(far.x).toBeCloseTo(1);
    const pad = touchPad({ buttons: 0, lt: false, rt: false, stick: { x: 0, y: -1 } });
    expect(pad.ly).toBe(32767);
    expect(touchPad({ buttons: 0, lt: false, rt: false, stick: { x: -1, y: 0 } }).lx).toBe(-32768);
  });

  it("holds keys and triggers as XInput has them, and nothing when let go", () => {
    const pad = touchPad({ buttons: BUTTON.A | BUTTON.LB, lt: true, rt: false, stick: null });
    expect(pad).toEqual({ buttons: BUTTON.A | BUTTON.LB, lt: 255, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
    expect(touchPad({ buttons: 0, lt: false, rt: false, stick: null })).toEqual({ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
  });
});
