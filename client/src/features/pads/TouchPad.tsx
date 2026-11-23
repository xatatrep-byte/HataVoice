import { useEffect, useRef, useState } from "react";
import { BUTTON, NEUTRAL, type PadState } from "../../pads/state";

type Props = { onChange: (state: PadState | null) => void };

/** The finger stays this key's while it is down, wherever it slides (a finger the browser no longer knows is let be). */
function hold(e: React.PointerEvent) {
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  } catch {
    // Not a live pointer any more: the key still works, it only loses the finger that slides off.
  }
}

/** How far the stick's knob goes from its centre, px. */
const STICK_RADIUS = 46;

type Held = { buttons: number; lt: boolean; rt: boolean; stick: { x: number; y: number } | null };

/** The pad that the held keys and the stick make. */
export function touchPad(held: Held): PadState {
  const axis = (v: number) => (v < 0 ? Math.round(v * 32768) : Math.round(v * 32767)) || 0;
  return {
    ...NEUTRAL,
    buttons: held.buttons,
    lt: held.lt ? 255 : 0,
    rt: held.rt ? 255 : 0,
    lx: held.stick ? axis(held.stick.x) : 0,
    // Up on the screen is up for the pad (plus in XInput).
    ly: held.stick ? axis(-held.stick.y) : 0,
  };
}

/** The stick as a point within its circle: -1…1 each way, never outside. */
export function stickAt(dx: number, dy: number, radius = STICK_RADIUS): { x: number; y: number } {
  const length = Math.hypot(dx, dy);
  const scale = length > radius ? radius / length : 1;
  return { x: (dx * scale) / radius, y: (dy * scale) / radius };
}

const FACE: { bit: number; label: string; className: string }[] = [
  { bit: BUTTON.Y, label: "Y", className: "pad-y" },
  { bit: BUTTON.X, label: "X", className: "pad-x" },
  { bit: BUTTON.B, label: "B", className: "pad-b" },
  { bit: BUTTON.A, label: "A", className: "pad-a" },
];
const CROSS: { bit: number; label: string; className: string }[] = [
  { bit: BUTTON.UP, label: "Вверх", className: "pad-up" },
  { bit: BUTTON.LEFT, label: "Влево", className: "pad-left" },
  { bit: BUTTON.RIGHT, label: "Вправо", className: "pad-right" },
  { bit: BUTTON.DOWN, label: "Вниз", className: "pad-down" },
];

/**
 * A game pad on the phone's screen for playing on a friend's PC: a stick, the cross, A B X Y, the shoulders and the
 * triggers, Back and Start. Every key is held while a finger is on it (several at once). A real pad joined to the phone
 * (Bluetooth or USB) goes first, as on a PC.
 */
export function TouchPad({ onChange }: Props) {
  const [held, setHeld] = useState<Held>({ buttons: 0, lt: false, rt: false, stick: null });
  const stickBase = useRef<{ id: number; x: number; y: number } | null>(null);
  const report = useRef(onChange);
  report.current = onChange;

  useEffect(() => report.current(touchPad(held)), [held]);
  // Gone (play ended, the phone turned): nothing stays held on the friend's PC.
  useEffect(() => () => report.current(null), []);

  const key = (bit: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      hold(e);
      setHeld((h) => ({ ...h, buttons: h.buttons | bit }));
    },
    onPointerUp: () => setHeld((h) => ({ ...h, buttons: h.buttons & ~bit })),
    onPointerCancel: () => setHeld((h) => ({ ...h, buttons: h.buttons & ~bit })),
  });
  const trigger = (side: "lt" | "rt") => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      hold(e);
      setHeld((h) => ({ ...h, [side]: true }));
    },
    onPointerUp: () => setHeld((h) => ({ ...h, [side]: false })),
    onPointerCancel: () => setHeld((h) => ({ ...h, [side]: false })),
  });
  const knob = held.stick ? { transform: `translate(${held.stick.x * STICK_RADIUS}px, ${held.stick.y * STICK_RADIUS}px)` } : undefined;

  return (
    <div className="touch-pad" aria-label="Геймпад на экране" onContextMenu={(e) => e.preventDefault()}>
      <div className="touch-pad-top">
        <button type="button" className="pad-key pad-shoulder" aria-label="LT" {...trigger("lt")}>LT</button>
        <button type="button" className="pad-key pad-shoulder" aria-label="LB" {...key(BUTTON.LB)}>LB</button>
        <button type="button" className="pad-key pad-small" aria-label="Back" {...key(BUTTON.BACK)}>⧉</button>
        <button type="button" className="pad-key pad-small" aria-label="Start" {...key(BUTTON.START)}>☰</button>
        <button type="button" className="pad-key pad-shoulder" aria-label="RB" {...key(BUTTON.RB)}>RB</button>
        <button type="button" className="pad-key pad-shoulder" aria-label="RT" {...trigger("rt")}>RT</button>
      </div>
      <div className="touch-pad-left">
        <div
          className="pad-stick"
          role="slider"
          aria-label="Стик"
          aria-valuenow={held.stick ? Math.round(held.stick.x * 100) : 0}
          onPointerDown={(e) => {
            e.preventDefault();
            hold(e);
            const box = e.currentTarget.getBoundingClientRect();
            stickBase.current = { id: e.pointerId, x: box.left + box.width / 2, y: box.top + box.height / 2 };
            setHeld((h) => ({ ...h, stick: stickAt(e.clientX - stickBase.current!.x, e.clientY - stickBase.current!.y) }));
          }}
          onPointerMove={(e) => {
            const base = stickBase.current;
            if (!base || base.id !== e.pointerId) return;
            setHeld((h) => ({ ...h, stick: stickAt(e.clientX - base.x, e.clientY - base.y) }));
          }}
          onPointerUp={() => {
            stickBase.current = null;
            setHeld((h) => ({ ...h, stick: null }));
          }}
          onPointerCancel={() => {
            stickBase.current = null;
            setHeld((h) => ({ ...h, stick: null }));
          }}
        >
          <span className="pad-knob" style={knob} />
        </div>
        <div className="pad-cross">
          {CROSS.map((k) => (
            <button key={k.className} type="button" className={`pad-key ${k.className}`} aria-label={k.label} {...key(k.bit)} />
          ))}
        </div>
      </div>
      <div className="touch-pad-right">
        {FACE.map((k) => (
          <button key={k.className} type="button" className={`pad-key pad-face ${k.className}`} aria-label={k.label} {...key(k.bit)}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
