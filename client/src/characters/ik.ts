/**
 * Posing by pulling a hand, a foot or the head: the elbow or the knee finds its place by itself. Two bones (upper arm
 * and forearm, thigh and shin) reach for a point in the plane a pole gives (where the elbow or the knee points), and each
 * bone is turned to aim at its child with as little twist as can be.
 */
import { Quaternion, Vector3 } from "three";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * Where the middle joint goes and where the end lands when two bones of lengths `a` and `b` from `root` reach for
 * `target`, bending toward `pole`. Out of reach, the limb stretches straight toward the target.
 */
export function twoBone(root: Vector3, a: number, b: number, target: Vector3, pole: Vector3): { mid: Vector3; end: Vector3 } {
  const toward = target.clone().sub(root);
  const far = toward.length();
  const dir = far > 1e-6 ? toward.divideScalar(far) : new Vector3(0, -1, 0);
  const d = clamp(far, Math.abs(a - b) + 1e-4, a + b - 1e-4);
  const cos = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  // The bend: the pole without its part along the limb.
  const bend = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir)));
  if (bend.lengthSq() < 1e-10) bend.set(dir.y, -dir.x, 0).lengthSq() < 1e-10 ? bend.set(0, 0, 1) : bend.normalize();
  bend.normalize();
  const mid = root.clone().addScaledVector(dir, a * cos).addScaledVector(bend, a * sin);
  const end = root.clone().addScaledVector(dir, d);
  return { mid, end };
}

/**
 * The bone's new local turn so that `child` (an offset in the bone's own frame: where its child joint is) points along
 * `worldDir`; `parentWorld` is the parent's turn in the world. The smallest swing does it, so the bone does not twist.
 */
export function aimLocal(parentWorld: Quaternion, local: Quaternion, child: Vector3, worldDir: Vector3): Quaternion {
  const now = child.clone().normalize().applyQuaternion(local).applyQuaternion(parentWorld);
  const want = worldDir.clone().normalize();
  const swing = new Quaternion().setFromUnitVectors(now, want);
  return parentWorld.clone().invert().multiply(swing).multiply(parentWorld).multiply(local).normalize();
}
