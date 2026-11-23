/**
 * Where each source of the studio stands in the frame: rectangles in the frame's own pixels, the last one on top.
 * Pure, so moving and stretching them is tested without a canvas.
 */

import { av1Codec } from "./av1";

export type Rect = { x: number; y: number; width: number; height: number };

export type SourceKind = "screen" | "camera" | "character" | "text" | "image" | "color" | "clock";

export type TextStyle = { text: string; size: number; color: string; outline: number; bold: boolean };

/** How a source is drawn: everything a source's properties and filters can change. */
export type SourceLook = {
  /** 0–1. */
  opacity: number;
  /** Degrees. */
  rotate: number;
  /** Rounded corners, in frame pixels. */
  radius: number;
  /** What is cut off each side, 0–0.9 of the source's own size. */
  crop: { left: number; top: number; right: number; bottom: number };
  /** Percent: 100 is as it is. */
  brightness: number;
  contrast: number;
  saturate: number;
  blur: number;
  flip: boolean;
  /** A background of one color goes transparent: a green screen. */
  chroma: { color: string; similarity: number; smooth: number } | null;
};

export const DEFAULT_LOOK: SourceLook = {
  opacity: 1,
  rotate: 0,
  radius: 0,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
  brightness: 100,
  contrast: 100,
  saturate: 100,
  blur: 0,
  flip: false,
  chroma: null,
};

export type StudioSource = {
  id: string;
  kind: SourceKind;
  name: string;
  rect: Rect;
  visible: boolean;
  /** Locked on the preview: it can be chosen, not moved or stretched by the mouse. */
  locked?: boolean;
  look: SourceLook;
  /** For «Текст» and «Часы». */
  text?: TextStyle;
  /** For «Цвет». */
  color?: string;
};

export type Scene = { id: string; name: string; sources: StudioSource[] };

export type TransitionKind = "cut" | "fade" | "slide";
export type Transition = { kind: TransitionKind; ms: number };

export type RateControl = "cbr" | "vbr";
/** The video codec of records and streams: H.264 everywhere, AV1 where a platform takes it (YouTube) and in files. */
export type VideoCodec = "h264" | "av1";
export type Profile = "baseline" | "main" | "high";
export type EncoderChoice = "auto" | "hardware" | "software";
export type Latency = "quality" | "realtime";

export type Output = {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  rate: RateControl;
  codec: VideoCodec;
  /** Seconds between key frames. */
  keySeconds: number;
  profile: Profile;
  encoder: EncoderChoice;
  latency: Latency;
  audioKbps: number;
};

export const RESOLUTIONS = [
  { id: "1080p", name: "1080p: 1920×1080", width: 1920, height: 1080 },
  { id: "720p", name: "720p: 1280×720", width: 1280, height: 720 },
  { id: "1440p", name: "1440p: 2560×1440", width: 2560, height: 1440 },
  { id: "4k", name: "4K: 3840×2160", width: 3840, height: 2160 },
  { id: "vertical", name: "Вертикальный: 1080×1920", width: 1080, height: 1920 },
  { id: "vertical720", name: "Вертикальный: 720×1280", width: 720, height: 1280 },
  { id: "square", name: "Квадрат: 1080×1080", width: 1080, height: 1080 },
] as const;

export const FRAME_RATES = [24, 25, 30, 48, 50, 60] as const;
export const AUDIO_BITRATES = [96, 128, 160, 192, 256, 320] as const;

export const MIN_KBPS = 500;
export const MAX_KBPS = 60_000;

export type Quality = "light" | "good" | "best";

export const QUALITIES: { id: Quality; name: string }[] = [
  { id: "light", name: "Экономно" },
  { id: "good", name: "Хорошо" },
  { id: "best", name: "Отлично" },
];

/** Kilobits a second of the video for a frame size, frame rate and quality: about what OBS suggests. */
export function suggestedKbps(width: number, height: number, fps: number, quality: Quality = "good"): number {
  const perPixel = quality === "light" ? 0.045 : quality === "good" ? 0.075 : 0.12;
  const kbps = (width * height * fps * perPixel) / 1000;
  return Math.round(Math.min(MAX_KBPS, Math.max(1500, kbps)) / 100) * 100;
}

export const DEFAULT_OUTPUT: Output = {
  width: 1920,
  height: 1080,
  fps: 60,
  kbps: 9300,
  rate: "cbr",
  codec: "h264",
  keySeconds: 2,
  profile: "high",
  encoder: "auto",
  latency: "quality",
  audioKbps: 160,
};

/** An output from whatever was saved: anything odd falls back, and sizes stay even, as encoders want. */
export function parseOutput(raw: unknown): Output {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const whole = (v: unknown, min: number, max: number, fallback: number) => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.max(min, Math.min(max, n));
  };
  const even = (n: number) => n - (n % 2);
  const one = <T extends string>(v: unknown, allowed: readonly T[], fallback: T) => (allowed.includes(v as T) ? (v as T) : fallback);
  const d = DEFAULT_OUTPUT;
  return {
    width: even(whole(r.width, 320, 3840, d.width)),
    height: even(whole(r.height, 320, 3840, d.height)),
    fps: whole(r.fps, 10, 60, d.fps),
    kbps: whole(r.kbps, MIN_KBPS, MAX_KBPS, d.kbps),
    rate: one(r.rate, ["cbr", "vbr"] as const, d.rate),
    codec: one(r.codec, ["h264", "av1"] as const, d.codec),
    keySeconds: whole(r.keySeconds, 1, 10, d.keySeconds),
    profile: one(r.profile, ["baseline", "main", "high"] as const, d.profile),
    encoder: one(r.encoder, ["auto", "hardware", "software"] as const, d.encoder),
    latency: one(r.latency, ["quality", "realtime"] as const, d.latency),
    audioKbps: whole(r.audioKbps, 64, 320, d.audioKbps),
  };
}

/** Bits a second of the video. */
export function videoBitrate(output: Output): number {
  return output.kbps * 1000;
}

const PROFILE_BYTES: Record<Profile, string> = { baseline: "42e0", main: "4d00", high: "6400" };

/** The codec string the encoder is asked for: H.264 with the chosen profile, or AV1 (Main, 8 bits). */
export function videoCodec(output: Output): string {
  return output.codec === "av1" ? av1Codec(output) : avcCodec(output);
}

/** The H.264 profile as chosen, and the level a frame of this size and rate needs. */
export function avcCodec(output: Output): string {
  const rate = output.width * output.height * output.fps;
  // Level 4.0 up to 1080p30, 4.2 up to 1080p60, 5.1 up to 1440p60 (and 4K30), 5.2 up to 4K60.
  const level = rate <= 1920 * 1088 * 30 ? 0x28 : rate <= 1920 * 1088 * 64 ? 0x2a : rate <= 3840 * 2160 * 32 ? 0x33 : 0x34;
  return `avc1.${PROFILE_BYTES[output.profile]}${level.toString(16)}`;
}

/** Where a new source of `kind` lands: the screen fills the frame, a camera sits in a corner, and so on. */
export function placeNew(kind: SourceKind, frame: { width: number; height: number }, aspect = 16 / 9): Rect {
  const { width, height } = frame;
  switch (kind) {
    case "screen":
      return fit(aspect, { x: 0, y: 0, width, height });
    case "camera": {
      const w = Math.round(width * 0.25);
      const h = Math.round(w / aspect);
      return { x: width - w - Math.round(width * 0.02), y: height - h - Math.round(height * 0.03), width: w, height: h };
    }
    case "character": {
      const h = Math.round(height * 0.45);
      const w = Math.round(h * 0.8);
      return { x: Math.round(width * 0.02), y: height - h, width: w, height: h };
    }
    case "text":
      return { x: Math.round(width * 0.05), y: Math.round(height * 0.05), width: Math.round(width * 0.5), height: Math.round(height * 0.1) };
    case "clock":
      return { x: Math.round(width * 0.72), y: Math.round(height * 0.04), width: Math.round(width * 0.24), height: Math.round(height * 0.09) };
    case "color":
      return { x: 0, y: 0, width, height };
    case "image": {
      const w = Math.round(width * 0.2);
      return { x: Math.round(width * 0.04), y: Math.round(height * 0.04), width: w, height: Math.round(w / aspect) };
    }
  }
}

/** The biggest rectangle of `aspect` inside `box`, in its middle. */
export function fit(aspect: number, box: Rect): Rect {
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  return { x: Math.round(box.x + (box.width - width) / 2), y: Math.round(box.y + (box.height - height) / 2), width: Math.round(width), height: Math.round(height) };
}

/** How big the corner handle is, in frame pixels. */
export const HANDLE = 28;

export type Grab = { id: string; mode: "move" | "resize"; start: { x: number; y: number }; rect: Rect };

/** What a press at `point` (frame pixels) takes hold of: the corner of the topmost visible source under it, or the source. */
export function grabAt(sources: StudioSource[], point: { x: number; y: number }): Grab | null {
  for (let i = sources.length - 1; i >= 0; i--) {
    const s = sources[i]!;
    if (!s.visible) continue;
    const { x, y, width, height } = s.rect;
    const corner = point.x >= x + width - HANDLE && point.x <= x + width + HANDLE / 2 && point.y >= y + height - HANDLE && point.y <= y + height + HANDLE / 2;
    if (corner) return { id: s.id, mode: "resize", start: point, rect: s.rect };
    if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) return { id: s.id, mode: "move", start: point, rect: s.rect };
  }
  return null;
}

/** The rectangle after dragging what `grab` holds to `point`: moved, or stretched keeping its shape; never smaller than 32. */
export function dragTo(grab: Grab, point: { x: number; y: number }): Rect {
  const dx = point.x - grab.start.x;
  const dy = point.y - grab.start.y;
  const r = grab.rect;
  if (grab.mode === "move") return { ...r, x: Math.round(r.x + dx), y: Math.round(r.y + dy) };
  const aspect = r.width / r.height;
  const width = Math.max(32, Math.round(Math.max(r.width + dx, (r.height + dy) * aspect)));
  return { ...r, width, height: Math.round(width / aspect) };
}

/** A point of the preview element (CSS pixels from its corner) as frame pixels. */
export function toFrame(point: { x: number; y: number }, element: { width: number; height: number }, frame: { width: number; height: number }) {
  return { x: (point.x / element.width) * frame.width, y: (point.y / element.height) * frame.height };
}

/** The sources with a new one: a screen goes to the back (it fills the frame), anything else on top. */
export function withSource(sources: StudioSource[], source: StudioSource): StudioSource[] {
  return source.kind === "screen" || source.kind === "color" ? [source, ...sources] : [...sources, source];
}

/** The sources with `id` moved one step up (toward the top) or down. */
export function reorder(sources: StudioSource[], id: string, up: boolean): StudioSource[] {
  const i = sources.findIndex((s) => s.id === id);
  const j = up ? i + 1 : i - 1;
  if (i < 0 || j < 0 || j >= sources.length) return sources;
  const next = [...sources];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
