/** Colours of the photo editor: `#rrggbb`, RGB 0–255, and HSV (hue 0–360, saturation and value 0–1) for the picker. */

export type Rgb = [number, number, number];
export type Hsv = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const part = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsv([r, g, b]: Rgb): Hsv {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rr) h = 60 * (((gg - bb) / d) % 6);
    else if (max === gg) h = 60 * ((bb - rr) / d + 2);
    else h = 60 * ((rr - gg) / d + 4);
  }
  if (h < 0) h += 360;
  return [Math.round(h * 100) / 100, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb([h, s, v]: Hsv): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** What a person typed as a colour, as `#rrggbb`; null when it is not one. */
export function parseHex(text: string): string | null {
  const bare = text.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(bare)) return `#${bare}`;
  if (/^[0-9a-f]{3}$/.test(bare)) return `#${bare.split("").map((c) => c + c).join("")}`;
  return null;
}

/** The editor's palette: greys, then hues in two strengths. */
export const SWATCHES = [
  "#000000", "#3f3f46", "#71717a", "#a1a1aa", "#d4d4d8", "#ffffff",
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
  "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#78350f",
  "#7f1d1d", "#7c2d12", "#713f12", "#14532d", "#1e3a8a", "#4c1d95",
  "#fecaca", "#fed7aa", "#fef08a", "#bbf7d0", "#bfdbfe", "#e9d5ff",
];
