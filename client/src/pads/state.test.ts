import { describe, expect, it } from "vitest";
import { BUTTON, firstPad, fromGamepad, fromKeys, NEUTRAL, padName, samePad } from "./state";

/** A pad of the Gamepad API with the standard mapping: buttons pressed by index, and the axes. */
function pad(pressed: Record<number, number> = {}, axes = [0, 0, 0, 0], mapping: GamepadMappingType = "standard") {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: (pressed[i] ?? 0) > 0.5, touched: false, value: pressed[i] ?? 0 }));
  return { id: "Xbox 360 Controller (XInput STANDARD GAMEPAD)", mapping, buttons, axes, connected: true } as unknown as Gamepad;
}

describe("a game pad as XInput has it", () => {
  it("maps the standard buttons, triggers and sticks, up being plus", () => {
    expect(fromGamepad(pad())).toEqual(NEUTRAL);
    const state = fromGamepad(pad({ 0: 1, 3: 1, 4: 1, 9: 1, 12: 1, 15: 1, 6: 0.5, 7: 1 }, [-1, -1, 0.5, 1]))!;
    expect(state.buttons).toBe(BUTTON.A | BUTTON.Y | BUTTON.LB | BUTTON.START | BUTTON.UP | BUTTON.RIGHT);
    expect([state.lt, state.rt]).toEqual([128, 255]);
    expect([state.lx, state.ly, state.rx, state.ry]).toEqual([-32768, 32767, 16384, -32768]);
  });

  it("never sends the Xbox button, and takes no pad without the standard mapping", () => {
    expect(fromGamepad(pad({ 16: 1 }))!.buttons).toBe(0);
    expect(fromGamepad(pad({ 0: 1 }, [0, 0, 0, 0], ""))).toBeNull();
  });

  it("finds the first usable pad and names it plainly", () => {
    expect(firstPad([null, pad({}, [0, 0, 0, 0], ""), pad()])?.mapping).toBe("standard");
    expect(firstPad([])).toBeNull();
    expect(padName(pad())).toBe("Xbox 360 Controller");
  });
});

describe("the keyboard as a pad", () => {
  it("has sticks on WASD and IJKL, the cross on the arrows, and the buttons around", () => {
    expect(fromKeys(new Set())).toEqual(NEUTRAL);
    const state = fromKeys(new Set(["KeyW", "KeyD", "KeyJ", "ArrowDown", "Space", "ShiftLeft", "KeyF", "KeyR", "KeyQ", "KeyE", "Digit1", "Digit3", "Enter", "Tab", "KeyC", "KeyV"]));
    expect(state.buttons).toBe(
      BUTTON.DOWN | BUTTON.A | BUTTON.B | BUTTON.X | BUTTON.Y | BUTTON.LB | BUTTON.RB | BUTTON.START | BUTTON.BACK | BUTTON.LTHUMB | BUTTON.RTHUMB,
    );
    expect([state.lx, state.ly, state.rx, state.ry, state.lt, state.rt]).toEqual([32767, 32767, -32768, 0, 255, 255]);
    expect(fromKeys(new Set(["KeyA", "KeyD"])).lx, "opposite keys cancel").toBe(0);
  });

  it("tells one state from another", () => {
    expect(samePad(NEUTRAL, { ...NEUTRAL })).toBe(true);
    expect(samePad(NEUTRAL, { ...NEUTRAL, ry: 1 })).toBe(false);
  });
});
