/**
 * Ctrl, Alt, Shift and Win from a phone, which has none: a tap holds one down for the next key or click and lets it go
 * after (Ctrl, then C: Ctrl+C); two quick taps keep it held until it is tapped again (Ctrl+clicks, Shift+arrows). Pure.
 */
import type { RemoteInput } from "./api";

export const MODIFIERS = [
  { code: "ControlLeft", label: "Ctrl" },
  { code: "AltLeft", label: "Alt" },
  { code: "ShiftLeft", label: "Shift" },
  { code: "MetaLeft", label: "Win" },
] as const;

export type ModifierCode = (typeof MODIFIERS)[number]["code"];
export type Latch = "off" | "once" | "locked";
/** Two taps this close keep a modifier held. */
export const LOCK_TAP_MS = 400;

type Send = (input: RemoteInput, lossy: boolean) => void;

export class ModifierLatch {
  readonly state: Record<ModifierCode, Latch> = { ControlLeft: "off", AltLeft: "off", ShiftLeft: "off", MetaLeft: "off" };
  private tappedAt: Partial<Record<ModifierCode, number>> = {};

  constructor(
    private readonly send: Send,
    private readonly onChange: () => void = () => {},
  ) {}

  private key(code: ModifierCode, down: boolean) {
    this.send({ t: "key", code, down }, false);
  }

  tap(code: ModifierCode, now: number) {
    const was = this.state[code];
    const quick = now - (this.tappedAt[code] ?? Number.NEGATIVE_INFINITY) < LOCK_TAP_MS;
    this.tappedAt[code] = now;
    if (was === "off") {
      this.state[code] = "once";
      this.key(code, true);
    } else if (was === "once" && quick) {
      this.state[code] = "locked";
    } else {
      this.state[code] = "off";
      this.key(code, false);
    }
    this.onChange();
  }

  /** A key or a click was done with the modifiers held: those held for it alone are let go. */
  after() {
    let changed = false;
    for (const { code } of MODIFIERS) {
      if (this.state[code] !== "once") continue;
      this.state[code] = "off";
      this.key(code, false);
      changed = true;
    }
    if (changed) this.onChange();
  }

  /** Control ended or the keyboard closed: nothing stays held on the friend's PC. */
  releaseAll() {
    for (const { code } of MODIFIERS) {
      if (this.state[code] === "off") continue;
      this.state[code] = "off";
      this.key(code, false);
    }
    this.onChange();
  }
}

/** A combination pressed at once (Ctrl+C, Alt+Tab): the modifiers down, the key, the modifiers up, in that order. */
export function pressCombo(send: Send, modifiers: readonly ModifierCode[], code: string) {
  for (const m of modifiers) send({ t: "key", code: m, down: true }, false);
  send({ t: "key", code, down: true }, false);
  send({ t: "key", code, down: false }, false);
  for (const m of [...modifiers].reverse()) send({ t: "key", code: m, down: false }, false);
}
