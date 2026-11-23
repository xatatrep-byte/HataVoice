/** One whole state of a game pad as XInput has it: buttons, triggers 0–255, sticks −32768…32767 (up is plus). */
export type PadState = { buttons: number; lt: number; rt: number; lx: number; ly: number; rx: number; ry: number };

export const NEUTRAL: PadState = { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };

export const BUTTON = {
  UP: 0x0001,
  DOWN: 0x0002,
  LEFT: 0x0004,
  RIGHT: 0x0008,
  START: 0x0010,
  BACK: 0x0020,
  LTHUMB: 0x0040,
  RTHUMB: 0x0080,
  LB: 0x0100,
  RB: 0x0200,
  A: 0x1000,
  B: 0x2000,
  X: 0x4000,
  Y: 0x8000,
} as const;

/** The standard mapping's buttons by index; 6 and 7 are the triggers, 16 the Xbox button, which never goes out. */
const STANDARD: (number | null)[] = [
  BUTTON.A,
  BUTTON.B,
  BUTTON.X,
  BUTTON.Y,
  BUTTON.LB,
  BUTTON.RB,
  null,
  null,
  BUTTON.BACK,
  BUTTON.START,
  BUTTON.LTHUMB,
  BUTTON.RTHUMB,
  BUTTON.UP,
  BUTTON.DOWN,
  BUTTON.LEFT,
  BUTTON.RIGHT,
];

const axis = (v: number | undefined) => {
  const x = Math.max(-1, Math.min(1, v ?? 0));
  // `|| 0`: no -0 from a stick at rest.
  return (x < 0 ? Math.round(x * 32768) : Math.round(x * 32767)) || 0;
};
const trigger = (button: GamepadButton | undefined) => Math.round(Math.max(0, Math.min(1, button?.value ?? 0)) * 255);

/** What a pad of the Gamepad API holds now; null for one without the standard mapping (we would not know its buttons). */
export function fromGamepad(pad: Pick<Gamepad, "mapping" | "buttons" | "axes">): PadState | null {
  if (pad.mapping !== "standard") return null;
  let buttons = 0;
  STANDARD.forEach((bit, i) => {
    if (bit !== null && pad.buttons[i]?.pressed) buttons |= bit;
  });
  const [lx, ly, rx, ry] = pad.axes;
  return { buttons, lt: trigger(pad.buttons[6]), rt: trigger(pad.buttons[7]), lx: axis(lx), ly: axis(-(ly ?? 0)), rx: axis(rx), ry: axis(-(ry ?? 0)) };
}

/** The first pad we can read. */
export function firstPad(pads: readonly (Gamepad | null)[]): Gamepad | null {
  return pads.find((p): p is Gamepad => !!p && p.connected !== false && p.mapping === "standard") ?? null;
}

/** «Xbox 360 Controller (XInput STANDARD GAMEPAD)» → «Xbox 360 Controller». */
export function padName(pad: Pick<Gamepad, "id">): string {
  return pad.id.replace(/\s*\(.*$/, "").trim() || "Геймпад";
}

/** The keyboard as a pad: which key presses which button (`KeyboardEvent.code`). */
const KEY_BUTTONS: Record<string, number> = {
  ArrowUp: BUTTON.UP,
  ArrowDown: BUTTON.DOWN,
  ArrowLeft: BUTTON.LEFT,
  ArrowRight: BUTTON.RIGHT,
  Space: BUTTON.A,
  ShiftLeft: BUTTON.B,
  ShiftRight: BUTTON.B,
  KeyF: BUTTON.X,
  KeyR: BUTTON.Y,
  KeyQ: BUTTON.LB,
  KeyE: BUTTON.RB,
  Enter: BUTTON.START,
  Tab: BUTTON.BACK,
  KeyC: BUTTON.LTHUMB,
  KeyV: BUTTON.RTHUMB,
};
const STICK_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyI", "KeyJ", "KeyK", "KeyL"];
const TRIGGER_KEYS = ["Digit1", "Digit3"];

/** The keys the keyboard pad takes (the others stay the page's). */
export function isPadKey(code: string): boolean {
  return code in KEY_BUTTONS || STICK_KEYS.includes(code) || TRIGGER_KEYS.includes(code);
}

/** The layout as the person reads it. */
export const KEY_LAYOUT = "Стик: WASD. Второй стик: IJKL. Крестовина: стрелки. A: Пробел, B: Shift, X: F, Y: R, LB/RB: Q/E, LT/RT: 1/3, Start: Enter, Back: Tab";

/** The pad that the keys held down make. */
export function fromKeys(held: ReadonlySet<string>): PadState {
  let buttons = 0;
  for (const code of held) buttons |= KEY_BUTTONS[code] ?? 0;
  const stick = (plus: string, minus: string) => (held.has(plus) ? 32767 : 0) + (held.has(minus) ? -32768 : 0) + (held.has(plus) && held.has(minus) ? 1 : 0);
  return {
    buttons,
    lt: held.has("Digit1") ? 255 : 0,
    rt: held.has("Digit3") ? 255 : 0,
    lx: stick("KeyD", "KeyA"),
    ly: stick("KeyW", "KeyS"),
    rx: stick("KeyL", "KeyJ"),
    ry: stick("KeyI", "KeyK"),
  };
}

export function samePad(a: PadState, b: PadState): boolean {
  return a.buttons === b.buttons && a.lt === b.lt && a.rt === b.rt && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx && a.ry === b.ry;
}
