/**
 * «Своя поза кнопками»: a pose said in plain numbers — where each hand is (how high, forward or to the side, how bent),
 * how the head and the body turn, how the legs stand — instead of joint angles. Each part has ready positions (presets
 * of these numbers) and sliders that move them within ranges where nothing breaks. The hands are placed by the stage's
 * reach (two-bone IK), so an elbow always bends the natural way; everything else is turned here.
 */
import { JOINTS, restPose, type Joint, type Pose } from "./motion";
import type { ReachPose } from "./workshopStage";

/** Where a hand is, from its shoulder: how high (0 hanging – 1 straight up), forward or to the side, how bent. */
export type ArmPlace = {
  /** 0 hanging down – 0.5 level with the shoulder – 1 straight up. */
  raise: number;
  /** Below 0 across in front of the body, 0 forward, 1 out to the side. */
  side: number;
  /** 0 straight – 0.85 folded. */
  bend: number;
};
export type HeadPlace = { turn: number; nod: number; tilt: number };
export type BodyPlace = { bend: number; turn: number; lean: number };
export type LegsPlace = { crouch: number; step: number; wide: number; knee: number };

export type PoseSpec = {
  armR: ArmPlace;
  armL: ArmPlace;
  fistR: boolean;
  fistL: boolean;
  head: HeadPlace;
  body: BodyPlace;
  legs: LegsPlace;
};

export type BodyPart = "head" | "armR" | "armL" | "body" | "legs";

export const RANGES = {
  arm: { raise: [0, 1], side: [-0.6, 1], bend: [0, 0.85] },
  head: { turn: [-1, 1], nod: [-1, 1], tilt: [-1, 1] },
  body: { bend: [-1, 1], turn: [-1, 1], lean: [-1, 1] },
  legs: { crouch: [0, 1], step: [-1, 1], wide: [0, 1], knee: [0, 1] },
} as const;

export type Preset<T> = { id: string; name: string; value: T };

/** For the right arm; the left one takes the same numbers (its «side» is its own left). */
export const ARM_PRESETS: Preset<ArmPlace>[] = [
  { id: "down", name: "Опущена", value: { raise: 0.02, side: 0.15, bend: 0.1 } },
  { id: "side", name: "В сторону", value: { raise: 0.5, side: 1, bend: 0 } },
  { id: "forward", name: "Вперёд", value: { raise: 0.5, side: 0, bend: 0 } },
  { id: "up", name: "Вверх", value: { raise: 0.95, side: 0.25, bend: 0.05 } },
  { id: "wave", name: "Помахать", value: { raise: 0.7, side: 0.95, bend: 0.62 } },
  { id: "hip", name: "На поясе", value: { raise: 0.06, side: 1, bend: 0.66 } },
  { id: "face", name: "У лица", value: { raise: 0.73, side: -0.44, bend: 0.8 } },
  { id: "chest", name: "К груди", value: { raise: 0.33, side: -0.6, bend: 0.83 } },
];

export const HEAD_PRESETS: Preset<HeadPlace>[] = [
  { id: "straight", name: "Прямо", value: { turn: 0, nod: 0, tilt: 0 } },
  { id: "nod", name: "Кивнуть", value: { turn: 0, nod: 0.7, tilt: 0 } },
  { id: "up", name: "Вверх", value: { turn: 0, nod: -0.7, tilt: 0 } },
  { id: "left", name: "Влево", value: { turn: 0.7, nod: 0, tilt: 0 } },
  { id: "right", name: "Вправо", value: { turn: -0.7, nod: 0, tilt: 0 } },
  { id: "tilt", name: "Наклон", value: { turn: 0, nod: 0.1, tilt: 0.7 } },
];

export const BODY_PRESETS: Preset<BodyPlace>[] = [
  { id: "straight", name: "Прямо", value: { bend: 0, turn: 0, lean: 0 } },
  { id: "forward", name: "Вперёд", value: { bend: 0.7, turn: 0, lean: 0 } },
  { id: "back", name: "Назад", value: { bend: -0.6, turn: 0, lean: 0 } },
  { id: "left", name: "Повернуться влево", value: { bend: 0, turn: 0.7, lean: 0 } },
  { id: "right", name: "Повернуться вправо", value: { bend: 0, turn: -0.7, lean: 0 } },
  { id: "lean", name: "Вбок", value: { bend: 0, turn: 0, lean: 0.7 } },
];

export const LEGS_PRESETS: Preset<LegsPlace>[] = [
  { id: "stand", name: "Стоять", value: { crouch: 0, step: 0, wide: 0, knee: 0 } },
  { id: "crouch", name: "Присесть", value: { crouch: 0.6, step: 0, wide: 0.2, knee: 0 } },
  { id: "step", name: "Шаг", value: { crouch: 0.05, step: 0.6, wide: 0, knee: 0 } },
  { id: "lunge", name: "Выпад", value: { crouch: 0.3, step: 1, wide: 0.1, knee: 0 } },
  { id: "wide", name: "Ноги шире", value: { crouch: 0.1, step: 0, wide: 0.9, knee: 0 } },
  { id: "knee", name: "Колено вверх", value: { crouch: 0, step: 0, wide: 0, knee: 0.85 } },
];

const ARM_DOWN = ARM_PRESETS[0]!.value;

export function defaultSpec(): PoseSpec {
  return {
    armR: { ...ARM_DOWN },
    armL: { ...ARM_DOWN },
    fistR: false,
    fistL: false,
    head: { turn: 0, nod: 0, tilt: 0 },
    body: { bend: 0, turn: 0, lean: 0 },
    legs: { crouch: 0, step: 0, wide: 0, knee: 0 },
  };
}

const clamp = (v: number, [a, b]: readonly [number, number]) => Math.min(b, Math.max(a, v));
// `|| 0`: no −0 from a turn of nothing.
const round = (v: number) => Math.round(v * 1000) / 1000 || 0;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function clampPlace<T extends Record<string, number>>(place: T, ranges: Record<keyof T, readonly [number, number]>): T {
  const out = { ...place };
  for (const key of Object.keys(ranges) as (keyof T)[]) out[key] = clamp(place[key], ranges[key]) as T[keyof T];
  return out;
}

/**
 * Where a hand reaches for, from its shoulder, in arm lengths, in the body's own frame (it faces +Z, its left is +X):
 * a direction by the raise and the side, nearer when the elbow bends; where the elbow points: out, down and back for a
 * low hand, down for a raised one. A bent low arm brings its forearm forward, as an arm does.
 */
export function armReach(place: ArmPlace, side: "L" | "R"): ReachPose[number] {
  const out = side === "L" ? 1 : -1;
  const p = clampPlace(place, RANGES.arm);
  // A bent low arm in front brings its forearm forward; one at the side keeps its hand by the hip.
  const theta = (p.raise + p.bend * 0.18 * (1 - p.raise) * Math.max(0, 1 - Math.max(0, p.side))) * Math.PI;
  const phi = (p.side * Math.PI) / 2;
  const reach = 1 - 0.6 * p.bend;
  const dir = [out * Math.sin(theta) * Math.sin(phi), -Math.cos(theta), Math.sin(theta) * Math.cos(phi)];
  const low = [out * 0.9, -0.6, -0.5];
  const high = [out * 0.6, -1, -0.3];
  return {
    part: side === "L" ? "handL" : "handR",
    from: side === "L" ? "armL" : "armR",
    offset: dir.map((v) => round(v * reach)) as [number, number, number],
    pole: low.map((v, i) => round(lerp(v, high[i]!, p.raise))) as [number, number, number],
  };
}

/** Both hands, for the stage's reach. */
export function armsReach(spec: PoseSpec): ReachPose {
  return [armReach(spec.armR, "R"), armReach(spec.armL, "L")];
}

/**
 * Everything but the arms, turned from `base`: the head (the neck takes a little of it), the body (spine and chest
 * share it), the legs (crouching keeps the feet on the floor, a step puts one foot forward and bends the other knee),
 * the fists. The arms stay as they are in `base`: the stage's reach places them.
 */
export function partsToPose(spec: PoseSpec, base: Pose = restPose()): Pose {
  const pose: Pose = { ...base };
  for (const name of JOINTS) pose[name] = [...base[name]] as Joint;
  const head = clampPlace(spec.head, RANGES.head);
  pose.head = [round(head.nod * 0.45), round(head.turn * 0.75), round(head.tilt * 0.35)];
  pose.neck = [round(head.nod * 0.15), round(head.turn * 0.25), round(head.tilt * 0.1)];
  const body = clampPlace(spec.body, RANGES.body);
  pose.spine = [round(body.bend * 0.3), round(body.turn * 0.25), round(body.lean * 0.18)];
  pose.chest = [round(body.bend * 0.25), round(body.turn * 0.3), round(body.lean * 0.15)];

  const legs = clampPlace(spec.legs, RANGES.legs);
  const q = legs.crouch * 0.95;
  const spread = 0.05 + legs.wide * 0.22;
  const legL: Joint = [-q, 0, spread];
  const legR: Joint = [-q, 0, -spread];
  const shinL: Joint = [q * 1.9, 0, 0];
  const shinR: Joint = [q * 1.9, 0, 0];
  // A step: the front foot forward with a soft knee, the back knee bent behind; forward is the right foot.
  const s = legs.step;
  const [front, back] = s >= 0 ? [legR, legL] : [legL, legR];
  const [frontShin, backShin] = s >= 0 ? [shinR, shinL] : [shinL, shinR];
  const a = Math.abs(s);
  front[0] += -0.45 * a;
  frontShin[0] += 0.35 * a;
  back[0] += 0.25 * a;
  backShin[0] += 0.45 * a;
  // The right knee up, standing on the left foot.
  legR[0] += -1.4 * legs.knee;
  shinR[0] += 1.7 * legs.knee;
  pose.legL = legL.map(round) as Joint;
  pose.legR = legR.map(round) as Joint;
  pose.shinL = shinL.map(round) as Joint;
  pose.shinR = shinR.map(round) as Joint;
  pose.footL = [round(-q * 0.9 + 0.2 * a * Math.sign(s)), 0, round(-spread + 0.02)];
  pose.footR = [round(-q * 0.9 - 0.2 * a * Math.sign(s)), 0, round(spread - 0.02)];
  pose.y = round(-(1 - Math.cos(q)) * 0.28 - 0.02 * a);
  pose.fistL = spec.fistL;
  pose.fistR = spec.fistR;
  return pose;
}

/** A pose as kept on this PC: numbers out of range are brought in, anything odd falls back to standing. */
export function parseSpec(raw: unknown): PoseSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const base = defaultSpec();
  const place = <T extends Record<string, number>>(value: unknown, fallback: T, ranges: Record<keyof T, readonly [number, number]>): T => {
    const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const out = { ...fallback };
    for (const key of Object.keys(ranges) as (keyof T & string)[]) {
      const n = v[key];
      if (typeof n === "number" && Number.isFinite(n)) out[key] = clamp(n, ranges[key]) as T[keyof T & string];
    }
    return out;
  };
  return {
    armR: place(r.armR, base.armR, RANGES.arm),
    armL: place(r.armL, base.armL, RANGES.arm),
    fistR: r.fistR === true,
    fistL: r.fistL === true,
    head: place(r.head, base.head, RANGES.head),
    body: place(r.body, base.body, RANGES.body),
    legs: place(r.legs, base.legs, RANGES.legs),
  };
}
