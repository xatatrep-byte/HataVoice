/**
 * Controlling a friend's PC from a phone like a laptop's touchpad: the whole picture is the pad, and our arrow, drawn on
 * the picture, is where the friend's goes. One finger moves it from wherever it touches (a quick move goes further, a slow
 * one is precise); a tap clicks where the arrow is; a tap and then a finger moved drags; two fingers tapped together are a
 * right click; two fingers moved up or down scroll; two fingers spread or pinched zoom the picture. The bar's buttons do
 * the same for one who does not know the gestures: a click of either button, the wheel under one finger, the left button
 * held. Pure: tested without a call or a screen.
 */
import type { RemoteInput } from "./api";

/** A finger that moved less than this is still a tap, px. */
export const PAD_SLOP_PX = 10;
/** A tap is quicker than this, ms. */
export const PAD_TAP_MS = 300;
/** A finger down this soon after a tap, then moved, drags, ms. */
export const DOUBLE_TAP_MS = 320;
/** Two fingers (or one, with the wheel on) moved this far scroll one wheel step, px. */
export const PAD_SCROLL_PX = 28;
/** Two fingers lifted this soon without scrolling or zooming are a right click, ms. */
export const PAD_TWO_TAP_MS = 350;
/** Two fingers whose distance changed by this part zoom rather than scroll. */
export const PINCH_START = 0.18;
export const MAX_ZOOM = 4;
/** The whole picture, as the PC counts it. */
const FULL = 65535;

type Send = (input: RemoteInput, lossy: boolean) => void;
type Point = { x: number; y: number };
type Finger = { start: Point; last: Point; lastAt: number };
/** The picture as shown now, CSS px: a finger crossing it moves the arrow across the PC's screen (at slow speed). */
export type Shown = () => { width: number; height: number };

/** How much further than the finger the arrow goes, by the finger's speed (px a millisecond). */
export function padGain(speed: number): number {
  return 1 + Math.min(2.2, Math.max(0, (speed - 0.25) * 1.8));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class TouchpadControl {
  /** Where our arrow is: parts of the picture, 0–65535. */
  cursor: Point = { x: FULL / 2, y: FULL / 2 };
  zoom = 1;
  /** «Держать»: the left button held down until let go. */
  holding = false;
  /** «Колесо»: one finger scrolls instead of moving the arrow. */
  wheel = false;
  private readonly fingers = new Map<number, Finger>();
  private mode: "none" | "pending" | "move" | "drag" | "two" | "scroll" | "pinch" | "wheel" = "none";
  private startedAt = 0;
  private lastTapAt = Number.NEGATIVE_INFINITY;
  private armed = false;
  private two = { distance: 0, middle: 0, zoom: 1, scrolled: 0 };
  private wheelFrom = 0;

  constructor(
    private readonly shown: Shown,
    private readonly send: Send,
    /** The arrow moved or the picture zoomed: draw them. */
    private readonly onChange: () => void = () => {},
    /** A click or a drag was done: one-shot modifier keys let go (see `ModifierLatch`). */
    private readonly onAction: () => void = () => {},
  ) {}

  private distance(): number {
    const [a, b] = [...this.fingers.values()];
    return a && b ? Math.hypot(a.last.x - b.last.x, a.last.y - b.last.y) : 0;
  }

  private middleY(): number {
    let y = 0;
    for (const f of this.fingers.values()) y += f.last.y;
    return y / Math.max(1, this.fingers.size);
  }

  /** The arrow moved by the finger's `dx`, `dy` px, at the finger's `speed` (px a millisecond). */
  private moveBy(dx: number, dy: number, speed: number) {
    const { width, height } = this.shown();
    if (width <= 0 || height <= 0) return;
    const gain = padGain(speed) / this.zoom;
    this.cursor = {
      x: clamp(this.cursor.x + (dx / width) * FULL * gain, 0, FULL),
      y: clamp(this.cursor.y + (dy / height) * FULL * gain, 0, FULL),
    };
    this.send({ t: "move", x: Math.round(this.cursor.x), y: Math.round(this.cursor.y) }, true);
    this.onChange();
  }

  private at(): RemoteInput {
    return { t: "move", x: Math.round(this.cursor.x), y: Math.round(this.cursor.y) };
  }

  /** A click of `button` where the arrow is. */
  click(button: "left" | "right") {
    this.send(this.at(), false);
    this.send({ t: "button", b: button, down: true }, false);
    this.send({ t: "button", b: button, down: false }, false);
    this.onAction();
  }

  /** «Держать»: the left button down until this is called again (dragging with the arrow, a slider, a selection). */
  toggleHold() {
    this.holding = !this.holding;
    this.send(this.at(), false);
    this.send({ t: "button", b: "left", down: this.holding }, false);
    if (!this.holding) this.onAction();
    this.onChange();
  }

  toggleWheel() {
    this.wheel = !this.wheel;
    this.onChange();
  }

  /** The zoom buttons: 1×, 2×, 3×, then back. */
  stepZoom() {
    this.zoom = this.zoom >= 3 ? 1 : Math.floor(this.zoom) + 1;
    this.onChange();
  }

  down(id: number, x: number, y: number, now: number) {
    this.fingers.set(id, { start: { x, y }, last: { x, y }, lastAt: now });
    if (this.fingers.size === 1) {
      this.mode = this.wheel ? "wheel" : "pending";
      this.wheelFrom = y;
      this.startedAt = now;
      this.armed = now - this.lastTapAt < DOUBLE_TAP_MS;
      return;
    }
    if (this.fingers.size === 2) {
      // A drag that had begun lets go before two fingers take over.
      if (this.mode === "drag") this.send({ t: "button", b: "left", down: false }, false);
      this.mode = "two";
      this.two = { distance: this.distance(), middle: this.middleY(), zoom: this.zoom, scrolled: 0 };
      this.startedAt = now;
    }
  }

  move(id: number, x: number, y: number, now: number) {
    const finger = this.fingers.get(id);
    if (!finger) return;
    let dx = x - finger.last.x;
    let dy = y - finger.last.y;
    const speed = Math.hypot(dx, dy) / Math.max(1, now - finger.lastAt);
    finger.last = { x, y };
    finger.lastAt = now;
    if (this.mode === "pending" && Math.hypot(x - finger.start.x, y - finger.start.y) > PAD_SLOP_PX) {
      // The way inside the tap's slop counts too: the arrow follows the finger with no dead start.
      dx = x - finger.start.x;
      dy = y - finger.start.y;
      if (this.armed) {
        this.mode = "drag";
        this.send(this.at(), false);
        this.send({ t: "button", b: "left", down: true }, false);
      } else this.mode = "move";
    }
    if (this.mode === "move" || this.mode === "drag") this.moveBy(dx, dy, speed);
    else if (this.mode === "wheel") this.scroll(y - this.wheelFrom, (steps) => (this.wheelFrom += steps * PAD_SCROLL_PX));
    else if (this.mode === "two" || this.mode === "scroll" || this.mode === "pinch") {
      const ratio = this.two.distance > 0 ? this.distance() / this.two.distance : 1;
      if (this.mode !== "scroll" && (this.mode === "pinch" || Math.abs(ratio - 1) > PINCH_START)) {
        this.mode = "pinch";
        this.zoom = clamp(this.two.zoom * ratio, 1, MAX_ZOOM);
        this.onChange();
        return;
      }
      const travelled = this.middleY() - this.two.middle;
      if (this.mode === "scroll" || Math.abs(travelled) >= PAD_SCROLL_PX) {
        this.mode = "scroll";
        this.scroll(travelled, (steps) => {
          this.two.middle += steps * PAD_SCROLL_PX;
          this.two.scrolled += Math.abs(steps);
        });
      }
    }
  }

  /** Wheel steps for `travelled` px (fingers going up move the page up, as on a phone); `took` hears how many went. */
  private scroll(travelled: number, took: (steps: number) => void) {
    const steps = Math.trunc(travelled / PAD_SCROLL_PX);
    if (steps === 0) return;
    this.send({ t: "wheel", dx: 0, dy: steps * 120 }, false);
    took(steps);
  }

  up(id: number, now: number) {
    const finger = this.fingers.get(id);
    if (!finger) return;
    this.fingers.delete(id);
    if (this.mode === "pending" && this.fingers.size === 0 && now - this.startedAt < PAD_TAP_MS) {
      this.click("left");
      this.lastTapAt = now;
    } else if (this.mode === "drag" && this.fingers.size === 0) {
      this.send({ t: "button", b: "left", down: false }, false);
      this.onAction();
    } else if (this.mode === "two" && this.fingers.size === 1 && now - this.startedAt < PAD_TWO_TAP_MS) {
      this.click("right");
    }
    if (this.fingers.size === 0) this.mode = "none";
    // One finger left of two goes on moving the arrow, not tapping.
    else if (this.mode === "two" || this.mode === "scroll" || this.mode === "pinch") this.mode = "move";
  }

  /** The touch was taken away (the system's gesture, the control ended): nothing stays pressed. */
  cancel() {
    if (this.mode === "drag" || this.holding) this.send({ t: "button", b: "left", down: false }, false);
    this.holding = false;
    this.fingers.clear();
    this.mode = "none";
  }
}
