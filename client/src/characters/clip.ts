/**
 * A motion someone made in the workshop: key poses on a timeline. The numbers are the same joints `motion.ts` works with,
 * so a clip fits any figure and any model. A clip comes to friends in a file: everything in it is checked before use.
 */
import { Quaternion } from "three";
import { JOINTS, restPose, type Joint, type JointName, type Pose } from "./motion";
import { jointQuaternion, quaternionJoint } from "./rig";

export const FACE_FIELDS = ["mouth", "mouthWide", "smile", "eyes", "happy", "brow", "browSlant", "lookX", "lookY", "blush"] as const;
export type FaceField = (typeof FACE_FIELDS)[number];
export const BODY_FIELDS = ["x", "z", "y", "turn", "roll"] as const;
export type BodyField = (typeof BODY_FIELDS)[number];

export type Ease = "smooth" | "linear" | "step";

export type ClipKey = {
  /** Seconds from the start. */
  t: number;
  /** How the way to the next key goes. */
  ease?: Ease;
  joints: Record<JointName, Joint>;
  face: Record<FaceField, number>;
  body: Record<BodyField, number>;
  fistL: boolean;
  fistR: boolean;
};

export type Clip = {
  id: string;
  name: string;
  emoji: string;
  /** Seconds. */
  duration: number;
  loop: boolean;
  keys: ClipKey[];
};

export const MAX_DURATION = 60;
export const MAX_KEYS = 900;
const MAX_NAME = 32;
// Letters only: an act goes through the group as a word of lowercase letters.
const ID = /^clip[a-z]{1,12}$/;

/** An act of ours: `clip…`. */
export function isClipAct(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

export function newClipId(): string {
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26)));
  return `clip${letters.join("")}`;
}

/** A key from a pose as it stands. */
export function keyFromPose(pose: Pose, t: number, ease: Ease = "smooth"): ClipKey {
  const joints = {} as Record<JointName, Joint>;
  for (const name of JOINTS) joints[name] = pose[name].map(round) as Joint;
  const face = {} as Record<FaceField, number>;
  for (const field of FACE_FIELDS) face[field] = round(pose[field]);
  const body = {} as Record<BodyField, number>;
  for (const field of BODY_FIELDS) body[field] = round(pose[field]);
  return { t: round(t), ease, joints, face, body, fistL: pose.fistL, fistR: pose.fistR };
}

export function emptyClip(name = "Новое движение"): Clip {
  const rest = restPose();
  return { id: newClipId(), name, emoji: "✨", duration: 2, loop: false, keys: [keyFromPose(rest, 0), keyFromPose(rest, 2)] };
}

function eased(k: number, ease: Ease | undefined): number {
  if (ease === "step") return 0;
  if (ease === "linear") return k;
  return k * k * (3 - 2 * k);
}

const a = new Quaternion();
const b = new Quaternion();

/** The two keys around `t`, and how far between them. */
function around(keys: ClipKey[], t: number): [ClipKey, ClipKey, number] {
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.t) return [first, first, 0];
  if (t >= last.t) return [last, last, 0];
  let hi = 1;
  while (keys[hi]!.t < t) hi++;
  const from = keys[hi - 1]!;
  const to = keys[hi]!;
  return [from, to, eased((t - from.t) / Math.max(0.0001, to.t - from.t), from.ease)];
}

/** Writes the pose of the clip at `t` over `pose`, as far as `weight` goes (1: all of it). */
export function writeClipPose(clip: Clip, t: number, pose: Pose, weight = 1): void {
  if (clip.keys.length === 0) return;
  const [from, to, k] = around(clip.keys, t);
  for (const name of JOINTS) {
    jointQuaternion(from.joints[name], a);
    jointQuaternion(to.joints[name], b);
    a.slerp(b, k);
    if (weight < 1) {
      jointQuaternion(pose[name], b);
      a.copy(b.slerp(a, weight));
    }
    const out = quaternionJoint(a);
    pose[name][0] = out[0];
    pose[name][1] = out[1];
    pose[name][2] = out[2];
  }
  for (const field of FACE_FIELDS) {
    const value = from.face[field] + (to.face[field] - from.face[field]) * k;
    pose[field] += (value - pose[field]) * weight;
  }
  for (const field of BODY_FIELDS) {
    const value = from.body[field] + (to.body[field] - from.body[field]) * k;
    pose[field] += (value - pose[field]) * weight;
  }
  if (weight > 0.5) {
    pose.fistL = k < 0.5 ? from.fistL : to.fistL;
    pose.fistR = k < 0.5 ? from.fistR : to.fistR;
  }
}

export function clipWeight(clip: Clip, elapsed: number): number {
  const edge = Math.min(0.2, clip.duration * 0.2);
  const inOut = clip.loop ? 1 : Math.min(1, elapsed / edge, (clip.duration - elapsed) / edge);
  return Math.max(0, inOut * inOut * (3 - 2 * inOut));
}

/** A clip played as an act: it eases in from whatever the figure was doing, and back out at the end. */
export function playClip(clip: Clip, elapsed: number, pose: Pose): void {
  writeClipPose(clip, clip.loop ? elapsed % clip.duration : elapsed, pose, clipWeight(clip, elapsed));
}

const number = (v: unknown, lo: number, hi: number, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);

function parseKey(raw: unknown, duration: number): ClipKey | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const rawJoints = r.joints as Record<string, unknown> | undefined;
  if (typeof rawJoints !== "object" || rawJoints === null) return null;
  const rest = restPose();
  const joints = {} as Record<JointName, Joint>;
  for (const name of JOINTS) {
    const j = rawJoints[name];
    joints[name] = Array.isArray(j) ? [number(j[0], -7, 7), number(j[1], -7, 7), number(j[2], -7, 7)] : rest[name];
  }
  const rawFace = (r.face ?? {}) as Record<string, unknown>;
  const face = {} as Record<FaceField, number>;
  for (const field of FACE_FIELDS) face[field] = number(rawFace[field], -1, 1, rest[field]);
  const rawBody = (r.body ?? {}) as Record<string, unknown>;
  const body = {} as Record<BodyField, number>;
  for (const field of BODY_FIELDS) body[field] = number(rawBody[field], -7, 7, 0);
  body.x = clamp(body.x, -2, 2);
  body.z = clamp(body.z, -2, 2);
  body.y = clamp(body.y, -1, 2);
  const ease = r.ease === "linear" || r.ease === "step" ? r.ease : "smooth";
  return { t: number(r.t, 0, duration), ease, joints, face, body, fistL: r.fistL === true, fistR: r.fistR === true };
}

/** A clip from a friend's file, every number within its range; null when it is not one. */
export function parseClip(raw: unknown): Clip | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isClipAct(r.id) || typeof r.name !== "string") return null;
  const duration = number(r.duration, 0.1, MAX_DURATION, 0);
  if (duration === 0 || !Array.isArray(r.keys) || r.keys.length === 0 || r.keys.length > MAX_KEYS) return null;
  const keys: ClipKey[] = [];
  for (const key of r.keys) {
    const parsed = parseKey(key, duration);
    if (!parsed) return null;
    keys.push(parsed);
  }
  keys.sort((x, y) => x.t - y.t);
  const emoji = typeof r.emoji === "string" && r.emoji.length <= 8 ? r.emoji : "✨";
  return { id: r.id, name: r.name.slice(0, MAX_NAME), emoji, duration, loop: r.loop === true, keys };
}

/** What a character carries with it beyond the model: its motions, and the model itself. */
export type AvatarPack = {
  v: 1;
  /** A model of the gallery, or a file of ours: its address on the server and its key. */
  gallery?: string;
  figure?: string;
  model?: { sha: string; key: string };
  clips: Clip[];
};

const FILE_HASH = /^[a-z2-7]{52}$/;
const FILE_SECRET = /^[a-z2-7]{26}$/;
const GALLERY_ID = /^[a-z0-9]{1,32}$/;
const MAX_CLIPS = 64;

export function parsePack(raw: unknown): AvatarPack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !Array.isArray(r.clips)) return null;
  const clips = r.clips.slice(0, MAX_CLIPS).map(parseClip).filter((c): c is Clip => c !== null);
  const model = r.model as { sha?: unknown; key?: unknown } | undefined;
  const pack: AvatarPack = { v: 1, clips };
  if (typeof r.gallery === "string" && GALLERY_ID.test(r.gallery)) pack.gallery = r.gallery;
  if (typeof r.figure === "string" && r.figure.length <= 96) pack.figure = r.figure;
  if (model && typeof model.sha === "string" && FILE_HASH.test(model.sha) && typeof model.key === "string" && FILE_SECRET.test(model.key)) pack.model = { sha: model.sha, key: model.key };
  return pack;
}

export function mirrorKey(key: ClipKey): ClipKey {
  const swap: Record<string, JointName> = { armL: "armR", foreL: "foreR", handL: "handR", legL: "legR", shinL: "shinR", footL: "footR", armR: "armL", foreR: "foreL", handR: "handL", legR: "legL", shinR: "shinL", footR: "footL" };
  const joints = {} as Record<JointName, Joint>;
  for (const name of JOINTS) {
    const [x, y, z] = key.joints[swap[name] ?? name];
    joints[name] = [x, -y, -z];
  }
  return {
    ...key,
    joints,
    fistL: key.fistR,
    fistR: key.fistL,
    body: { ...key.body, x: -key.body.x, turn: -key.body.turn },
    face: { ...key.face, lookX: -key.face.lookX },
  };
}
