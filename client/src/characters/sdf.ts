/**
 * Soft shapes from distance functions: blobs that melt into each other the way clay does, turned into a mesh once
 * (surface nets). Characters have no model files: their heads, hair and bodies are sculpted here in numbers, so that any
 * hair goes with any head, and a friend's character weighs a few bytes.
 */

export type Sdf = (x: number, y: number, z: number) => number;

export const sphere = (cx: number, cy: number, cz: number, r: number): Sdf => (x, y, z) => Math.hypot(x - cx, y - cy, z - cz) - r;

export const ellipsoid = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): Sdf => (x, y, z) => {
  const [px, py, pz] = [x - cx, y - cy, z - cz];
  const k0 = Math.hypot(px / rx, py / ry, pz / rz);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
};

/** A capsule that may narrow: radius `ra` at one end, `rb` at the other. */
export const capsule = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, ra: number, rb: number = ra): Sdf => {
  const [dx, dy, dz] = [bx - ax, by - ay, bz - az];
  const len2 = dx * dx + dy * dy + dz * dz || 1;
  return (x, y, z) => {
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2));
    return Math.hypot(x - ax - dx * t, y - ay - dy * t, z - az - dz * t) - (ra + (rb - ra) * t);
  };
};

/** Polynomial smooth minimum: `k` is how wide the seam between two shapes melts. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

/** Shapes melted together. */
export const blend = (k: number, ...shapes: Sdf[]): Sdf => (x, y, z) => {
  let d = shapes[0]!(x, y, z);
  for (let i = 1; i < shapes.length; i++) d = smin(d, shapes[i]!(x, y, z), k);
  return d;
};

/** `a` with `b` carved out of it. */
export const carve = (a: Sdf, b: Sdf, k = 0): Sdf => (x, y, z) => -smin(-a(x, y, z), b(x, y, z), k);

/** A shape cut by a plane: keeps what is on the side the normal (nx, ny, nz) points to. */
export const halfspace = (shape: Sdf, nx: number, ny: number, nz: number, offset: number, k = 0): Sdf => (x, y, z) =>
  -smin(-shape(x, y, z), nx * x + ny * y + nz * z - offset, k);

/** A shape widened or thinned by `by`. */
export const inflate = (shape: Sdf, by: number): Sdf => (x, y, z) => shape(x, y, z) - by;

/** The same shape mirrored over the x = 0 plane as well. */
export const mirrorX = (shape: Sdf): Sdf => (x, y, z) => shape(Math.abs(x), y, z);

export type Soup = { positions: Float32Array; normals: Float32Array; indices: Uint32Array };

/**
 * The surface where `sdf` is zero, inside the box from `min` to `max`, with cells of about `cell`. Surface nets: one
 * vertex in each cell the surface crosses, which gives even triangles and needs no lookup tables. Normals come from
 * the function itself, so the shading is as smooth as the shape.
 */
export function surfaceNets(sdf: Sdf, min: readonly [number, number, number], max: readonly [number, number, number], cell: number): Soup {
  const nx = Math.max(2, Math.ceil((max[0] - min[0]) / cell)) + 1;
  const ny = Math.max(2, Math.ceil((max[1] - min[1]) / cell)) + 1;
  const nz = Math.max(2, Math.ceil((max[2] - min[2]) / cell)) + 1;
  const [sx, sy, sz] = [(max[0] - min[0]) / (nx - 1), (max[1] - min[1]) / (ny - 1), (max[2] - min[2]) / (nz - 1)];
  const field = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => i + j * nx + k * nx * ny;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) field[at(i, j, k)] = sdf(min[0] + i * sx, min[1] + j * sy, min[2] + k * sz);
    }
  }

  const vertexOf = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [];
  const CORNERS = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ] as const;
  const EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ] as const;
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const values = CORNERS.map(([a, b, c]) => field[at(i + a, j + b, k + c)]!);
        let px = 0;
        let py = 0;
        let pz = 0;
        let count = 0;
        for (const [a, b] of EDGES) {
          const [va, vb] = [values[a]!, values[b]!];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const [ca, cb] = [CORNERS[a]!, CORNERS[b]!];
          px += ca[0] + (cb[0] - ca[0]) * t;
          py += ca[1] + (cb[1] - ca[1]) * t;
          pz += ca[2] + (cb[2] - ca[2]) * t;
          count++;
        }
        if (!count) continue;
        vertexOf[at(i, j, k)] = positions.length / 3;
        positions.push(min[0] + (i + px / count) * sx, min[1] + (j + py / count) * sy, min[2] + (k + pz / count) * sz);
      }
    }
  }

  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const v = field[at(i, j, k)]!;
        const inside = v < 0;
        if (inside !== field[at(i + 1, j, k)]! < 0) {
          quad(vertexOf[at(i, j - 1, k - 1)]!, vertexOf[at(i, j, k - 1)]!, vertexOf[at(i, j, k)]!, vertexOf[at(i, j - 1, k)]!, !inside);
        }
        if (inside !== field[at(i, j + 1, k)]! < 0) {
          quad(vertexOf[at(i - 1, j, k - 1)]!, vertexOf[at(i - 1, j, k)]!, vertexOf[at(i, j, k)]!, vertexOf[at(i, j, k - 1)]!, !inside);
        }
        if (inside !== field[at(i, j, k + 1)]! < 0) {
          quad(vertexOf[at(i - 1, j - 1, k)]!, vertexOf[at(i, j - 1, k)]!, vertexOf[at(i, j, k)]!, vertexOf[at(i - 1, j, k)]!, !inside);
        }
      }
    }
  }

  const normals = new Float32Array(positions.length);
  const e = Math.min(sx, sy, sz) * 0.5;
  for (let v = 0; v < positions.length; v += 3) {
    const [x, y, z] = [positions[v]!, positions[v + 1]!, positions[v + 2]!];
    const gx = sdf(x + e, y, z) - sdf(x - e, y, z);
    const gy = sdf(x, y + e, z) - sdf(x, y - e, z);
    const gz = sdf(x, y, z + e) - sdf(x, y, z - e);
    const length = Math.hypot(gx, gy, gz) || 1;
    normals[v] = gx / length;
    normals[v + 1] = gy / length;
    normals[v + 2] = gz / length;
  }
  return { positions: new Float32Array(positions), normals, indices: new Uint32Array(indices) };
}
