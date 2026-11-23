import { describe, expect, it, vi } from "vitest";
import type { RemoteInput } from "./api";
import { LOCK_TAP_MS, ModifierLatch, pressCombo } from "./modifiers";
import { DOUBLE_TAP_MS, MAX_ZOOM, padGain, PAD_SCROLL_PX, TouchpadControl } from "./touchpad";

function pad() {
  const sent: RemoteInput[] = [];
  const onAction = vi.fn();
  // The picture shown 1000×500 px: a slow finger across it is the PC's whole width.
  const control = new TouchpadControl(() => ({ width: 1000, height: 500 }), (input) => void sent.push(input), () => {}, onAction);
  return { control, sent, onAction };
}

const buttons = (sent: RemoteInput[]) => sent.filter((s) => s.t === "button").map((s) => (s.t === "button" ? `${s.b}${s.down ? "↓" : "↑"}` : ""));

describe("the phone as a touchpad", () => {
  it("moves the arrow by the finger's way from wherever it touches, slowly one to one", () => {
    const { control, sent } = pad();
    control.down(1, 900, 400, 0);
    // 200 px right over 1 s: slow, no acceleration.
    for (let i = 1; i <= 20; i++) control.move(1, 900 + i * 10, 400, i * 50);
    control.up(1, 1100);
    expect(control.cursor.x).toBeCloseTo(32767.5 + 0.2 * 65535, -2);
    expect(control.cursor.y).toBeCloseTo(32767.5, 0);
    expect(buttons(sent), "a move is no click").toEqual([]);
    expect(sent[sent.length - 1]).toMatchObject({ t: "move" });
  });

  it("goes further for a quick move, and never off the screen", () => {
    expect(padGain(0.1)).toBe(1);
    expect(padGain(2)).toBeGreaterThan(2.5);
    const { control } = pad();
    control.down(1, 0, 0, 0);
    control.move(1, 5000, 5000, 10);
    expect(control.cursor).toEqual({ x: 65535, y: 65535 });
  });

  it("clicks where the arrow is on a tap, wherever the finger is", () => {
    const { control, sent, onAction } = pad();
    control.down(1, 10, 10, 0);
    control.up(1, 120);
    expect(buttons(sent)).toEqual(["left↓", "left↑"]);
    expect(sent[0]).toEqual({ t: "move", x: 32768, y: 32768 });
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("drags after a tap and a finger moved, and lets go when it lifts", () => {
    const { control, sent } = pad();
    control.down(1, 100, 100, 0);
    control.up(1, 100);
    control.down(1, 100, 100, 100 + DOUBLE_TAP_MS / 2);
    control.move(1, 160, 100, 400);
    control.move(1, 220, 100, 500);
    control.up(1, 600);
    expect(buttons(sent)).toEqual(["left↓", "left↑", "left↓", "left↑"]);
  });

  it("right-clicks on a tap of two fingers, scrolls with two moved, zooms with two spread", () => {
    const { control, sent } = pad();
    control.down(1, 100, 100, 0);
    control.down(2, 200, 100, 10);
    control.up(2, 120);
    control.up(1, 130);
    expect(buttons(sent)).toEqual(["right↓", "right↑"]);

    sent.length = 0;
    control.down(1, 100, 300, 1000);
    control.down(2, 200, 300, 1000);
    control.move(1, 100, 300 - PAD_SCROLL_PX * 2, 1100);
    control.move(2, 200, 300 - PAD_SCROLL_PX * 2, 1100);
    control.up(1, 1200);
    control.up(2, 1200);
    expect(sent.filter((s) => s.t === "wheel").reduce((sum, s) => sum + (s.t === "wheel" ? s.dy : 0), 0)).toBe(-240);
    expect(buttons(sent), "a scroll is no right click").toEqual([]);

    control.down(1, 400, 200, 2000);
    control.down(2, 500, 200, 2000);
    control.move(2, 700, 200, 2100);
    expect(control.zoom).toBeCloseTo(3, 5);
    control.move(2, 2000, 200, 2200);
    expect(control.zoom).toBe(MAX_ZOOM);
    control.up(1, 2300);
    control.up(2, 2300);
  });

  it("holds the left button for the «Держать» button, scrolls one finger with «Колесо», and lets everything go on cancel", () => {
    const { control, sent } = pad();
    control.toggleHold();
    control.toggleWheel();
    control.down(1, 100, 300, 0);
    control.move(1, 100, 300 + PAD_SCROLL_PX, 100);
    control.cancel();
    expect(buttons(sent)).toEqual(["left↓", "left↑"]);
    expect(sent.some((s) => s.t === "wheel" && s.dy === 120)).toBe(true);
    expect(control.holding).toBe(false);
  });

  it("moves the arrow less for the same finger when the picture is zoomed in", () => {
    const { control } = pad();
    control.stepZoom();
    expect(control.zoom).toBe(2);
    control.down(1, 0, 0, 0);
    control.move(1, 100, 0, 1000);
    expect(control.cursor.x - 32767.5).toBeCloseTo(0.05 * 65535, -1);
  });
});

describe("Ctrl, Alt, Shift and Win from a phone", () => {
  const latch = () => {
    const sent: RemoteInput[] = [];
    return { sent, control: new ModifierLatch((input) => void sent.push(input)) };
  };
  const keys = (sent: RemoteInput[]) => sent.map((s) => (s.t === "key" ? `${s.code}${s.down ? "↓" : "↑"}` : s.t));

  it("holds one for the next key and lets it go after", () => {
    const { control, sent } = latch();
    control.tap("ControlLeft", 0);
    expect(control.state.ControlLeft).toBe("once");
    control.after();
    expect(keys(sent)).toEqual(["ControlLeft↓", "ControlLeft↑"]);
    expect(control.state.ControlLeft).toBe("off");
  });

  it("keeps one held after two quick taps, until it is tapped again", () => {
    const { control, sent } = latch();
    control.tap("ShiftLeft", 0);
    control.tap("ShiftLeft", LOCK_TAP_MS / 2);
    control.after();
    expect(control.state.ShiftLeft).toBe("locked");
    control.tap("ShiftLeft", 5000);
    expect(keys(sent)).toEqual(["ShiftLeft↓", "ShiftLeft↑"]);
  });

  it("a second slow tap lets it go, and closing lets every one go", () => {
    const { control, sent } = latch();
    control.tap("AltLeft", 0);
    control.tap("AltLeft", 2000);
    expect(control.state.AltLeft).toBe("off");
    control.tap("MetaLeft", 3000);
    control.tap("ControlLeft", 3100);
    control.releaseAll();
    expect(keys(sent)).toEqual(["AltLeft↓", "AltLeft↑", "MetaLeft↓", "ControlLeft↓", "ControlLeft↑", "MetaLeft↑"]);
  });

  it("presses a combination in order", () => {
    const sent: RemoteInput[] = [];
    pressCombo((input) => void sent.push(input), ["ControlLeft", "ShiftLeft"], "Escape");
    expect(keys(sent)).toEqual(["ControlLeft↓", "ShiftLeft↓", "Escape↓", "Escape↑", "ShiftLeft↑", "ControlLeft↑"]);
  });
});
