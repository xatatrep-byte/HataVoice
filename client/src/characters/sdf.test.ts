import { describe, expect, it } from "vitest";
import { blend, capsule, carve, ellipsoid, halfspace, smin, sphere, surfaceNets } from "./sdf";

describe("soft shapes", () => {
  it("measure the distance to a sphere and a capsule", () => {
    expect(sphere(0, 0, 0, 1)(2, 0, 0)).toBeCloseTo(1);
    expect(capsule(0, 0, 0, 0, 2, 0, 0.5)(1, 1, 0)).toBeCloseTo(0.5);
    expect(capsule(0, 0, 0, 0, 2, 0, 1, 0)(0, 2, 0), "narrows to nothing at the far end").toBeCloseTo(0);
    expect(ellipsoid(0, 0, 0, 2, 1, 1)(2, 0, 0)).toBeCloseTo(0, 5);
  });

  it("melt together", () => {
    expect(smin(1, 1, 0.5)).toBeLessThan(1);
    expect(smin(0, 5, 0.5), "far apart: no melting").toBe(0);
    const top = halfspace(sphere(0, 0, 0, 1), 0, 1, 0, 0);
    expect(top(0, 0.5, 0), "keeps what the normal points to").toBeLessThan(0);
    expect(top(0, -0.5, 0), "and cuts the rest").toBeGreaterThan(0);
    const carved = carve(sphere(0, 0, 0, 1), sphere(1, 0, 0, 0.5));
    expect(carved(0.9, 0, 0)).toBeGreaterThan(0);
    expect(carved(-0.9, 0, 0)).toBeLessThan(0);
  });
});

describe("the mesh of a shape", () => {
  const soup = surfaceNets(sphere(0, 0, 0, 1), [-1.3, -1.3, -1.3], [1.3, 1.3, 1.3], 0.1);

  it("lies on the surface, with normals pointing out", () => {
    expect(soup.positions.length).toBeGreaterThan(1000);
    for (let v = 0; v < soup.positions.length; v += 3) {
      const [x, y, z] = [soup.positions[v]!, soup.positions[v + 1]!, soup.positions[v + 2]!];
      expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(0.03);
      expect(x * soup.normals[v]! + y * soup.normals[v + 1]! + z * soup.normals[v + 2]!).toBeGreaterThan(0.97);
    }
  });

  it("is closed, and its triangles face outward", () => {
    const edges = new Map<string, number>();
    for (let t = 0; t < soup.indices.length; t += 3) {
      const [a, b, c] = [soup.indices[t]!, soup.indices[t + 1]!, soup.indices[t + 2]!];
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        const key = p < q ? `${p}-${q}` : `${q}-${p}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
      const p = (i: number) => [soup.positions[i * 3]!, soup.positions[i * 3 + 1]!, soup.positions[i * 3 + 2]!] as const;
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      expect(n[0]! * pa[0] + n[1]! * pa[1] + n[2]! * pa[2], "faces away from the center").toBeGreaterThan(0);
    }
    expect([...edges.values()].every((count) => count === 2)).toBe(true);
  });

  it("melts two shapes into one piece", () => {
    const two = blend(0.3, sphere(-0.5, 0, 0, 0.5), sphere(0.5, 0, 0, 0.5));
    expect(two(0, 0, 0)).toBeLessThan(0);
  });
});
