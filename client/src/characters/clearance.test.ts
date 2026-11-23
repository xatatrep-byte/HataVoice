import { describe, expect, it } from "vitest";
import { armPush, buildProfile, MAX_PUSH, reachAt } from "./clearance";

/** A body in a wide skirt: a cone from the hem (y 0.4, radius 0.45) to the waist (y 0.8, radius 0.12), then a torso. */
function girlInASkirt(): number[] {
  const points: number[] = [];
  for (let y = 0.4; y <= 1.25; y += 0.01) {
    const radius = y < 0.8 ? 0.12 + ((0.8 - y) / 0.4) * 0.33 : 0.14;
    for (let a = 0; a < Math.PI * 2; a += 0.05) points.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
  }
  return points;
}

const shoulder = { x: 0.18, y: 1.2, z: 0 };
/** A left arm hanging almost straight down beside the body. */
const hanging = [
  { x: 0.2, y: 0.95, z: 0 },
  { x: 0.22, y: 0.72, z: 0.02 },
  { x: 0.23, y: 0.62, z: 0.03 },
];

/** The points turned out from the shoulder by `angle` in the front plane. */
function turnedOut(points: typeof hanging, side: 1 | -1, angle: number) {
  return points.map((p) => {
    const dx = p.x - shoulder.x * side;
    const dy = p.y - shoulder.y;
    const c = Math.cos(angle * side);
    const s = Math.sin(angle * side);
    return { x: shoulder.x * side + dx * c - dy * s, y: shoulder.y + dx * s + dy * c, z: p.z };
  });
}

describe("arms clear of the body", () => {
  const profile = buildProfile(girlInASkirt())!;

  it("knows how far the body reaches at each height and depth", () => {
    expect(reachAt(profile, 1, 1.0, 0)).toBeCloseTo(0.14, 1);
    expect(reachAt(profile, -1, 0.45, 0)).toBeGreaterThan(0.38);
    expect(reachAt(profile, 1, 2, 0)).toBe(-Infinity);
  });

  it("turns a hand that hangs inside the skirt out just enough to lie on it", () => {
    const push = armPush(profile, 1, shoulder, hanging, 0.03);
    expect(push).toBeGreaterThan(0.08);
    expect(push).toBeLessThan(MAX_PUSH);
    for (const p of turnedOut(hanging, 1, push)) expect(p.x + 0.005).toBeGreaterThanOrEqual(reachAt(profile, 1, p.y, p.z) + 0.03 - 0.02);
    // The right arm, the same on the other side.
    const mirrored = hanging.map((p) => ({ ...p, x: -p.x }));
    expect(armPush(profile, -1, { ...shoulder, x: -shoulder.x }, mirrored, 0.03)).toBeCloseTo(push, 2);
  });

  it("leaves alone an arm that is clear, raised, or crossed over in front", () => {
    expect(armPush(profile, 1, shoulder, turnedOut(hanging, 1, 0.5), 0.03)).toBe(0);
    expect(armPush(profile, 1, shoulder, [{ x: 0.3, y: 1.4, z: 0 }], 0.03)).toBe(0);
    expect(armPush(profile, 1, shoulder, [{ x: -0.05, y: 0.9, z: 0.1 }], 0.03)).toBe(0);
  });

  it("never turns an arm out further than a pose can bear", () => {
    const deep = [{ x: 0.01, y: 0.5, z: 0 }];
    expect(armPush(profile, 1, shoulder, deep, 0.05)).toBe(MAX_PUSH);
  });

  it("has nothing to measure without a body", () => {
    expect(buildProfile([])).toBeNull();
  });
});
