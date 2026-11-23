/**
 * The step-by-step editor's emotions: what the character does, in order — ready motions and poses of one's own — each a
 * little slower or faster, once or a few times, with a face. Turned into the constructor's recipe (compose.ts), so it
 * plays and bakes into a clip the same way. Kept on this PC by the clip's id, for editing later.
 */
import { keyFromPose, newClipId, parseClip, type Clip } from "../../characters/clip";
import { poseOfClip } from "../../characters/clipEdit";
import { FACE_LOOKS, layOut, parseRecipe, type FaceLook, type Recipe, type Sampler } from "../../characters/compose";
import type { Pose } from "../../characters/motion";
import { parseSpec, type PoseSpec } from "../../characters/poseSpec";
import { isRecord, loadJson, saveJson } from "../../state/persist";

export type Speed = "slow" | "normal" | "fast";

export const SPEEDS: { value: Speed; label: string; factor: number }[] = [
  { value: "slow", label: "медленно", factor: 0.7 },
  { value: "normal", label: "обычно", factor: 1 },
  { value: "fast", label: "быстро", factor: 1.4 },
];

export const MAX_TIMES = 3;
export const MAX_ITEMS = 24;
/** Seconds between two poses of one's own, as the builder offers them. */
export const GAPS = [
  { value: 0.35, label: "быстро" },
  { value: 0.6, label: "плавно" },
  { value: 1, label: "медленно" },
] as const;

type Common = { id: string; speed: Speed; repeat: number; face: FaceLook | null };
export type ActItem = Common & { kind: "act"; act: string };
/** Poses of one's own: what the builder said, and the clip baked from it on this body. */
export type PoseItem = Common & { kind: "pose"; poses: PoseSpec[]; gap: number; clip: Clip };
export type Item = ActItem | PoseItem;

export type Emotion = { name: string; emoji: string; items: Item[] };
/** By the clip's id. */
export type Emotions = Record<string, Emotion>;

let counter = 0;
export const itemId = () => `i${Date.now().toString(36)}${(counter++).toString(36)}`;

export const actItem = (act: string): ActItem => ({ id: itemId(), kind: "act", act, speed: "normal", repeat: 1, face: null });

const factor = (speed: Speed) => SPEEDS.find((s) => s.value === speed)!.factor;

/** The act an item plays as in the recipe: a ready one by its id, poses of one's own by a name of their own. */
export const itemAct = (item: Item) => (item.kind === "act" ? item.act : `pose${item.id}`);

/** The sampler that also knows the items' own poses. */
export function withPoses(sampler: Sampler, items: Item[]): Sampler {
  const own = new Map<string, Clip>();
  for (const item of items) if (item.kind === "pose") own.set(itemAct(item), item.clip);
  if (own.size === 0) return sampler;
  return {
    length: (act) => own.get(act)?.duration ?? sampler.length(act),
    pose: (act, u) => {
      const clip = own.get(act);
      return clip ? poseOfClip(clip, u) : sampler.pose(act, u);
    },
  };
}

/** The items as the constructor's recipe: one after another, each face over its own item. `sampler` knows the poses. */
export function toRecipe(items: Item[], sampler: Sampler): Recipe {
  const recipe: Recipe = {
    body: items.map((item) => ({ id: item.id, act: itemAct(item), speed: factor(item.speed), repeat: item.repeat, mirror: false, blend: 0.3 })),
    face: [],
  };
  const laid = layOut(recipe, sampler);
  recipe.face = items.flatMap((item, i) => (item.face ? [{ id: `f${item.id}`, look: item.face, start: laid[i]!.start, length: laid[i]!.end - laid[i]!.start }] : []));
  return recipe;
}

/** Poses of one's own as a clip: one after another `gap` apart, the last one held a moment; a single pose a second. */
export function bakePoses(poses: Pose[], gap: number): Clip {
  const keys = poses.map((pose, i) => keyFromPose(pose, i * gap));
  const last = (poses.length - 1) * gap;
  const hold = poses.length === 1 ? 1 : Math.max(0.5, gap);
  keys.push(keyFromPose(poses[poses.length - 1]!, last + hold));
  return { id: newClipId(), name: "Своя поза", emoji: "✋", duration: Math.round((last + hold) * 1000) / 1000, loop: false, keys };
}

const SPEED_VALUES = new Set<string>(SPEEDS.map((s) => s.value));
const FACES = new Set<string>(FACE_LOOKS.map((l) => l.id));

function parseItem(raw: unknown, acts: ReadonlySet<string>): Item | null {
  if (!isRecord(raw)) return null;
  const common: Common = {
    id: itemId(),
    speed: typeof raw.speed === "string" && SPEED_VALUES.has(raw.speed) ? (raw.speed as Speed) : "normal",
    repeat: typeof raw.repeat === "number" && Number.isFinite(raw.repeat) ? Math.min(MAX_TIMES, Math.max(1, Math.round(raw.repeat))) : 1,
    face: typeof raw.face === "string" && FACES.has(raw.face) ? (raw.face as FaceLook) : null,
  };
  if (raw.kind === "act") return typeof raw.act === "string" && acts.has(raw.act) ? { ...common, kind: "act", act: raw.act } : null;
  if (raw.kind !== "pose" || !Array.isArray(raw.poses)) return null;
  const poses = raw.poses.slice(0, 30).map(parseSpec).filter((p): p is PoseSpec => p !== null);
  const clip = parseClip(raw.clip);
  if (poses.length === 0 || !clip) return null;
  const gap = typeof raw.gap === "number" && Number.isFinite(raw.gap) ? Math.min(2, Math.max(0.2, raw.gap)) : 0.6;
  return { ...common, kind: "pose", poses, gap, clip };
}

/** Emotions as kept: anything odd is dropped. `acts`: the ready motions an item may name. */
export function parseEmotions(raw: unknown, acts: ReadonlySet<string>): Emotions {
  if (!isRecord(raw)) return {};
  const out: Emotions = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.items)) continue;
    const items = value.items.slice(0, MAX_ITEMS).map((i) => parseItem(i, acts)).filter((i): i is Item => i !== null);
    out[id] = { name: value.name.slice(0, 32), emoji: typeof value.emoji === "string" ? value.emoji.slice(0, 8) : "✨", items };
  }
  return out;
}

/** Nearest of the three speeds to a constructor piece's. */
const speedOf = (f: number): Speed => (f < 0.85 ? "slow" : f > 1.2 ? "fast" : "normal");

/**
 * What the old constructor kept («Собрать из готовых», by clip id): its pieces become items, and each face goes to the
 * item it covers most of.
 */
export function fromRecipes(raw: unknown, acts: ReadonlySet<string>, sampler: Sampler): Emotions {
  if (!isRecord(raw)) return {};
  const out: Emotions = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.name !== "string") continue;
    const recipe = parseRecipe(value.recipe, acts);
    if (!recipe || recipe.body.length === 0) continue;
    const laid = layOut(recipe, sampler).slice(0, MAX_ITEMS);
    const faces: (FaceLook | null)[] = laid.map(() => null);
    for (const f of recipe.face) {
      let best = -1;
      let most = 0;
      laid.forEach(({ start, end }, i) => {
        const covered = Math.min(end, f.start + f.length) - Math.max(start, f.start);
        if (covered > most) (most = covered), (best = i);
      });
      if (best >= 0) faces[best] = f.look;
    }
    const items: Item[] = laid.map(({ piece }, i) => ({ id: itemId(), kind: "act", act: piece.act, speed: speedOf(piece.speed), repeat: Math.min(MAX_TIMES, piece.repeat), face: faces[i]! }));
    out[id] = { name: value.name.slice(0, 32), emoji: typeof value.emoji === "string" ? value.emoji.slice(0, 8) : "✨", items };
  }
  return out;
}

const KEY = "hatavoice.emotions";
const OLD_KEY = "hatavoice.recipes";
/** Ids deleted here: an old constructor's emotion must not come back from its own list. */
const GONE_KEY = "hatavoice.emotions.gone";

const gone = (): Set<string> => {
  const raw = loadJson(GONE_KEY);
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
};

/** The emotions kept on this PC, and those the old constructor made that are not among them yet. */
export function loadEmotions(acts: ReadonlySet<string>, sampler: Sampler): Emotions {
  const all = { ...fromRecipes(loadJson(OLD_KEY), acts, sampler), ...parseEmotions(loadJson(KEY), acts) };
  for (const id of gone()) delete all[id];
  return all;
}

export function saveEmotions(emotions: Emotions): void {
  saveJson(KEY, emotions);
}

/** Forgets an emotion for good, the old constructor's too. */
export function forgetEmotion(emotions: Emotions, id: string): Emotions {
  const rest = { ...emotions };
  delete rest[id];
  saveJson(GONE_KEY, [...gone(), id].slice(-200));
  saveEmotions(rest);
  return rest;
}
