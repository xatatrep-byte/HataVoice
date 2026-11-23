/** Colors as `#rrggbb`, and the arithmetic the themes and the color picker need. */

export type Rgb = { r: number; g: number; b: number };
/** Hue 0–360, saturation and value 0–1. */
export type Hsv = { h: number; s: number; v: number };

const HEX = /^#[0-9a-f]{6}$/i;

export function isHex(text: unknown): text is string {
  return typeof text === "string" && HEX.test(text);
}

/** `#abc` and `abc` too; null for anything that is no color. */
export function parseHex(text: string): string | null {
  const t = text.trim().replace(/^#?/, "#");
  if (/^#[0-9a-f]{3}$/i.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toLowerCase();
  return HEX.test(t) ? t.toLowerCase() : null;
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const byte = (x: number) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export const hexToHsv = (hex: string) => rgbToHsv(hexToRgb(hex));
export const hsvToHex = (hsv: Hsv) => rgbToHex(hsvToRgb(hsv));

const toLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

type Lab = { L: number; a: number; b: number };

function rgbToOklab({ r, g, b }: Rgb): Lab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb({ L, a, b }: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** `a` and `b` mixed, `amount` 0 (all `a`) to 1 (all `b`), in OKLab: the middle is not muddier than the ends. */
export function mix(a: string, b: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  const [x, y] = [rgbToOklab(hexToRgb(a)), rgbToOklab(hexToRgb(b))];
  return rgbToHex(oklabToRgb({ L: x.L + (y.L - x.L) * t, a: x.a + (y.a - x.a) * t, b: x.b + (y.b - x.b) * t }));
}

/** Lightness of a color, 0–1 (OKLab L). */
export function lightness(hex: string): number {
  return rgbToOklab(hexToRgb(hex)).L;
}

/** The color lighter (`by` > 0) or darker (`by` < 0), by OKLab lightness. */
export function shade(hex: string, by: number): string {
  const lab = rgbToOklab(hexToRgb(hex));
  return rgbToHex(oklabToRgb({ ...lab, L: Math.min(1, Math.max(0, lab.L + by)) }));
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio of two colors, 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** White or near-black, whichever reads better on `background`. */
export function textOn(background: string): string {
  return contrast(background, "#ffffff") >= contrast(background, "#14121f") ? "#ffffff" : "#14121f";
}
