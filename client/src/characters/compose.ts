/**
 * The motion constructor: ready motions laid one after another on the body's track (each faster or slower, mirrored,
 * repeated, flowing into the next), and faces on a track of their own. A recipe is baked into an ordinary clip, so it
 * plays everywhere a clip does and goes to friends the same way. Pure: what a motion looks like comes from a sampler.
 */
import { Quaternion } from "three";
import { keyFromPose, MAX_DURATION, MAX_KEYS, type Clip, type FaceField } from "./clip";
import { JOINTS, type Joint, type JointName, type Pose } from "./motion";
import { jointQuaternion, quaternionJoint } from "./rig";

export type BodyPiece = {
  id: string;
  /** An act: an emote's id. */
  act: string;
  /** 0.5–2. */
  speed: number;
  /** 1–4 times in a row. */
  repeat: number;
  /** With the other hand (and the other way round). */
  mirror: boolean;
  /** Seconds this piece takes to flow out of the one before it. */
  blend: number;
};

export type FaceLook = "smile" | "laugh" | "surprise" | "angry" | "sad" | "closed" | "blush";

export type FacePiece = { id: string; look: FaceLook; start: number; length: number };

export type Recipe = { body: BodyPiece[]; face: FacePiece[] };

/** What a motion looks like: its length and its pose at a moment; act "" is just standing. */
export type Sampler = { length(act: string): number; pose(act: string, u: number): Pose };

export const FACE_LOOKS: { id: FaceLook; name: string; face: Partial<Record<FaceField, number>> }[] = [
  { id: "smile", name: "Улыбка", face: { smile: 1, happy: 0.35 } },
  { id: "laugh", name: "Смех", face: { smile: 1, happy: 1, mouth: 0.6, mouthWide: 0.6 } },
  { id: "surprise", name: "Удивление", face: { mouth: 0.75, mouthWide: -0.7, brow: 1 } },
  { id: "angry", name: "Злость", face: { browSlant: 1, brow: -0.4, smile: -0.6 } },
  { id: "sad", name: "Грусть", face: { browSlant: -1, smile: -0.7, lookY: -0.4 } },
  { id: "closed", name: "Глаза закрыты", face: { eyes: 1 } },
  { id: "blush", name: "Румянец", face: { blush: 1, smile: 0.4 } },
];

export const SPEED_RANGE = [0.5, 2] as const;
export const MAX_REPEAT = 4;
export const MAX_BLEND = 0.8;
/** How long a face takes to come and to go. */
const FACE_FADE = 0.25;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

let counter = 0;
export const pieceId = () => `p${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newBodyPiece(act: string): BodyPiece {
  return { id: pieceId(), act, speed: 1, repeat: 1, mirror: false, blend: 0.3 };
}

/** How long a piece plays, seconds. */
export function pieceLength(piece: BodyPiece, sampler: Sampler): number {
  return (sampler.length(piece.act) / clamp(piece.speed, SPEED_RANGE[0], SPEED_RANGE[1])) * clamp(Math.round(piece.repeat), 1, MAX_REPEAT);
}

export type Laid = { piece: BodyPiece; start: number; end: number; overlap: number };

/** Where each body piece starts and ends: one after another, each starting as the one before it flows out. */
export function layOut(recipe: Recipe, sampler: Sampler): Laid[] {
  const laid: Laid[] = [];
  let end = 0;
  for (const piece of recipe.body) {
    const length = pieceLength(piece, sampler);
    const before = laid[laid.length - 1];
    const overlap = before ? clamp(piece.blend, 0, Math.min(MAX_BLEND, length / 2, (before.end - before.start) / 2)) : 0;
    const start = Math.max(0, end - overlap);
    laid.push({ piece, start, end: start + length, overlap });
    end = start + length;
  }
  return laid;
}

/** The whole motion's length: the body's pieces and the faces, never longer than a clip may be. */
export function recipeLength(recipe: Recipe, sampler: Sampler): number {
  const laid = layOut(recipe, sampler);
  const body = laid.length ? laid[laid.length - 1]!.end : 0;
  const face = recipe.face.reduce((m, f) => Math.max(m, f.start + f.length), 0);
  return clamp(Math.max(body, face, 0.5), 0.5, MAX_DURATION);
}

const SWAP: Partial<Record<JointName, JointName>> = { armL: "armR", foreL: "foreR", handL: "handR", legL: "legR", shinL: "shinR", footL: "footR", armR: "armL", foreR: "foreL", handR: "handL", legR: "legL", shinR: "shinL", footR: "footL" };

/** The same pose with the other hand: left and right swapped, turns mirrored. */
export function mirrorPose(pose: Pose): Pose {
  const out = { ...pose } as Pose;
  for (const name of JOINTS) {
    const [x, y, z] = pose[SWAP[name] ?? name];
    out[name] = [x, -y, -z];
  }
  out.fistL = pose.fistR;
  out.fistR = pose.fistL;
  out.x = -pose.x;
  out.turn = -pose.turn;
  out.lookX = -pose.lookX;
  return out;
}

const qa = new Quaternion();
const qb = new Quaternion();
const NUMBERS = ["x", "z", "y", "turn", "roll", "mouth", "mouthWide", "smile", "eyes", "happy", "brow", "browSlant", "lookX", "lookY", "blush"] as const;

/** `a` toward `b` by `k`: joints turn the short way, numbers go straight. */
export function blendPoses(a: Pose, b: Pose, k: number): Pose {
  const out = { ...a } as Pose;
  for (const name of JOINTS) {
    jointQuaternion(a[name], qa);
    jointQuaternion(b[name], qb);
    out[name] = quaternionJoint(qa.slerp(qb, k)) as Joint;
  }
  for (const field of NUMBERS) out[field] = a[field] + (b[field] - a[field]) * k;
  out.fistL = k < 0.5 ? a.fistL : b.fistL;
  out.fistR = k < 0.5 ? a.fistR : b.fistR;
  return out;
}

/** The pose of one piece `elapsed` seconds after it started. */
function pieceAt(piece: BodyPiece, elapsed: number, sampler: Sampler): Pose {
  const length = sampler.length(piece.act);
  const played = elapsed * clamp(piece.speed, SPEED_RANGE[0], SPEED_RANGE[1]);
  const total = length * clamp(Math.round(piece.repeat), 1, MAX_REPEAT);
  const u = played >= total ? length : played % length;
  const pose = sampler.pose(piece.act, clamp(u, 0, length));
  return piece.mirror ? mirrorPose(pose) : pose;
}

/** The motion's pose at `t`. */
export function poseOfRecipe(recipe: Recipe, sampler: Sampler, t: number, laid = layOut(recipe, sampler)): Pose {
  let pose: Pose | null = null;
  for (let i = 0; i < laid.length; i++) {
    const { piece, start, end } = laid[i]!;
    if (t < start || t > end) continue;
    const mine = pieceAt(piece, t - start, sampler);
    const next = laid[i + 1];
    // Flowing into the next piece: both play, the next one taking over.
    if (next && t >= next.start && next.overlap > 0) {
      const k = clamp((t - next.start) / next.overlap, 0, 1);
      pose = blendPoses(mine, pieceAt(next.piece, t - next.start, sampler), k * k * (3 - 2 * k));
    } else {
      pose = mine;
    }
    break;
  }
  if (!pose) {
    // Before the first piece, after the last one, or with no pieces: standing, easing in from the last pose.
    const last = laid[laid.length - 1];
    const stand = sampler.pose("", t);
    pose = last && t > last.end ? blendPoses(pieceAt(last.piece, last.end - last.start, sampler), stand, clamp((t - last.end) / 0.4, 0, 1)) : stand;
  }
  for (const face of recipe.face) {
    if (t < face.start || t > face.start + face.length) continue;
    const look = FACE_LOOKS.find((l) => l.id === face.look);
    if (!look) continue;
    const fade = Math.min(FACE_FADE, face.length / 2);
    const k = clamp(Math.min((t - face.start) / fade, (face.start + face.length - t) / fade), 0, 1);
    for (const [field, value] of Object.entries(look.face) as [FaceField, number][]) pose[field] += (value - pose[field]) * k;
  }
  return pose;
}

/** Keys a second in the baked clip: enough for living motion, within what a clip may hold. */
const BAKE_FPS = 15;

/** The recipe as an ordinary clip: a key every fifteenth of a second, the clip's name and look kept. */
export function bakeRecipe(recipe: Recipe, sampler: Sampler, clip: Pick<Clip, "id" | "name" | "emoji">): Clip {
  const duration = recipeLength(recipe, sampler);
  const laid = layOut(recipe, sampler);
  const fps = Math.min(BAKE_FPS, Math.floor((MAX_KEYS - 1) / duration));
  const count = Math.max(1, Math.ceil(duration * fps));
  const keys = Array.from({ length: count + 1 }, (_, i) => {
    const t = Math.min(duration, i / fps);
    return keyFromPose(poseOfRecipe(recipe, sampler, t, laid), t, "linear");
  });
  return { id: clip.id, name: clip.name, emoji: clip.emoji, duration: Math.round(duration * 1000) / 1000, loop: false, keys };
}

/** A recipe as kept on this PC (the clip itself carries only the baked keys): anything odd is dropped. */
export function parseRecipe(raw: unknown, acts: ReadonlySet<string>): Recipe | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { body?: unknown; face?: unknown };
  if (!Array.isArray(r.body) || !Array.isArray(r.face)) return null;
  const num = (v: unknown, a: number, b: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, a, b) : d);
  const body: BodyPiece[] = [];
  for (const p of r.body.slice(0, 60) as Record<string, unknown>[]) {
    if (typeof p?.act !== "string" || !acts.has(p.act)) continue;
    body.push({ id: pieceId(), act: p.act, speed: num(p.speed, SPEED_RANGE[0], SPEED_RANGE[1], 1), repeat: Math.round(num(p.repeat, 1, MAX_REPEAT, 1)), mirror: p.mirror === true, blend: num(p.blend, 0, MAX_BLEND, 0.3) });
  }
  const face: FacePiece[] = [];
  for (const f of r.face.slice(0, 60) as Record<string, unknown>[]) {
    if (!FACE_LOOKS.some((l) => l.id === f?.look)) continue;
    face.push({ id: pieceId(), look: f.look as FaceLook, start: num(f.start, 0, MAX_DURATION, 0), length: num(f.length, 0.3, MAX_DURATION, 1) });
  }
  return { body, face };
}
