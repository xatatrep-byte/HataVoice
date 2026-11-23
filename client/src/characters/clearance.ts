/**
 * Keeping a model's arms out of its own body and clothes. A pose is written once for every model, but a girl in a wide
 * skirt and a thin devil differ: arms that hang right on one go through the other. So each model's body (all of it but
 * the arms and the head, clothes included) is measured once, as how far it reaches to each side at each height and depth,
 * and an arm whose elbow or hand would be inside is turned out from the shoulder just enough to lie on top.
 */

/** How far the body reaches to the left (+x) and to the right (−x), in cells of `step` over height (y) and depth (z). */
export type BodyProfile = {
  step: number;
  y0: number;
  z0: number;
  ny: number;
  nz: number;
  /** The furthest reach to the left in each cell, −Infinity where there is no body. */
  left: Float32Array;
  /** The furthest reach to the right, as a positive distance; −Infinity where there is no body. */
  right: Float32Array;
};

/** The profile of a body from its points (x, y, z, x, y, z, …), in the model's own frame: it faces +z, its left is +x. */
export function buildProfile(points: ArrayLike<number>, step = 0.025): BodyProfile | null {
  const count = Math.floor(points.length / 3);
  if (count === 0) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const y = points[i * 3 + 1]!;
    const z = points[i * 3 + 2]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const ny = Math.max(1, Math.ceil((maxY - minY) / step) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / step) + 1);
  const raw = { left: new Float32Array(ny * nz).fill(-Infinity), right: new Float32Array(ny * nz).fill(-Infinity) };
  for (let i = 0; i < count; i++) {
    const x = points[i * 3]!;
    const cell = Math.floor((points[i * 3 + 1]! - minY) / step) * nz + Math.floor((points[i * 3 + 2]! - minZ) / step);
    if (x > raw.left[cell]!) raw.left[cell] = x;
    if (-x > raw.right[cell]!) raw.right[cell] = -x;
  }
  // Each cell takes its neighbours too: a hand between two cells of a skirt is still at the skirt.
  const grow = (from: Float32Array) => {
    const to = new Float32Array(ny * nz).fill(-Infinity);
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        let reach = -Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const cy = y + dy;
            const cz = z + dz;
            if (cy >= 0 && cy < ny && cz >= 0 && cz < nz) reach = Math.max(reach, from[cy * nz + cz]!);
          }
        }
        to[y * nz + z] = reach;
      }
    }
    return to;
  };
  return { step, y0: minY, z0: minZ, ny, nz, left: grow(raw.left), right: grow(raw.right) };
}

/** How far the body reaches outward on `side` (1 the left, −1 the right) at a height and depth; −Infinity: nothing there. */
export function reachAt(profile: BodyProfile, side: 1 | -1, y: number, z: number): number {
  const cy = Math.floor((y - profile.y0) / profile.step);
  const cz = Math.floor((z - profile.z0) / profile.step);
  if (cy < 0 || cy >= profile.ny || cz < 0 || cz >= profile.nz) return -Infinity;
  return (side > 0 ? profile.left : profile.right)[cy * profile.nz + cz]!;
}

type Point = { x: number; y: number; z: number };

/** The most an arm is turned out: past this a pose would stop looking like itself. */
export const MAX_PUSH = 0.7;

/**
 * How much an arm on `side` has to turn out from the shoulder (radians, 0 if not at all) so that none of `points` (elbow,
 * wrist, fingertips) is inside the body, with `margin` for the arm's own thickness. Only what hangs below the shoulder
 * and on its own side counts: a hand raised, or crossed over in front, is not beside the body.
 */
export function armPush(profile: BodyProfile, side: 1 | -1, shoulder: Point, points: Point[], margin: number): number {
  let need = 0;
  for (const p of points) {
    const below = shoulder.y - p.y;
    if (below < 0.08) continue;
    const out = side * p.x;
    if (out <= 0) continue;
    const reach = reachAt(profile, side, p.y, p.z);
    if (reach === -Infinity) continue;
    const deficit = reach + margin - out;
    if (deficit <= 0) continue;
    // Turning by α moves a point hanging `below` the shoulder out by about below·sin α.
    need = Math.max(need, Math.asin(Math.min(1, deficit / Math.max(0.12, below))) * 1.12);
  }
  return Math.min(MAX_PUSH, need);
}
