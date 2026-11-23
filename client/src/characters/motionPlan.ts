/**
 * Which recording a character plays, and where in it: standing, talking and walking blended by voice and speed, and the
 * acts that have a recording of their own (sitting, dancing, nodding…). Acts without one stay drawn by motion.ts; the
 * recording then keeps the rest of the body alive while the drawn act moves the joints it needs.
 */
import { blendFrames, type MotionFrame, type MotionLibrary } from "./mocap";

/** Where an act stands in its recording at `elapsed` of `length` seconds. */
type Cue = { clip: string; time: number };
type Plan = (elapsed: number, length: number, lib: MotionLibrary) => Cue | null;

const len = (lib: MotionLibrary, id: string) => lib.clip(id)?.length ?? 1;

/** In, then held, then out: a recording that starts and ends an act around a loop (sitting down, lying down). */
const around =
  (enter: string, hold: string | null, leave: string, reverseEnter = false): Plan =>
  (e, length, lib) => {
    const a = len(lib, enter);
    const b = len(lib, leave);
    if (e < a) return { clip: enter, time: reverseEnter ? a - e : e };
    if (e > length - b) return { clip: leave, time: e - (length - b) };
    return hold ? { clip: hold, time: e - a } : { clip: enter, time: reverseEnter ? 0 : a };
  };

const loop =
  (clip: string, speed = 1): Plan =>
  (e) => ({ clip, time: e * speed });

/** Played through once; `pace` below 1 plays it calmer (an actor's take is livelier than a figure on a desk looks). */
const once =
  (clip: string, pace = 1): Plan =>
  (e) => ({ clip, time: e * pace });

/** Acts played from recordings, by the one who does them. */
const MINE: Record<string, Plan> = {
  // Gestures recorded on actors (Bandai Namco Research Motion Dataset), the lively ones a little calmer. Each act's
  // length in motion.ts is its take's length over this pace. Its wave is not used: the actor swept a straight arm like a
  // wiper with the wrist hanging and leaned the whole body over, which on a model looked like a broken arm.
  bow: once("bow"),
  cry: once("bow_sad"),
  angry: once("bye_angry", 0.8),
  hooray: once("hooray", 0.85),
  byebye: once("byebye", 0.85),
  call: once("call", 0.9),
  raise: once("respond", 0.9),
  guide: once("guide", 0.9),
  // A joyful hop: the arms and the body from «Ура!», the legs and the flight drawn (see `drawnLegs`).
  jump: once("hooray", 0.85),
  dance: loop("dance"),
  sit: around("sit_in", "sit", "sit_out"),
  no: loop("no"),
  fold: loop("fold"),
  phone: loop("phone"),
  zombie: loop("zombie"),
  // Not from the game library, drawn instead: its roll (a dodge along the floor in a second, for «Сальто»), its fall
  // and getting up (legs flung wide), its nod (with a fist), its spell (a thrust, then frozen), its crate push with a
  // lunge, its pitcher's throw (for a snowball and a heart) and its knock-down: too quick and too rough for a call.
};

/** Pair acts: the one it is done to. */
const THEIRS: Record<string, Plan> = {
  snowball: (e, length) => (e > length * 0.6 ? { clip: "hit_chest", time: e - length * 0.6 } : null),
  heart: (e, length) => (e > length * 0.6 ? { clip: "hit_chest", time: e - length * 0.6 } : null),
  bonk: (e, length) => (e > length * 0.5 ? { clip: "hit_head", time: e - length * 0.5 } : null),
  pie: (e, length) => (e > length * 0.55 ? { clip: "hit_head", time: e - length * 0.55 } : null),
};

/** Acts whose recording moves the upper body only: the drawn act keeps the legs and lifts the whole figure. */
const DRAWN_LEGS = new Set(["jump"]);
export const drawnLegs = (id: string) => DRAWN_LEGS.has(id);

/** Whether an act (for this role) is played from a recording. */
export function recordedAct(id: string, role: "solo" | "actor" | "target"): boolean {
  return role === "target" ? id in THEIRS : id in MINE;
}

/** How fast an act's recording comes in and goes out, seconds. */
const FADE = 0.28;

export type BaseInput = {
  t: number;
  seed: number;
  /** 0–1: how much the character speaks now (smoothed). */
  talking: number;
  /** 0–1 of walking speed. */
  speed: number;
  /** Metres walked, for the walk's phase. */
  distance: number;
  /** The model's hips height, metres: a stride is that many hips heights. */
  hipsHeight: number;
};

/**
 * The body when no recorded act plays: standing (each one a little out of step with the others), talking with the
 * hands as the voice comes, walking in step with the metres covered so the feet do not slide.
 */
export function baseMotion(lib: MotionLibrary, input: BaseInput, out: MotionFrame, scratch: MotionFrame): MotionFrame {
  lib.clip("idle")?.sample(input.t + input.seed * 7.3, out);
  if (input.talking > 0.02) {
    const talk = lib.clip("talk");
    if (talk) blendFrames(out, talk.sample(input.t * 0.95 + input.seed * 3.1, scratch), Math.min(1, input.talking));
  }
  if (input.speed > 0.02) {
    const walk = lib.clip("walk");
    if (walk?.stride) {
      // One cycle of the recording covers `stride` hips heights.
      const cycles = input.distance / (walk.stride * input.hipsHeight);
      blendFrames(out, walk.sample(cycles * walk.length, scratch), Math.min(1, input.speed * 1.4));
    }
  }
  return out;
}

/**
 * The act's recording over the base, faded in at its start and out at its end; false when the act has no recording
 * (for this role) or nothing plays at this moment.
 */
export function actMotion(lib: MotionLibrary, act: { id: string; elapsed: number; length: number; role: "solo" | "actor" | "target" }, base: MotionFrame, scratch: MotionFrame): boolean {
  const plan = act.role === "target" ? THEIRS[act.id] : MINE[act.id];
  if (!plan) return false;
  const cue = plan(act.elapsed, act.length, lib);
  const clip = cue && lib.clip(cue.clip);
  if (!cue || !clip) return false;
  clip.sample(cue.time, scratch);
  const fade = Math.min(1, act.elapsed / FADE, (act.length - act.elapsed) / FADE);
  blendFrames(base, scratch, Math.max(0, fade));
  return true;
}
