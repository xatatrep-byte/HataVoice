/**
 * Moving with the camera: the body's points that the pose tracker sees, turned into where each limb points and how the
 * hips, the chest and the head are turned, in the character's own space (it faces us, its left is +X, up is +Y). The
 * stage then aims its bones that way. A mirror makes the character move like a reflection: raise the right hand and the
 * hand on the same side of the screen goes up. Pure.
 */
import { Matrix4, Quaternion, Vector3 } from "three";
import type { ClipKey } from "./clip";

/** A point the tracker gives: metres from between the hips, x to the picture's right, y down, z away from the camera. */
export type Landmark = { x: number; y: number; z: number; visibility?: number };

/** The tracker's points (MediaPipe Pose): the person's own left and right. */
const P = { nose: 0, earL: 7, earR: 8, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28 } as const;

export type Side = "L" | "R";
export type Body = {
  /** Where each bone points (unit vectors), by the character's side; null where the camera does not see it. */
  upper: Record<Side, Vector3 | null>;
  fore: Record<Side, Vector3 | null>;
  thigh: Record<Side, Vector3 | null>;
  shin: Record<Side, Vector3 | null>;
  /** The hips' and the chest's turn: their right-to-left line and their up. */
  hips: { left: Vector3; up: Vector3 } | null;
  chest: { left: Vector3; up: Vector3 } | null;
  /** The head's left line and where the face looks. */
  head: { left: Vector3; forward: Vector3 } | null;
  /** How much of the body the camera sees. */
  seen: "full" | "upper" | "none";
};

const SEEN = 0.5;

/** The character's body from the tracker's points; `mirror` moves it as a reflection of the person. */
export function readBody(points: Landmark[] | undefined, mirror: boolean): Body {
  const none: Body = { upper: { L: null, R: null }, fore: { L: null, R: null }, thigh: { L: null, R: null }, shin: { L: null, R: null }, hips: null, chest: null, head: null, seen: "none" };
  if (!points || points.length < 33) return none;
  const at = (i: number) => {
    const p = points[i]!;
    return new Vector3(mirror ? -p.x : p.x, -p.y, -p.z);
  };
  const seen = (...ids: number[]) => ids.every((i) => (points[i]!.visibility ?? 1) >= SEEN);
  // The person's side that drives the character's side: the same one, or the other one in a mirror.
  const of = (side: Side, left: number, right: number) => ((side === "L") !== mirror ? left : right);
  const dir = (from: number, to: number) => at(to).sub(at(from)).normalize();

  const body = none;
  if (!seen(P.shoulderL, P.shoulderR)) return body;
  for (const side of ["L", "R"] as const) {
    const shoulder = of(side, P.shoulderL, P.shoulderR);
    const elbow = of(side, P.elbowL, P.elbowR);
    const wrist = of(side, P.wristL, P.wristR);
    if (seen(shoulder, elbow)) body.upper[side] = dir(shoulder, elbow);
    if (seen(elbow, wrist)) body.fore[side] = dir(elbow, wrist);
    const hip = of(side, P.hipL, P.hipR);
    const knee = of(side, P.kneeL, P.kneeR);
    const ankle = of(side, P.ankleL, P.ankleR);
    if (seen(hip, knee, ankle)) {
      body.thigh[side] = dir(hip, knee);
      body.shin[side] = dir(knee, ankle);
    }
  }
  const hipsSeen = seen(P.hipL, P.hipR);
  const shoulderMid = at(P.shoulderL).add(at(P.shoulderR)).multiplyScalar(0.5);
  const hipMid = at(P.hipL).add(at(P.hipR)).multiplyScalar(0.5);
  const up = hipsSeen ? shoulderMid.clone().sub(hipMid).normalize() : new Vector3(0, 1, 0);
  const lineOf = (left: number, right: number) => at(of("L", left, right)).sub(at(of("R", left, right))).normalize();
  body.chest = { left: lineOf(P.shoulderL, P.shoulderR), up };
  if (hipsSeen) body.hips = { left: lineOf(P.hipL, P.hipR), up };
  if (seen(P.earL, P.earR, P.nose)) {
    const earMid = at(P.earL).add(at(P.earR)).multiplyScalar(0.5);
    body.head = { left: lineOf(P.earL, P.earR), forward: at(P.nose).sub(earMid).normalize() };
  }
  body.seen = body.thigh.L && body.thigh.R ? "full" : "upper";
  return body;
}

/** A turn from a left line and an up: facing us with nothing turned is no turn at all. */
export function turnFromLeftUp(left: Vector3, up: Vector3, out = new Quaternion()): Quaternion {
  const x = left.clone().normalize();
  const z = x.clone().cross(up).normalize();
  const y = z.clone().cross(x).normalize();
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/** A turn from a left line and where it looks (the head). */
export function turnFromLeftForward(left: Vector3, forward: Vector3, out = new Quaternion()): Quaternion {
  const z = forward.clone().normalize();
  const x = left.clone().sub(z.clone().multiplyScalar(left.dot(z))).normalize();
  const y = z.clone().cross(x).normalize();
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/** Points eased toward the new ones, so the character does not shake with the tracker's noise. */
export function easePoints(previous: Landmark[] | null, next: Landmark[], k: number): Landmark[] {
  if (!previous || previous.length !== next.length) return next.map((p) => ({ ...p }));
  return next.map((p, i) => {
    const q = previous[i]!;
    return { x: q.x + (p.x - q.x) * k, y: q.y + (p.y - q.y) * k, z: q.z + (p.z - q.z) * k, visibility: p.visibility };
  });
}

/** The face from the tracker's blendshapes (0–1 each), as the character's face. */
export function readFace(shapes: Record<string, number>): { mouth: number; smile: number; eyes: number; happy: number; brow: number; mouthWide: number } {
  const s = (name: string) => shapes[name] ?? 0;
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  return {
    mouth: clamp(s("jawOpen") * 1.4, 0, 1),
    mouthWide: clamp((s("mouthStretchLeft") + s("mouthStretchRight")) * 0.8 - s("mouthPucker") * 1.2, -1, 1),
    smile: clamp((s("mouthSmileLeft") + s("mouthSmileRight")) * 0.75 - (s("mouthFrownLeft") + s("mouthFrownRight")) * 0.75, -1, 1),
    eyes: clamp(((s("eyeBlinkLeft") + s("eyeBlinkRight")) / 2 - 0.15) * 1.6, 0, 1),
    happy: clamp((s("cheekSquintLeft") + s("cheekSquintRight")) * 0.8, 0, 1),
    brow: clamp(s("browInnerUp") * 1.3 - (s("browDownLeft") + s("browDownRight")) * 0.7, -1, 1),
  };
}

/** The keys of a recording between `from` and `to` seconds, starting again from 0. */
export function trimKeys(keys: ClipKey[], from: number, to: number): ClipKey[] {
  return keys.filter((k) => k.t >= from - 1e-6 && k.t <= to + 1e-6).map((k) => ({ ...k, t: Math.round((k.t - from) * 1000) / 1000 }));
}
