/**
 * The video editor's timeline: the pieces (clips) of the video in the order they play, each from its own place in the
 * video, at its own speed and loudness; titles over them between their times; the frame's shape, turn, colour and fades.
 * Pure: the preview and the export play the same document.
 */

export type Clip = { id: string; /** Seconds of the video. */ start: number; end: number; speed: number; /** 0–2. */ volume: number };
export type Title = {
  id: string;
  text: string;
  /** Seconds of the timeline. */
  at: number;
  until: number;
  /** Its middle, as parts of the frame (0–1). */
  x: number;
  y: number;
  /** Its letters' height, as a part of the frame's height. */
  size: number;
  color: string;
  font: string;
  bold: boolean;
  background: boolean;
  outline: boolean;
};
export type VideoAdjust = { brightness: number; contrast: number; saturation: number; hue: number };
export type Aspect = "source" | "16:9" | "9:16" | "1:1" | "4:5";

export type VideoDoc = {
  /** The video as it came. */
  duration: number;
  width: number;
  height: number;
  clips: Clip[];
  titles: Title[];
  aspect: Aspect;
  /** A frame of another shape is filled (cut at the sides) or the video fits in it (bars). */
  fit: "fill" | "fit";
  turn: 0 | 1 | 2 | 3;
  flipX: boolean;
  adjust: VideoAdjust;
  filter: string;
  /** Seconds of fading from black at the start and to black at the end. */
  fadeIn: number;
  fadeOut: number;
  muted: boolean;
};

export const MIN_CLIP = 0.1;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

let ids = 0;
export const clipId = () => `c${Date.now().toString(36)}${(++ids).toString(36)}`;

export const NO_VIDEO_ADJUST: VideoAdjust = { brightness: 0, contrast: 0, saturation: 0, hue: 0 };

export const newVideoDoc = (duration: number, width: number, height: number): VideoDoc => ({
  duration,
  width,
  height,
  clips: [{ id: clipId(), start: 0, end: duration, speed: 1, volume: 1 }],
  titles: [],
  aspect: "source",
  fit: "fill",
  turn: 0,
  flipX: false,
  adjust: { ...NO_VIDEO_ADJUST },
  filter: "none",
  fadeIn: 0,
  fadeOut: 0,
  muted: false,
});

const round = (v: number) => Math.round(v * 1000) / 1000;
export const clipLength = (clip: Clip) => (clip.end - clip.start) / clip.speed;

/** How long the cut video plays. */
export function timelineLength(doc: VideoDoc): number {
  return round(doc.clips.reduce((sum, clip) => sum + clipLength(clip), 0));
}

/** The clip playing at timeline second `t`: its index, where in the video that is, and where the clip begins. */
export function clipAt(doc: VideoDoc, t: number): { index: number; clip: Clip; source: number; from: number } | null {
  let from = 0;
  for (let index = 0; index < doc.clips.length; index++) {
    const clip = doc.clips[index]!;
    const length = clipLength(clip);
    if (t < from + length || index === doc.clips.length - 1) {
      const source = Math.min(clip.end, clip.start + Math.max(0, t - from) * clip.speed);
      return { index, clip, source: round(source), from: round(from) };
    }
    from += length;
  }
  return null;
}

/** Where each clip begins on the timeline. */
export function clipStarts(doc: VideoDoc): number[] {
  const starts: number[] = [];
  let from = 0;
  for (const clip of doc.clips) {
    starts.push(round(from));
    from += clipLength(clip);
  }
  return starts;
}

/** The clip under timeline second `t` cut in two there (not within a tenth of a second of an end). */
export function splitAt(doc: VideoDoc, t: number): VideoDoc {
  const at = clipAt(doc, t);
  if (!at) return doc;
  const { index, clip, source } = at;
  if (source - clip.start < MIN_CLIP || clip.end - source < MIN_CLIP) return doc;
  const clips = doc.clips.slice();
  clips.splice(index, 1, { ...clip, end: source }, { ...clip, id: clipId(), start: source });
  return { ...doc, clips };
}

export function removeClip(doc: VideoDoc, id: string): VideoDoc {
  if (doc.clips.length <= 1) return doc;
  return { ...doc, clips: doc.clips.filter((c) => c.id !== id) };
}

/** The clip moved to place `to` (0 first). */
export function moveClip(doc: VideoDoc, id: string, to: number): VideoDoc {
  const from = doc.clips.findIndex((c) => c.id === id);
  if (from < 0) return doc;
  const clips = doc.clips.slice();
  const [clip] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(clips.length, to)), 0, clip!);
  return { ...doc, clips };
}

/** A clip's start or end moved to second `source` of the video, within the video and leaving it a tenth at least. */
export function trimClip(doc: VideoDoc, id: string, edge: "start" | "end", source: number): VideoDoc {
  return {
    ...doc,
    clips: doc.clips.map((c) => {
      if (c.id !== id) return c;
      if (edge === "start") return { ...c, start: round(Math.max(0, Math.min(c.end - MIN_CLIP, source))) };
      return { ...c, end: round(Math.min(doc.duration, Math.max(c.start + MIN_CLIP, source))) };
    }),
  };
}

export function setSpeed(doc: VideoDoc, id: string, speed: number): VideoDoc {
  const s = Math.max(0.25, Math.min(4, speed));
  return { ...doc, clips: doc.clips.map((c) => (c.id === id ? { ...c, speed: s } : c)) };
}

export function titlesAt(doc: VideoDoc, t: number): Title[] {
  return doc.titles.filter((title) => t >= title.at && t < title.until);
}

const RATIOS: Record<Exclude<Aspect, "source">, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** The video's size as turned. */
export function turnedSize(doc: VideoDoc): { width: number; height: number } {
  return doc.turn % 2 === 1 ? { width: doc.height, height: doc.width } : { width: doc.width, height: doc.height };
}

/** The frame of the result: its shape, at most `maxHeight` high and never bigger than the video, in even pixels. */
export function outputSize(doc: VideoDoc, maxHeight: number): { width: number; height: number } {
  const turned = turnedSize(doc);
  const ratio = doc.aspect === "source" ? turned.width / turned.height : RATIOS[doc.aspect];
  // The frame's height: as asked, but no more than the video gives for that shape.
  const most = Math.min(turned.height, turned.width / ratio);
  const height = Math.min(maxHeight, most);
  return { width: even(height * ratio), height: even(height) };
}

/** How the video lies in a frame of `width` × `height`: its scale (of the turned video), filling or fitting. */
export function frameLayout(doc: VideoDoc, width: number, height: number): { scale: number } {
  const turned = turnedSize(doc);
  const across = width / turned.width;
  const down = height / turned.height;
  return { scale: doc.fit === "fill" ? Math.max(across, down) : Math.min(across, down) };
}

/** How much shows at timeline second `t` (0 black … 1), fading in and out. */
export function fadeAt(doc: VideoDoc, t: number): number {
  const length = timelineLength(doc);
  let show = 1;
  if (doc.fadeIn > 0 && t < doc.fadeIn) show = Math.min(show, Math.max(0, t / doc.fadeIn));
  if (doc.fadeOut > 0 && t > length - doc.fadeOut) show = Math.min(show, Math.max(0, (length - t) / doc.fadeOut));
  return show;
}

export const VIDEO_FILTERS: { id: string; name: string; css: string }[] = [
  { id: "none", name: "Оригинал", css: "" },
  { id: "vivid", name: "Яркий", css: "saturate(1.5) contrast(1.15)" },
  { id: "warm", name: "Тёплый", css: "sepia(0.25) saturate(1.3) hue-rotate(-8deg)" },
  { id: "cool", name: "Холодный", css: "saturate(0.9) hue-rotate(12deg) brightness(1.03)" },
  { id: "bw", name: "Ч/Б", css: "grayscale(1) contrast(1.1)" },
  { id: "noir", name: "Нуар", css: "grayscale(1) contrast(1.5) brightness(0.9)" },
  { id: "sepia", name: "Сепия", css: "sepia(0.85)" },
  { id: "vintage", name: "Винтаж", css: "sepia(0.4) contrast(0.9) saturate(0.8) brightness(1.05)" },
  { id: "fade", name: "Блёклый", css: "contrast(0.8) saturate(0.7) brightness(1.1)" },
  { id: "drama", name: "Драма", css: "contrast(1.4) saturate(0.85)" },
];

/** The colour of the video as a canvas filter; "none" when it is as it came. */
export function videoFilter(adjust: VideoAdjust, filter: string): string {
  const parts: string[] = [];
  const k = (v: number) => Math.round((1 + v / 100) * 100) / 100;
  if (adjust.brightness) parts.push(`brightness(${k(adjust.brightness)})`);
  if (adjust.contrast) parts.push(`contrast(${k(adjust.contrast)})`);
  if (adjust.saturation) parts.push(`saturate(${k(adjust.saturation)})`);
  if (adjust.hue) parts.push(`hue-rotate(${adjust.hue}deg)`);
  const preset = VIDEO_FILTERS.find((f) => f.id === filter)?.css;
  if (preset) parts.push(preset);
  return parts.length ? parts.join(" ") : "none";
}

/** «0:07.4», «1:05.0»: a time on the timeline. */
export function timeLabel(seconds: number): string {
  const s = Math.max(0, seconds);
  const minutes = Math.floor(s / 60);
  return `${minutes}:${(s - minutes * 60).toFixed(1).padStart(4, "0")}`;
}
