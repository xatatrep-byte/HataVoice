import { describe, expect, it } from "vitest";
import type { RemoteInput } from "./api";
import { keyFor, LONG_PRESS_MS, SCROLL_STEP_PX, TouchControl, typeText } from "./touch";

const last = <T,>(list: T[]): T | undefined => list[list.length - 1];

/** The page is the picture, 1000×1000 px from the top left: a point is its px × 65.535. */
function control() {
  const sent: { input: RemoteInput; lossy: boolean }[] = [];
  const touch = new TouchControl(
    (x, y) => (x < 0 || y < 0 || x > 1000 || y > 1000 ? null : { x: Math.round(x * 65.535), y: Math.round(y * 65.535) }),
    (input, lossy) => sent.push({ input, lossy }),
  );
  return { touch, sent, inputs: () => sent.map((s) => s.input) };
}

describe("controlling a PC with a finger", () => {
  it("a tap is a left click where the finger came down", () => {
    const { touch, inputs } = control();
    touch.down(1, 100, 200, 0);
    touch.move(1, 104, 203);
    touch.up(1, 120);
    expect(inputs()).toEqual([
      { t: "move", x: 6554, y: 13107 },
      { t: "button", b: "left", down: true },
      { t: "button", b: "left", down: false },
    ]);
  });

  it("a finger moved drags with the left button down, the moves as lossy as a mouse's", () => {
    const { touch, sent, inputs } = control();
    touch.down(1, 100, 100, 0);
    touch.move(1, 150, 100);
    touch.move(1, 200, 100);
    touch.up(1, 300);
    expect(inputs()[0]).toEqual({ t: "move", x: 6554, y: 6554 });
    expect(inputs()[1]).toEqual({ t: "button", b: "left", down: true });
    expect(sent.filter((s) => s.lossy).map((s) => s.input)).toEqual([
      { t: "move", x: 9830, y: 6554 },
      { t: "move", x: 13107, y: 6554 },
    ]);
    expect(last(inputs())).toEqual({ t: "button", b: "left", down: false });
  });

  it("a finger held still is a right click, and lifting it does nothing more", () => {
    const { touch, inputs } = control();
    touch.down(1, 500, 500, 0);
    touch.hold(LONG_PRESS_MS - 1);
    expect(inputs()).toEqual([]);
    touch.hold(LONG_PRESS_MS);
    touch.up(1, LONG_PRESS_MS + 200);
    expect(inputs()).toEqual([
      { t: "move", x: 32768, y: 32768 },
      { t: "button", b: "right", down: true },
      { t: "button", b: "right", down: false },
    ]);
  });

  it("two fingers scroll, up the page turning the wheel down as on a phone", () => {
    const { touch, inputs } = control();
    touch.down(1, 400, 500, 0);
    touch.down(2, 600, 500, 10);
    touch.move(1, 400, 500 - 2 * SCROLL_STEP_PX);
    touch.move(2, 600, 500 - 2 * SCROLL_STEP_PX);
    touch.up(1, 400);
    touch.up(2, 410);
    const wheel = inputs().filter((i) => i.t === "wheel");
    expect(wheel.reduce((sum, w) => sum + (w.t === "wheel" ? w.dy : 0), 0)).toBe(-240);
    expect(inputs().some((i) => i.t === "button")).toBe(false);
  });

  it("two fingers tapped together are a right click", () => {
    const { touch, inputs } = control();
    touch.down(1, 300, 300, 0);
    touch.down(2, 340, 300, 20);
    touch.up(2, 120);
    touch.up(1, 130);
    expect(inputs()).toEqual([
      { t: "move", x: 22282, y: 19661 },
      { t: "button", b: "right", down: true },
      { t: "button", b: "right", down: false },
    ]);
  });

  it("a second finger during a drag lets the button go, and a cancel leaves nothing pressed", () => {
    const { touch, inputs } = control();
    touch.down(1, 100, 100, 0);
    touch.move(1, 200, 100);
    touch.down(2, 300, 300, 50);
    expect(last(inputs())).toEqual({ t: "button", b: "left", down: false });
    const again = control();
    again.touch.down(1, 100, 100, 0);
    again.touch.move(1, 200, 100);
    again.touch.cancel();
    expect(last(again.inputs())).toEqual({ t: "button", b: "left", down: false });
  });

  it("a tap off the picture (on the bars) clicks nothing", () => {
    const { touch, inputs } = control();
    touch.down(1, -5, 100, 0);
    touch.up(1, 50);
    expect(inputs()).toEqual([]);
  });
});

describe("typing on a friend's PC from the phone's keyboard", () => {
  it("finds the key of a letter, a digit, a sign, a Cyrillic letter", () => {
    expect(keyFor("a")).toEqual({ code: "KeyA", shift: false });
    expect(keyFor("Q")).toEqual({ code: "KeyQ", shift: true });
    expect(keyFor("7")).toEqual({ code: "Digit7", shift: false });
    expect(keyFor("?")).toEqual({ code: "Slash", shift: true });
    expect(keyFor(" ")).toEqual({ code: "Space", shift: false });
    expect(keyFor("й")).toEqual({ code: "KeyQ", shift: false });
    expect(keyFor("Ж")).toEqual({ code: "Semicolon", shift: true });
    expect(keyFor("ё")).toEqual({ code: "Backquote", shift: false });
    expect(keyFor("😀")).toBeNull();
  });

  it("presses Shift around a capital and nothing for what no key types", () => {
    expect(typeText("Hi😀")).toEqual([
      { t: "key", code: "ShiftLeft", down: true },
      { t: "key", code: "KeyH", down: true },
      { t: "key", code: "KeyH", down: false },
      { t: "key", code: "ShiftLeft", down: false },
      { t: "key", code: "KeyI", down: true },
      { t: "key", code: "KeyI", down: false },
    ]);
  });
});
