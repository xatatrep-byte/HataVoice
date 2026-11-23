import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pipette } from "lucide-react";
import { hexToRgb, hsvToRgb, parseHex, rgbToHex, rgbToHsv, SWATCHES, type Hsv } from "../../media/photo/color";

type Props = {
  color: string;
  onChange: (color: string) => void;
  /** Colours used last, newest first. */
  recent: string[];
  onPick: () => void;
};

/** Follows a drag inside `element`, calling `at` with 0–1 across and down. */
function dragIn(element: HTMLElement, e: ReactPointerEvent, at: (x: number, y: number) => void) {
  const place = (clientX: number, clientY: number) => {
    const r = element.getBoundingClientRect();
    at(Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))), Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height))));
  };
  place(e.clientX, e.clientY);
  const move = (ev: PointerEvent) => place(ev.clientX, ev.clientY);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/**
 * The colour, as in a photo editor: a square of saturation and brightness, a strip of hues, the code to type, a palette
 * and the colours used last, and the eyedropper to take one from the photo.
 */
export function ColorPicker({ color, onChange, recent, onPick }: Props) {
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(color)));
  const [typed, setTyped] = useState(color);
  const square = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);

  // A colour from elsewhere (a swatch, the eyedropper) moves the picker, keeping its hue where grey has none.
  useEffect(() => {
    setTyped(color);
    if (rgbToHex(hsvToRgb(hsv)) === color) return;
    const next = rgbToHsv(hexToRgb(color));
    setHsv(next[1] === 0 || next[2] === 0 ? [hsv[0], next[1], next[2]] : next);
  }, [color]);

  const choose = (next: Hsv) => {
    setHsv(next);
    onChange(rgbToHex(hsvToRgb(next)));
  };

  const pure = rgbToHex(hsvToRgb([hsv[0], 1, 1]));
  return (
    <div className="photo-color">
      <div
        ref={square}
        className="photo-color-square"
        style={{ background: pure }}
        role="slider"
        aria-label="Насыщенность и яркость"
        aria-valuenow={Math.round(hsv[1] * 100)}
        tabIndex={0}
        onPointerDown={(e) => square.current && dragIn(square.current, e, (x, y) => choose([hsv[0], x, 1 - y]))}
      >
        <span className="photo-color-knob" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: color }} />
      </div>
      <div
        ref={strip}
        className="photo-color-hue"
        role="slider"
        aria-label="Тон"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv[0])}
        tabIndex={0}
        onPointerDown={(e) => strip.current && dragIn(strip.current, e, (x) => choose([Math.min(359.9, x * 360), hsv[1], hsv[2]]))}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") choose([(hsv[0] + 5) % 360, hsv[1], hsv[2]]);
          if (e.key === "ArrowLeft") choose([(hsv[0] + 355) % 360, hsv[1], hsv[2]]);
        }}
      >
        <span className="photo-color-hue-knob" style={{ left: `${(hsv[0] / 360) * 100}%` }} />
      </div>
      <div className="photo-color-row">
        <span className="photo-color-now" style={{ background: color }} aria-hidden />
        <input
          className="input photo-color-code"
          aria-label="Код цвета"
          value={typed}
          spellCheck={false}
          onChange={(e) => {
            setTyped(e.currentTarget.value);
            const parsed = parseHex(e.currentTarget.value);
            if (parsed) onChange(parsed);
          }}
          onBlur={() => setTyped(color)}
        />
        <button type="button" className="photo-mini" title="Пипетка: взять цвет с фото (I)" aria-label="Взять цвет с фото" onClick={onPick}>
          <Pipette size={16} aria-hidden />
        </button>
      </div>
      <div className="photo-swatches" role="list" aria-label="Палитра">
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            role="listitem"
            className="photo-swatch"
            aria-label={swatch}
            aria-pressed={swatch === color}
            style={{ background: swatch }}
            onClick={() => onChange(swatch)}
          />
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <p className="photo-label">Недавние</p>
          <div className="photo-swatches" role="list" aria-label="Недавние цвета">
            {recent.map((swatch) => (
              <button key={swatch} type="button" role="listitem" className="photo-swatch" aria-label={swatch} style={{ background: swatch }} onClick={() => onChange(swatch)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
