import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { hexToHsv, hsvToHex, parseHex, type Hsv } from "../theme/color";

/** Colors to start from: the accents of the themes and a few more. */
export const PRESET_COLORS = [
  "#ff8a4c", "#ff5c8a", "#f06262", "#ffb547", "#ffd54a", "#a6e35a", "#3ecf8e", "#19a9a1",
  "#4cc3ff", "#5b8cff", "#8b6cff", "#c06cff", "#e0528f", "#ffffff", "#9aa0ad", "#14121f",
];

type Props = {
  /** What the picker is for, said to screen readers and shown above it. */
  label: string;
  value: string;
  onChange: (hex: string) => void;
};

const clamp = (x: number) => Math.min(1, Math.max(0, x));

/** A color picker like Photoshop's: a square of saturation and brightness, a strip of hue, HEX, presets. */
export function ColorPicker({ label, value, onChange }: Props) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [text, setText] = useState(value);
  const square = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);

  // A color set from outside: follow it, keeping the hue where grey would lose it.
  useEffect(() => {
    setText(value);
    setHsv((now) => {
      if (hsvToHex(now) === value) return now;
      const next = hexToHsv(value);
      return next.s === 0 || next.v === 0 ? { ...next, h: now.h } : next;
    });
  }, [value]);

  function pick(next: Hsv) {
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex);
    onChange(hex);
  }

  const fromSquare = (e: PointerEvent) => {
    const box = square.current!.getBoundingClientRect();
    pick({ h: hsv.h, s: clamp((e.clientX - box.left) / box.width), v: clamp(1 - (e.clientY - box.top) / box.height) });
  };
  const fromStrip = (e: PointerEvent) => {
    const box = strip.current!.getBoundingClientRect();
    pick({ ...hsv, h: clamp((e.clientX - box.left) / box.width) * 359.9 });
  };
  const drag = (move: (e: PointerEvent) => void) => ({
    onPointerDown: (e: PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      move(e);
    },
    onPointerMove: (e: PointerEvent) => {
      if (e.buttons & 1) move(e);
    },
  });

  const squareKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, Partial<Hsv>> = {
      ArrowLeft: { s: clamp(hsv.s - step) },
      ArrowRight: { s: clamp(hsv.s + step) },
      ArrowUp: { v: clamp(hsv.v + step) },
      ArrowDown: { v: clamp(hsv.v - step) },
    };
    const change = moves[e.key];
    if (!change) return;
    e.preventDefault();
    pick({ ...hsv, ...change });
  };
  const stripKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 2;
    const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : e.key === "ArrowRight" || e.key === "ArrowUp" ? step : 0;
    if (!delta) return;
    e.preventDefault();
    pick({ ...hsv, h: (hsv.h + delta + 360) % 360 });
  };

  const commitText = () => {
    const hex = parseHex(text);
    if (hex) {
      setHsv(hexToHsv(hex));
      onChange(hex);
    } else setText(value);
  };

  return (
    <div className="color-picker" role="group" aria-label={label}>
      <div
        ref={square}
        className="cp-square"
        // The hue as the color under the white and black gradients of the stylesheet (not `background`: it would wipe them).
        style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        role="slider"
        tabIndex={0}
        aria-label={`${label}: насыщенность и яркость`}
        aria-valuetext={`насыщенность ${Math.round(hsv.s * 100)}%, яркость ${Math.round(hsv.v * 100)}%`}
        onKeyDown={squareKeys}
        {...drag(fromSquare)}
      >
        <span className="cp-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }} />
      </div>
      <div
        ref={strip}
        className="cp-hue"
        role="slider"
        tabIndex={0}
        aria-label={`${label}: оттенок`}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        onKeyDown={stripKeys}
        {...drag(fromStrip)}
      >
        <span className="cp-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
      </div>
      <div className="cp-row">
        <span className="cp-preview" style={{ background: value }} aria-hidden />
        <input
          className="input cp-hex"
          aria-label={`${label}: HEX`}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.currentTarget.value)}
          onBlur={commitText}
          onKeyDown={(e) => e.key === "Enter" && commitText()}
        />
      </div>
      <div className="cp-presets">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={color === value ? "cp-preset active" : "cp-preset"}
            style={{ background: color }}
            aria-label={color}
            title={color}
            onClick={() => pick(hexToHsv(color))}
          />
        ))}
      </div>
    </div>
  );
}
