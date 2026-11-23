/**
 * Controlling a friend's PC with a finger, on a phone: the picture is the screen under the finger. A tap is a click; a
 * finger moved is a drag with the left button down; a finger held still is a right click; two fingers scroll, and two
 * fingers tapped together are a right click too. Pure, so it is tested without a call or a screen.
 */
import type { RemoteInput } from "./api";

/** A finger that moved less than this is still a tap, px. */
export const TAP_SLOP_PX = 12;
/** A finger held this long without moving is a right click, ms. */
export const LONG_PRESS_MS = 550;
/** Two fingers moved this far scroll one wheel step, px. */
export const SCROLL_STEP_PX = 36;
/** Two fingers lifted this soon without scrolling are a right click, ms. */
export const TWO_TAP_MS = 350;

type Point = { x: number; y: number };
type Finger = { start: Point; now: Point };
type Send = (input: RemoteInput, lossy: boolean) => void;
/** A point of the page as a point of the picture (0–65535), or null off the picture. */
type ToPicture = (clientX: number, clientY: number) => { x: number; y: number } | null;

export class TouchControl {
  private readonly fingers = new Map<number, Finger>();
  private mode: "none" | "pending" | "drag" | "scroll" | "held" = "none";
  private startedAt = 0;
  private scrolled = 0;
  private scrollFrom = 0;

  constructor(
    private readonly toPicture: ToPicture,
    private readonly send: Send,
  ) {}

  private click(at: Point, button: "left" | "right") {
    const point = this.toPicture(at.x, at.y);
    if (!point) return;
    this.send({ t: "move", ...point }, false);
    this.send({ t: "button", b: button, down: true }, false);
    this.send({ t: "button", b: button, down: false }, false);
  }

  private middle(): number {
    let y = 0;
    for (const f of this.fingers.values()) y += f.now.y;
    return y / Math.max(1, this.fingers.size);
  }

  down(id: number, x: number, y: number, now: number) {
    this.fingers.set(id, { start: { x, y }, now: { x, y } });
    if (this.fingers.size === 1) {
      this.mode = "pending";
      this.startedAt = now;
      return;
    }
    if (this.fingers.size === 2) {
      // A drag that had begun lets go before scrolling.
      if (this.mode === "drag") this.send({ t: "button", b: "left", down: false }, false);
      this.mode = "scroll";
      this.scrolled = 0;
      this.scrollFrom = this.middle();
      this.startedAt = now;
    }
  }

  move(id: number, x: number, y: number) {
    const finger = this.fingers.get(id);
    if (!finger) return;
    finger.now = { x, y };
    if (this.mode === "pending" && Math.hypot(x - finger.start.x, y - finger.start.y) > TAP_SLOP_PX) {
      const from = this.toPicture(finger.start.x, finger.start.y);
      if (!from) return;
      this.mode = "drag";
      this.send({ t: "move", ...from }, false);
      this.send({ t: "button", b: "left", down: true }, false);
    }
    if (this.mode === "drag") {
      const point = this.toPicture(x, y);
      if (point) this.send({ t: "move", ...point }, true);
    } else if (this.mode === "scroll") {
      const travelled = this.middle() - this.scrollFrom;
      const steps = Math.trunc(travelled / SCROLL_STEP_PX);
      if (steps !== 0) {
        // Fingers going up move the page up, as on a phone: the wheel turns down (negative in Windows' units).
        this.send({ t: "wheel", dx: 0, dy: steps * 120 }, false);
        this.scrollFrom += steps * SCROLL_STEP_PX;
        this.scrolled += Math.abs(steps);
      }
    }
  }

  up(id: number, now: number) {
    const finger = this.fingers.get(id);
    if (!finger) return;
    this.fingers.delete(id);
    if (this.mode === "pending" && this.fingers.size === 0) this.click(finger.start, "left");
    else if (this.mode === "drag" && this.fingers.size === 0) {
      const point = this.toPicture(finger.now.x, finger.now.y);
      if (point) this.send({ t: "move", ...point }, false);
      this.send({ t: "button", b: "left", down: false }, false);
    } else if (this.mode === "scroll" && this.fingers.size === 1 && this.scrolled === 0 && now - this.startedAt < TWO_TAP_MS) {
      this.click(finger.start, "right");
      this.mode = "held";
    }
    if (this.fingers.size === 0) this.mode = "none";
  }

  /** Called a while after a finger came down: still there and still, it is a right click. */
  hold(now: number) {
    if (this.mode !== "pending" || this.fingers.size !== 1 || now - this.startedAt < LONG_PRESS_MS) return;
    const finger = [...this.fingers.values()][0]!;
    this.click(finger.start, "right");
    this.mode = "held";
  }

  /** The touch was taken away (the system's gesture, the control ended): nothing stays pressed. */
  cancel() {
    if (this.mode === "drag") this.send({ t: "button", b: "left", down: false }, false);
    this.fingers.clear();
    this.mode = "none";
  }
}

const LETTERS_RU = "йцукенгшщзхъфывапролджэячсмитьбюё";
const CODES_RU = [
  "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight",
  "KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote",
  "KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Backquote",
];
const PLAIN: Record<string, string> = {
  " ": "Space", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon",
  "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote", "\n": "Enter", "\t": "Tab",
};
const SHIFTED: Record<string, string> = {
  "!": "Digit1", "@": "Digit2", "#": "Digit3", $: "Digit4", "%": "Digit5", "^": "Digit6", "&": "Digit7", "*": "Digit8",
  "(": "Digit9", ")": "Digit0", _: "Minus", "+": "Equal", "{": "BracketLeft", "}": "BracketRight", "|": "Backslash",
  ":": "Semicolon", '"': "Quote", "<": "Comma", ">": "Period", "?": "Slash", "~": "Backquote",
};

/**
 * The key that types `char` on a PC: its physical place (a Latin letter on an English layout, a Cyrillic one on a
 * Russian layout, as the friend's PC has it switched), and whether Shift is held. Null for what no key types.
 */
export function keyFor(char: string): { code: string; shift: boolean } | null {
  if (/^[a-z]$/.test(char)) return { code: `Key${char.toUpperCase()}`, shift: false };
  if (/^[A-Z]$/.test(char)) return { code: `Key${char}`, shift: true };
  if (/^[0-9]$/.test(char)) return { code: `Digit${char}`, shift: false };
  if (PLAIN[char]) return { code: PLAIN[char], shift: false };
  if (SHIFTED[char]) return { code: SHIFTED[char], shift: true };
  const lower = char.toLowerCase();
  const at = LETTERS_RU.indexOf(lower);
  if (at >= 0 && lower.length === 1) return { code: CODES_RU[at]!, shift: lower !== char };
  return null;
}

/** The presses that type `text` on the friend's PC, one key down and up after another. */
export function typeText(text: string): RemoteInput[] {
  const out: RemoteInput[] = [];
  for (const char of text) {
    const key = keyFor(char);
    if (!key) continue;
    if (key.shift) out.push({ t: "key", code: "ShiftLeft", down: true });
    out.push({ t: "key", code: key.code, down: true }, { t: "key", code: key.code, down: false });
    if (key.shift) out.push({ t: "key", code: "ShiftLeft", down: false });
  }
  return out;
}
