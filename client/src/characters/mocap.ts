/**
 * Motions recorded on real people (motion capture), played on a VRM's bones: walking, standing, talking, sitting,
 * dancing and the like. Baked by scripts/build-motions.mjs from Quaternius' Universal Animation Library (CC0) into
 * public/motions: per clip and bone, the bone's turn from the T-pose in the VRM's normalized skeleton, 30 times a second,
 * and how the hips move, in hips heights. Loaded once, when the first model needs it.
 */
import * as THREE from "three";

type ClipIndex = {
  id: string;
  source: string;
  frames: number;
  length: number;
  loop: boolean;
  /** How far the hips travel in one cycle, in hips heights: a walk's or a run's. */
  stride: number | null;
  bones: { bone: number; still: boolean; at: number }[];
  hips: number;
};
type LibraryIndex = { version: number; fps: number; bones: string[]; quat: number; hips: number; clips: ClipIndex[] };

/** A moment of a motion: each bone's turn, and where the hips are against rest (hips heights). */
export type MotionFrame = { rot: Map<string, THREE.Quaternion>; hips: THREE.Vector3 };

export const newFrame = (): MotionFrame => ({ rot: new Map(), hips: new THREE.Vector3() });

export class MotionClip {
  readonly id: string;
  readonly length: number;
  readonly loop: boolean;
  readonly stride: number | null;
  private readonly frames: number;
  private readonly fps: number;
  /** Per bone: its quaternions frame after frame (x, y, z, w), or one frame for a bone that does not move. */
  private readonly tracks: { bone: string; still: boolean; values: Float32Array }[];
  private readonly hips: Float32Array;

  constructor(index: ClipIndex, library: LibraryIndex, data: ArrayBuffer) {
    this.id = index.id;
    this.length = index.length;
    this.loop = index.loop;
    this.stride = index.stride;
    this.frames = index.frames;
    this.fps = library.fps;
    this.tracks = index.bones.map((b) => {
      const count = (b.still ? 1 : index.frames) * 4;
      const raw = new Int16Array(data, b.at, count);
      const values = new Float32Array(count);
      for (let i = 0; i < count; i += 4) {
        const x = raw[i]! / library.quat;
        const y = raw[i + 1]! / library.quat;
        const z = raw[i + 2]! / library.quat;
        const w = raw[i + 3]! / library.quat;
        const n = Math.hypot(x, y, z, w) || 1;
        values[i] = x / n;
        values[i + 1] = y / n;
        values[i + 2] = z / n;
        values[i + 3] = w / n;
      }
      return { bone: library.bones[b.bone]!, still: b.still, values };
    });
    const rawHips = new Int16Array(data, index.hips, index.frames * 3);
    this.hips = Float32Array.from(rawHips, (v) => v / library.hips);
  }

  /** The motion at `time` seconds (wrapped for a loop, held at the end otherwise), written into `out`. */
  /** Bones this clip moves; a frame it samples into keeps no others (a take without fingers leaves the fingers be). */
  private readonly owns = new Set<string>();

  sample(time: number, out: MotionFrame): MotionFrame {
    if (this.owns.size === 0) for (const track of this.tracks) this.owns.add(track.bone);
    for (const bone of out.rot.keys()) if (!this.owns.has(bone)) out.rot.delete(bone);
    const span = (this.frames - 1) / this.fps;
    let t = this.loop ? ((time % span) + span) % span : Math.max(0, Math.min(span, time));
    if (!Number.isFinite(t)) t = 0;
    const f = t * this.fps;
    const i0 = Math.min(this.frames - 1, Math.floor(f));
    const i1 = this.loop ? (i0 + 1) % (this.frames - 1 || 1) : Math.min(this.frames - 1, i0 + 1);
    const k = f - i0;
    for (const track of this.tracks) {
      let q = out.rot.get(track.bone);
      if (!q) {
        q = new THREE.Quaternion();
        out.rot.set(track.bone, q);
      }
      const v = track.values;
      if (track.still) {
        q.set(v[0]!, v[1]!, v[2]!, v[3]!);
        continue;
      }
      const a = i0 * 4;
      const b = i1 * 4;
      // Neighbouring frames are on the same side (the baker made sure): a plain blend, normalized, is enough.
      q.set(v[a]! + (v[b]! - v[a]!) * k, v[a + 1]! + (v[b + 1]! - v[a + 1]!) * k, v[a + 2]! + (v[b + 2]! - v[a + 2]!) * k, v[a + 3]! + (v[b + 3]! - v[a + 3]!) * k).normalize();
    }
    const h = this.hips;
    const a = i0 * 3;
    const b = i1 * 3;
    out.hips.set(h[a]! + (h[b]! - h[a]!) * k, h[a + 1]! + (h[b + 1]! - h[a + 1]!) * k, h[a + 2]! + (h[b + 2]! - h[a + 2]!) * k);
    return out;
  }
}

export class MotionLibrary {
  private readonly clips = new Map<string, MotionClip>();

  constructor(index: LibraryIndex, data: ArrayBuffer) {
    for (const clip of index.clips) this.clips.set(clip.id, new MotionClip(clip, index, data));
  }

  clip(id: string): MotionClip | undefined {
    return this.clips.get(id);
  }
}

let loading: Promise<MotionLibrary | null> | null = null;

/** The motions, fetched once; null where they cannot be had (an old page, no file): the drawn poses stay then. */
export function loadMotions(): Promise<MotionLibrary | null> {
  loading ??= Promise.all([fetch("/motions/motions.json"), fetch("/motions/motions.bin")])
    .then(async ([index, data]) => {
      if (!index.ok || !data.ok) return null;
      return new MotionLibrary((await index.json()) as LibraryIndex, await data.arrayBuffer());
    })
    .catch(() => null);
  return loading;
}

const tmp = new THREE.Quaternion();

/** `into` becomes `into` blended toward `from` by `weight` (0 keeps `into`), bone by bone; hips too. */
export function blendFrames(into: MotionFrame, from: MotionFrame, weight: number) {
  if (weight <= 0) return into;
  for (const [bone, q] of from.rot) {
    const mine = into.rot.get(bone);
    if (!mine) {
      into.rot.set(bone, tmp.identity().slerp(q, Math.min(1, weight)).clone());
      continue;
    }
    if (weight >= 1) mine.copy(q);
    else mine.slerp(q, weight);
  }
  into.hips.lerp(from.hips, Math.min(1, weight));
  return into;
}

export function copyFrame(into: MotionFrame, from: MotionFrame) {
  for (const [bone, q] of from.rot) {
    const mine = into.rot.get(bone);
    if (mine) mine.copy(q);
    else into.rot.set(bone, q.clone());
  }
  into.hips.copy(from.hips);
  return into;
}
