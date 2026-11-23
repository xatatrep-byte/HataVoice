/**
 * The photo editor's corrections and filters, pixel by pixel (light, colour, details), on the bytes of a picture. Pure:
 * the same photo and settings give the same pixels (grain too), so the preview and the sent photo agree.
 */

/** Each −100…100, but `hue` −180…180 and `sharpen`, `blur`, `vignette`, `grain`, `fade` 0…100. */
export type Adjust = {
  exposure: number;
  brightness: number;
  contrast: number;
  highlights: number;
  shadows: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  hue: number;
  sharpen: number;
  blur: number;
  vignette: number;
  grain: number;
  fade: number;
};

export const NO_ADJUST: Adjust = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  hue: 0,
  sharpen: 0,
  blur: 0,
  vignette: 0,
  grain: 0,
  fade: 0,
};

/** Each slider: its key, its name, its range. */
export const ADJUSTS: { group: string; items: { key: keyof Adjust; name: string; min: number; max: number }[] }[] = [
  {
    group: "Свет",
    items: [
      { key: "exposure", name: "Экспозиция", min: -100, max: 100 },
      { key: "brightness", name: "Яркость", min: -100, max: 100 },
      { key: "contrast", name: "Контраст", min: -100, max: 100 },
      { key: "highlights", name: "Светлые участки", min: -100, max: 100 },
      { key: "shadows", name: "Тени", min: -100, max: 100 },
    ],
  },
  {
    group: "Цвет",
    items: [
      { key: "saturation", name: "Насыщенность", min: -100, max: 100 },
      { key: "vibrance", name: "Сочность", min: -100, max: 100 },
      { key: "temperature", name: "Температура", min: -100, max: 100 },
      { key: "tint", name: "Оттенок", min: -100, max: 100 },
      { key: "hue", name: "Тон", min: -180, max: 180 },
    ],
  },
  {
    group: "Детали",
    items: [
      { key: "sharpen", name: "Резкость", min: 0, max: 100 },
      { key: "blur", name: "Размытие", min: 0, max: 100 },
      { key: "vignette", name: "Виньетка", min: 0, max: 100 },
      { key: "grain", name: "Зерно", min: 0, max: 100 },
      { key: "fade", name: "Выцветание", min: 0, max: 100 },
    ],
  },
];

/** A 3×4 colour matrix (rows r, g, b: three weights and an offset, 0–1 values). */
type Matrix = [number, number, number, number, number, number, number, number, number, number, number, number];
/** Split toning: the shadows pulled toward one colour, the light toward another (0–1 RGB, how strongly). */
type Split = { shadow: [number, number, number]; light: [number, number, number]; strength: number };

export type Filter = { id: string; name: string; adjust: Partial<Adjust>; matrix?: Matrix; split?: Split };

const SEPIA: Matrix = [0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0];

export const FILTERS: Filter[] = [
  { id: "none", name: "Оригинал", adjust: {} },
  { id: "vivid", name: "Яркий", adjust: { saturation: 35, vibrance: 25, contrast: 15 } },
  { id: "warm", name: "Тёплый", adjust: { temperature: 40, saturation: 10, exposure: 4 } },
  { id: "cool", name: "Холодный", adjust: { temperature: -40, tint: -6, contrast: 6 } },
  { id: "bw", name: "Ч/Б", adjust: { saturation: -100, contrast: 15 } },
  { id: "noir", name: "Нуар", adjust: { saturation: -100, contrast: 50, shadows: -25, vignette: 40 } },
  { id: "sepia", name: "Сепия", adjust: { contrast: 6 }, matrix: SEPIA },
  { id: "vintage", name: "Винтаж", adjust: { fade: 40, temperature: 22, saturation: -25, vignette: 35, grain: 20 } },
  { id: "film", name: "Плёнка", adjust: { fade: 25, contrast: 12, grain: 30, tint: 6 } },
  { id: "pastel", name: "Пастель", adjust: { fade: 55, saturation: -20, brightness: 10 } },
  { id: "matte", name: "Матовый", adjust: { fade: 35, contrast: -12, highlights: -10 } },
  { id: "drama", name: "Драма", adjust: { contrast: 40, highlights: -30, shadows: 25, saturation: -12, vignette: 30 } },
  { id: "sunset", name: "Закат", adjust: { temperature: 50, tint: 18, saturation: 18 } },
  {
    id: "cinema",
    name: "Кино",
    adjust: { contrast: 18, saturation: 8 },
    split: { shadow: [0.0, 0.45, 0.55], light: [1.0, 0.62, 0.3], strength: 0.22 },
  },
  { id: "lomo", name: "Ломо", adjust: { saturation: 30, contrast: 30, vignette: 60 } },
  { id: "arctic", name: "Арктика", adjust: { temperature: -30, brightness: 12, saturation: -30, fade: 20 } },
];

const RANGES: Record<keyof Adjust, [number, number]> = {
  exposure: [-100, 100],
  brightness: [-100, 100],
  contrast: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  saturation: [-100, 100],
  vibrance: [-100, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  hue: [-180, 180],
  sharpen: [0, 100],
  blur: [0, 100],
  vignette: [0, 100],
  grain: [0, 100],
  fade: [0, 100],
};

/** The person's corrections with the filter's own, at `amount` (0–100), each within its range. */
export function effectiveAdjust(adjust: Adjust, filter: string, amount: number): Adjust {
  const preset = FILTERS.find((f) => f.id === filter)?.adjust ?? {};
  const out = { ...adjust };
  for (const key of Object.keys(RANGES) as (keyof Adjust)[]) {
    const [min, max] = RANGES[key];
    out[key] = Math.max(min, Math.min(max, adjust[key] + ((preset[key] ?? 0) * amount) / 100));
  }
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The hue-rotate matrix (as CSS has it), `degrees` around the grey axis. */
function hueMatrix(degrees: number): number[] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

/**
 * The corrections (already with the filter's, see `effectiveAdjust`) and the filter's own colour work, on `data`
 * (RGBA, `width` × `height`) in place. `seed` makes the grain. Sharpening and blurring are done apart (`sharpen`, and a
 * blur when drawing).
 */
export function applyPixels(data: Uint8ClampedArray, width: number, height: number, a: Adjust, filter: string, amount: number, seed: number): Uint8ClampedArray {
  const preset = FILTERS.find((f) => f.id === filter);
  const mix = amount / 100;
  const matrix = preset?.matrix;
  const split = preset?.split;
  const exposure = 2 ** (a.exposure / 50);
  const brightness = a.brightness / 250;
  const contrast = 1 + a.contrast / 100;
  const saturation = 1 + a.saturation / 100;
  const vibrance = a.vibrance / 100;
  const warm = (a.temperature / 100) * 0.12;
  const tint = (a.tint / 100) * 0.1;
  const fade = a.fade / 100;
  const vignette = (a.vignette / 100) * 0.85;
  const grain = (a.grain / 100) * 0.22;
  const hue = a.hue ? hueMatrix(a.hue) : null;
  const plain =
    !matrix && !split && exposure === 1 && !brightness && contrast === 1 && saturation === 1 && !vibrance && !warm && !tint && !fade && !vignette && !grain && !hue && !a.highlights && !a.shadows;
  if (plain) return data;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const reach = Math.hypot(cx, cy) || 1;
  let random = (seed >>> 0) || 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = data[i]! / 255;
      let g = data[i + 1]! / 255;
      let b = data[i + 2]! / 255;
      if (matrix) {
        const mr = matrix[0] * r + matrix[1] * g + matrix[2] * b + matrix[3];
        const mg = matrix[4] * r + matrix[5] * g + matrix[6] * b + matrix[7];
        const mb = matrix[8] * r + matrix[9] * g + matrix[10] * b + matrix[11];
        r += (mr - r) * mix;
        g += (mg - g) * mix;
        b += (mb - b) * mix;
      }
      r = r * exposure + brightness;
      g = g * exposure + brightness;
      b = b * exposure + brightness;
      r = (r - 0.5) * contrast + 0.5;
      g = (g - 0.5) * contrast + 0.5;
      b = (b - 0.5) * contrast + 0.5;
      if (a.highlights || a.shadows) {
        const l = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
        const lift = (a.shadows / 100) * 0.35 * (1 - l) * (1 - l) + (a.highlights / 100) * 0.35 * l * l;
        r += lift;
        g += lift;
        b += lift;
      }
      r += warm + tint * 0.5;
      g -= tint;
      b += -warm + tint * 0.5;
      if (hue) {
        const hr = hue[0]! * r + hue[1]! * g + hue[2]! * b;
        const hg = hue[3]! * r + hue[4]! * g + hue[5]! * b;
        const hb = hue[6]! * r + hue[7]! * g + hue[8]! * b;
        r = hr;
        g = hg;
        b = hb;
      }
      if (saturation !== 1 || vibrance) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const spread = Math.max(r, g, b) - Math.min(r, g, b);
        const s = saturation * (1 + vibrance * (1 - clamp01(spread * 1.5)));
        r = l + (r - l) * s;
        g = l + (g - l) * s;
        b = l + (b - l) * s;
      }
      if (split) {
        const l = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
        const toward = split.strength * mix;
        const [sr, sg, sb] = split.shadow;
        const [lr, lg, lb] = split.light;
        const dark = (1 - l) * toward;
        const bright = l * toward;
        r += (sr - r) * dark * 0.5 + (lr - r) * bright * 0.5;
        g += (sg - g) * dark * 0.5 + (lg - g) * bright * 0.5;
        b += (sb - b) * dark * 0.5 + (lb - b) * bright * 0.5;
      }
      if (fade) {
        r = r * (1 - fade * 0.22) + fade * 0.1;
        g = g * (1 - fade * 0.22) + fade * 0.1;
        b = b * (1 - fade * 0.22) + fade * 0.1;
      }
      if (vignette) {
        const d = Math.hypot(x - cx, y - cy) / reach;
        const keep = 1 - vignette * smooth(0.3, 1, d);
        r *= keep;
        g *= keep;
        b *= keep;
      }
      if (grain) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const noise = (random / 4294967296 - 0.5) * grain;
        r += noise;
        g += noise;
        b += noise;
      }
      data[i] = clamp01(r) * 255 + 0.5;
      data[i + 1] = clamp01(g) * 255 + 0.5;
      data[i + 2] = clamp01(b) * 255 + 0.5;
    }
  }
  return data;
}

/** Sharpening (an unsharp mask over the 3×3 around each pixel), `amount` 0–100, in place; the edge pixels stay. */
export function sharpen(data: Uint8ClampedArray, width: number, height: number, amount: number): Uint8ClampedArray {
  if (amount <= 0 || width < 3 || height < 3) return data;
  const k = (amount / 100) * 1.5;
  const source = data.slice();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let around = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) around += source[i + (dy * width + dx) * 4 + c]!;
        const blurred = around / 9;
        data[i + c] = source[i + c]! + (source[i + c]! - blurred) * k;
      }
    }
  }
  return data;
}
