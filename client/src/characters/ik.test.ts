import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { aimLocal, twoBone } from "./ik";

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

describe("pulling a limb", () => {
  it("reaches a point in range with both bones keeping their lengths", () => {
    const root = v(0, 1.4, 0);
    const target = v(0.3, 1.1, 0.2);
    const { mid, end } = twoBone(root, 0.3, 0.25, target, v(0, 0, -1));
    expect(end.distanceTo(target)).toBeLessThan(1e-3);
    expect(mid.distanceTo(root)).toBeCloseTo(0.3, 4);
    expect(mid.distanceTo(end)).toBeCloseTo(0.25, 4);
  });

  it("bends toward the pole: elbows back, knees forward", () => {
    const root = v(0, 1, 0);
    const target = v(0, 0.6, 0);
    expect(twoBone(root, 0.3, 0.3, target, v(0, 0, -1)).mid.z).toBeLessThan(0);
    expect(twoBone(root, 0.3, 0.3, target, v(0, 0, 1)).mid.z).toBeGreaterThan(0);
  });

  it("stretches straight toward a point out of reach", () => {
    const root = v(0, 0, 0);
    const { mid, end } = twoBone(root, 0.3, 0.3, v(2, 0, 0), v(0, 1, 0));
    expect(end.x).toBeCloseTo(0.6, 3);
    expect(Math.abs(mid.y)).toBeLessThan(0.01);
  });

  it("does not break when the pole lies along the limb", () => {
    const { mid } = twoBone(v(0, 0, 0), 0.3, 0.3, v(0, -0.4, 0), v(0, -1, 0));
    expect(Number.isFinite(mid.x + mid.y + mid.z)).toBe(true);
  });

  it("aims a bone at a direction from inside a turned parent", () => {
    const parent = new Quaternion().setFromAxisAngle(v(0, 1, 0), Math.PI / 2);
    const local = new Quaternion();
    const child = v(0, -1, 0);
    const want = v(1, 0, 0);
    const turned = aimLocal(parent, local, child, want);
    const now = child.clone().applyQuaternion(turned).applyQuaternion(parent);
    expect(now.distanceTo(want)).toBeLessThan(1e-6);
  });
});
