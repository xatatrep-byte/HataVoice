import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { keyFromPose } from "./clip";
import { restPose } from "./motion";
import { easePoints, readBody, readFace, trimKeys, turnFromLeftForward, turnFromLeftUp, type Landmark } from "./capture";

/**
 * A person facing the camera in a T-pose, as the tracker gives it: their left side on the picture's right (+x), y down.
 * `change` moves points by index.
 */
function person(change: Record<number, [number, number, number]> = {}, visibility = 1): Landmark[] {
  const points: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility }));
  const set = (i: number, x: number, y: number, z = 0) => (points[i] = { x, y, z, visibility });
  set(0, 0, -0.62, -0.1); // nose
  set(7, 0.07, -0.6, 0); // left ear
  set(8, -0.07, -0.6, 0);
  set(11, 0.18, -0.45); // shoulders
  set(12, -0.18, -0.45);
  set(13, 0.45, -0.45); // elbows
  set(14, -0.45, -0.45);
  set(15, 0.7, -0.45); // wrists
  set(16, -0.7, -0.45);
  set(23, 0.1, 0); // hips
  set(24, -0.1, 0);
  set(25, 0.1, 0.42); // knees
  set(26, -0.1, 0.42);
  set(27, 0.1, 0.82); // ankles
  set(28, -0.1, 0.82);
  for (const [i, [x, y, z]] of Object.entries(change)) set(Number(i), x, y, z);
  return points;
}

const near = (v: Vector3 | null, x: number, y: number, z: number) => {
  expect(v).not.toBeNull();
  expect(v!.distanceTo(new Vector3(x, y, z).normalize())).toBeLessThan(1e-6);
};

describe("moving with the camera", () => {
  it("reads a T-pose: arms out to their sides, legs down, nothing turned", () => {
    const body = readBody(person(), false);
    near(body.upper.L, 1, 0, 0);
    near(body.fore.R, -1, 0, 0);
    near(body.thigh.L, 0, -1, 0);
    near(body.shin.R, 0, -1, 0);
    expect(body.seen).toBe("full");
    expect(turnFromLeftUp(body.hips!.left, body.hips!.up).angleTo(new Quaternion())).toBeLessThan(1e-6);
    expect(turnFromLeftUp(body.chest!.left, body.chest!.up).angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it("the same hand without a mirror, the hand on the same side of the screen with one", () => {
    // The person raises their right forearm straight up.
    const raised = person({ 16: [-0.45, -0.75, 0] });
    near(readBody(raised, false).fore.R, 0, 1, 0);
    near(readBody(raised, false).fore.L, 1, 0, 0);
    // In a mirror the reflection raises the hand on the same side of the screen: the character's left.
    near(readBody(raised, true).fore.L, 0, 1, 0);
    near(readBody(raised, true).fore.R, -1, 0, 0);
  });

  it("toward the camera is toward us", () => {
    const reaching = person({ 15: [0.45, -0.45, -0.25] });
    near(readBody(reaching, false).fore.L, 0, 0, 1);
  });

  it("sitting at a desk: arms and chest, legs left standing", () => {
    const points = person();
    for (const i of [25, 26, 27, 28]) points[i]!.visibility = 0.1;
    const body = readBody(points, false);
    expect(body.seen).toBe("upper");
    expect(body.thigh.L).toBeNull();
    expect(body.upper.L).not.toBeNull();
  });

  it("sees nobody without shoulders", () => {
    expect(readBody(person({}, 0.2), false).seen).toBe("none");
    expect(readBody(undefined, false).seen).toBe("none");
  });

  it("a head turned to its left looks to +X", () => {
    // The nose moves to the person's left (the picture's right).
    const body = readBody(person({ 0: [0.1, -0.6, -0.02], 7: [0.05, -0.6, 0.07], 8: [-0.05, -0.6, -0.07] }), false);
    const turn = turnFromLeftForward(body.head!.left, body.head!.forward);
    expect(new Vector3(0, 0, 1).applyQuaternion(turn).x).toBeGreaterThan(0.5);
  });

  it("eases points and reads a face", () => {
    const a = [{ x: 0, y: 0, z: 0 }];
    expect(easePoints(a, [{ x: 1, y: 2, z: 3 }], 0.5)[0]).toMatchObject({ x: 0.5, y: 1, z: 1.5 });
    const face = readFace({ jawOpen: 0.5, mouthSmileLeft: 0.8, mouthSmileRight: 0.8, eyeBlinkLeft: 1, eyeBlinkRight: 1 });
    expect(face.mouth).toBeCloseTo(0.7);
    expect(face.smile).toBeCloseTo(1);
    expect(face.eyes).toBe(1);
  });

  it("trims a recording and starts it again from zero", () => {
    const keys = [0, 0.5, 1, 1.5, 2].map((t) => keyFromPose(restPose(), t));
    expect(trimKeys(keys, 0.5, 1.5).map((k) => k.t)).toEqual([0, 0.5, 1]);
  });
});
