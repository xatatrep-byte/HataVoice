import * as THREE from "three";
import { blend, capsule, carve, ellipsoid, halfspace, inflate, mirrorX, sphere, surfaceNets, type Sdf } from "./sdf";

/**
 * Every shape a character is made of, sculpted once and shared by everyone who wears it. Heads, hair and hats are in
 * head units (the skull's radius is 1), and bodies in the units of the stage.
 */

type Box = readonly [readonly [number, number, number], readonly [number, number, number]];

const cache = new Map<string, THREE.BufferGeometry>();

function shared(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geometry = cache.get(key);
  if (!geometry) {
    geometry = make();
    cache.set(key, geometry);
  }
  return geometry;
}

function sculpt(sdf: Sdf, [min, max]: Box, cell: number): THREE.BufferGeometry {
  const soup = surfaceNets(sdf, min, max, cell);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A bent, tapering tube from its joint downward: `ra` at the top, `rb` at the far end, round at both. */
export function limb(length: number, ra: number, rb: number): THREE.BufferGeometry {
  return shared(`limb:${length.toFixed(3)}:${ra.toFixed(3)}:${rb.toFixed(3)}`, () => {
    const points: THREE.Vector2[] = [];
    const rings = 5;
    for (let i = 0; i <= rings; i++) {
      const a = (i / rings) * (Math.PI / 2);
      points.push(new THREE.Vector2(Math.sin(a) * ra, Math.cos(a) * ra));
    }
    // Straight at first: a bent joint's ball hides inside the next tube, and a straight one shows no seam.
    points.push(new THREE.Vector2(ra, -length * 0.22));
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      points.push(new THREE.Vector2(ra + (rb - ra) * t, -length * (0.22 + 0.78 * t)));
    }
    for (let i = 0; i <= rings; i++) {
      const a = (i / rings) * (Math.PI / 2);
      points.push(new THREE.Vector2(Math.cos(a) * rb, -length - Math.sin(a) * rb));
    }
    return new THREE.LatheGeometry(points, 16);
  });
}

// ---------------------------------------------------------------------------------------------------- the head

const HEAD_BOX: Box = [
  [-1.35, -1.25, -1.2],
  [1.35, 1.2, 1.25],
];

export function headShape(): THREE.BufferGeometry {
  return shared("head", () => {
    const skull = ellipsoid(0, 0.04, -0.02, 1, 0.96, 0.95);
    const jaw = ellipsoid(0, -0.36, 0.08, 0.78, 0.62, 0.76);
    const cheeks = mirrorX(sphere(0.5, -0.34, 0.4, 0.34));
    const ears = mirrorX(ellipsoid(0.98, -0.1, -0.04, 0.13, 0.22, 0.14));
    return sculpt(blend(0.04, blend(0.2, skull, jaw, cheeks), ears), HEAD_BOX, 0.075);
  });
}

export const noseShape = () => shared("nose", () => sculpt(ellipsoid(0, 0, 0, 0.1, 0.08, 0.1), [[-0.14, -0.12, -0.14], [0.14, 0.12, 0.14]], 0.03));

// ---------------------------------------------------------------------------------------------------- hair

const HAIR_BOX: Box = [
  [-1.5, -1.6, -1.5],
  [1.5, 1.85, 1.5],
];

/** The opening for the face: everything in front and below the hairline is cut away. */
const faceOpening = ellipsoid(0, -0.56, 0.86, 0.92, 0.98, 0.72);

function cap(lift = 0): Sdf {
  const dome = ellipsoid(0, 0.1 + lift, -0.06, 1.08, 1.0, 1.06);
  return halfspace(carve(dome, faceOpening, 0.09), 0, 1, 0, -0.52, 0.1);
}

function rays(count: number, make: (angle: number, i: number) => Sdf): Sdf[] {
  return Array.from({ length: count }, (_, i) => make((i / count) * Math.PI * 2, i));
}

export type HairStyle = "none" | "short" | "spiky" | "long" | "bun" | "curly" | "mohawk" | "ponytail" | "bob";

const HAIR_SHAPES: Record<Exclude<HairStyle, "none">, () => Sdf> = {
  short: () =>
    blend(
      0.14,
      cap(),
      // A soft parting swept to one side.
      ellipsoid(0.32, 0.76, 0.34, 0.62, 0.32, 0.56),
      ellipsoid(-0.42, 0.72, 0.28, 0.5, 0.3, 0.52),
      mirrorX(capsule(0.94, 0.08, 0.3, 0.97, -0.34, 0.3, 0.13, 0.06)),
    ),
  spiky: () =>
    blend(
      0.08,
      cap(-0.04),
      ...rays(7, (a) => capsule(Math.cos(a) * 0.5, 0.74, Math.sin(a) * 0.5 - 0.06, Math.cos(a) * 0.98, 1.32, Math.sin(a) * 0.98 - 0.06, 0.24, 0.015)),
      capsule(0, 0.84, 0, 0.06, 1.52, 0.02, 0.26, 0.015),
      mirrorX(capsule(0.5, 0.62, 0.62, 0.48, 0.3, 1.08, 0.2, 0.015)),
      capsule(0, 0.62, 0.68, 0.02, 0.26, 1.14, 0.2, 0.015),
    ),
  long: () =>
    carve(
      blend(
        0.16,
        cap(),
        ellipsoid(0, -0.5, -0.5, 0.98, 1.05, 0.52),
        mirrorX(capsule(0.86, -0.1, 0.22, 0.84, -1.12, 0.18, 0.24, 0.13)),
        ellipsoid(0.34, 0.74, 0.34, 0.58, 0.3, 0.56),
      ),
      ellipsoid(0, -0.44, 1.02, 0.78, 0.98, 0.72),
      0.08,
    ),
  bun: () => blend(0.1, cap(), sphere(0, 1.14, -0.28, 0.42), ellipsoid(0, 0.74, 0.3, 0.74, 0.28, 0.52)),
  curly: () => {
    const curls: Sdf[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < 42; i++) {
      const y = 1 - (i / 41) * 1.45;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const [x, z] = [Math.cos(golden * i) * radius, Math.sin(golden * i) * radius];
      if (z > 0.52 && y < 0.52) continue;
      curls.push(sphere(x * 1.08, 0.1 + y * 1.02, z * 1.06 - 0.06, 0.27));
    }
    return blend(0.05, ...curls);
  },
  mohawk: () =>
    blend(
      0.06,
      ...Array.from({ length: 9 }, (_, i) => {
        const a = -0.95 + (i / 8) * 2.5;
        const [y, z] = [Math.cos(a), Math.sin(-a)];
        return capsule(0, 0.04 + y * 0.82, z * 0.82, 0, 0.04 + y * 1.5, z * 1.5, 0.21, 0.03);
      }),
    ),
  ponytail: () =>
    blend(
      0.12,
      cap(),
      ellipsoid(0.26, 0.76, 0.36, 0.66, 0.3, 0.52),
      sphere(0, 0.42, -1.06, 0.2),
    ),
  bob: () =>
    carve(
      blend(
        0.16,
        cap(),
        ellipsoid(0, -0.28, -0.3, 1.14, 0.82, 0.86),
        mirrorX(ellipsoid(1.0, -0.48, 0.28, 0.2, 0.56, 0.32)),
        ellipsoid(0, 0.62, 0.6, 0.86, 0.32, 0.42),
      ),
      ellipsoid(0, -0.56, 1.06, 0.8, 0.9, 0.72),
      0.07,
    ),
};

export function hairShape(style: Exclude<HairStyle, "none">): THREE.BufferGeometry {
  return shared(`hair:${style}`, () => sculpt(HAIR_SHAPES[style](), HAIR_BOX, 0.08));
}

/** What hangs behind a ponytail, from its pivot downward. */
export const tailShape = () =>
  shared("tail", () =>
    sculpt(blend(0.12, capsule(0, 0, 0, 0, -0.34, -0.12, 0.2, 0.25), capsule(0, -0.34, -0.12, 0.02, -0.94, -0.06, 0.25, 0.05)), [[-0.42, -1.1, -0.5], [0.42, 0.26, 0.3]], 0.05),
  );

// ---------------------------------------------------------------------------------------------------- hats

const HAT_BOX: Box = [
  [-2.2, -0.2, -2.2],
  [2.2, 2.7, 2.2],
];

const domePart = (lift: number, rx: number, ry: number, rz: number, floor: number) => halfspace(ellipsoid(0, lift, -0.05, rx, ry, rz), 0, 1, 0, floor, 0.03);

export type HatStyle = "none" | "cap" | "beanie" | "crown" | "cowboy" | "horns" | "bunny" | "cat" | "headphones";

/** A hat's main piece, and an accent piece for its other color. */
const HAT_SHAPES: Partial<Record<HatStyle, { main: () => Sdf; accent?: () => Sdf }>> = {
  cap: {
    main: () => domePart(0.3, 1.12, 0.9, 1.1, 0.38),
    accent: () => {
      const brim = ellipsoid(0, 0.42, 0.98, 0.86, 0.075, 0.74);
      return (x, y, z) => brim(x, y + 0.14 * x * x, z);
    },
  },
  beanie: {
    main: () => blend(0.05, domePart(0.3, 1.13, 1.0, 1.1, 0.34), sphere(0, 1.46, -0.05, 0.27)),
    accent: () => {
      const ring: Sdf = (x, y, z) => Math.hypot(Math.hypot(x / 1.17, (z + 0.05) / 1.14) - 1, (y - 0.42) / 0.19) * 0.17 - 0.14;
      return ring;
    },
  },
  crown: {
    main: () => {
      const band: Sdf = (x, y, z) => {
        const r = Math.hypot(x, z + 0.02);
        const wall = Math.abs(r - 0.68) - 0.06;
        return Math.max(wall, Math.abs(y - 1.03) - 0.2) - 0.02;
      };
      const points = rays(5, (a) => capsule(Math.cos(a + 0.3) * 0.68, 1.16, Math.sin(a + 0.3) * 0.68, Math.cos(a + 0.3) * 0.74, 1.62, Math.sin(a + 0.3) * 0.74, 0.14, 0.02));
      return blend(0.05, band, ...points);
    },
  },
  cowboy: {
    main: () => {
      const crown = blend(0.1, domePart(0.62, 0.95, 0.88, 0.92, 0.4), mirrorX(ellipsoid(0.42, 1.28, -0.05, 0.42, 0.22, 0.6)));
      return carve(crown, ellipsoid(0, 1.7, -0.05, 0.22, 0.34, 0.7), 0.12);
    },
    accent: () => {
      const brim = ellipsoid(0, 0.5, -0.03, 1.9, 0.08, 1.68);
      return (x, y, z) => brim(x, y - 0.2 * x * x + 0.04 * z * z, z);
    },
  },
  horns: {
    main: () => mirrorX(blend(0.05, capsule(0.56, 0.76, 0.12, 0.84, 1.12, 0.1, 0.2, 0.15), capsule(0.84, 1.12, 0.1, 1.0, 1.54, 0.24, 0.15, 0.015))),
  },
  cat: {
    main: () => mirrorX(blend(0.05, capsule(0.62, 0.76, 0, 0.7, 1.08, 0, 0.27, 0.2), capsule(0.7, 1.08, 0, 0.82, 1.44, 0, 0.2, 0.02))),
    accent: () => mirrorX(capsule(0.68, 0.94, 0.14, 0.78, 1.28, 0.12, 0.13, 0.02)),
  },
  headphones: {
    main: () => {
      const band: Sdf = (x, y, z) => Math.hypot(Math.hypot(x, Math.max(y - 0.1, 0)) - 1.12, z) - 0.07;
      return band;
    },
    accent: () => mirrorX(ellipsoid(1.1, 0, 0, 0.17, 0.4, 0.32)),
  },
};

export function hatShape(style: HatStyle, part: "main" | "accent"): THREE.BufferGeometry | null {
  const parts = HAT_SHAPES[style];
  const make = parts?.[part];
  if (!make) return null;
  const box: Box = style === "headphones" ? [[-1.5, -0.6, -0.6], [1.5, 1.5, 0.6]] : HAT_BOX;
  return shared(`hat:${style}:${part}`, () => sculpt(make(), box, style === "cowboy" || style === "crown" ? 0.07 : 0.075));
}

/** A bunny's ear, from its pivot upward. */
export const earShape = () =>
  shared("ear", () => sculpt(blend(0.08, capsule(0, 0, 0, 0, 0.5, 0, 0.13, 0.2), capsule(0, 0.5, 0, 0.02, 1.2, 0, 0.2, 0.07)), [[-0.32, -0.2, -0.3], [0.32, 1.4, 0.3]], 0.05));

// ---------------------------------------------------------------------------------------------------- hands, feet

export const handShape = () =>
  shared("hand", () =>
    sculpt(
      blend(0.012, ellipsoid(0, -0.035, 0, 0.042, 0.052, 0.034), capsule(0.034, -0.026, 0.012, 0.058, -0.06, 0.022, 0.016, 0.012)),
      [[-0.07, -0.12, -0.06], [0.1, 0.04, 0.07]],
      0.008,
    ),
  );

/** A fist, for whoever makes one. */
export const fistShape = () =>
  shared("fist", () => sculpt(blend(0.014, ellipsoid(0, -0.03, 0, 0.044, 0.042, 0.04), capsule(0.022, -0.022, 0.03, -0.012, -0.022, 0.044, 0.014)), [[-0.07, -0.09, -0.06], [0.07, 0.03, 0.08]], 0.008));

const shoeBody = () =>
  blend(0.03, ellipsoid(0, 0.045, 0.045, 0.062, 0.05, 0.105), capsule(0, 0.08, -0.018, 0, 0.12, -0.02, 0.054, 0.05), ellipsoid(0, 0.04, -0.03, 0.06, 0.045, 0.062));

const SHOE_BOX: Box = [[-0.1, -0.02, -0.12], [0.1, 0.19, 0.19]];

export const shoeShape = () => shared("shoe", () => sculpt(halfspace(shoeBody(), 0, 1, 0, 0.018), SHOE_BOX, 0.01));
export const soleShape = () => shared("sole", () => sculpt(halfspace(halfspace(inflate(shoeBody(), 0.005), 0, 1, 0, 0), 0, -1, 0, -0.024), SHOE_BOX, 0.009));

// ---------------------------------------------------------------------------------------------------- bodies

export type BodyBuild = {
  /** Half widths. */
  shoulders: number;
  waist: number;
  depth: number;
  /** From the hips to the base of the neck. */
  torso: number;
  thigh: number;
  shin: number;
  armUpper: number;
  armLower: number;
  limb: number;
  /** The radius of the head. */
  head: number;
};

export const BUILDS: Record<"round" | "tall" | "chunky", BodyBuild> = {
  round: { shoulders: 0.165, waist: 0.17, depth: 0.135, torso: 0.34, thigh: 0.16, shin: 0.15, armUpper: 0.145, armLower: 0.135, limb: 0.058, head: 0.265 },
  tall: { shoulders: 0.15, waist: 0.112, depth: 0.098, torso: 0.4, thigh: 0.225, shin: 0.215, armUpper: 0.185, armLower: 0.17, limb: 0.046, head: 0.23 },
  chunky: { shoulders: 0.225, waist: 0.178, depth: 0.14, torso: 0.36, thigh: 0.155, shin: 0.145, armUpper: 0.15, armLower: 0.14, limb: 0.072, head: 0.24 },
};

export type TopStyle = "hoodie" | "tee" | "suit" | "dress";

/** The upper body from the waist up, its origin at the hips. Clothes are the shape: nobody is shirtless here. */
export function torsoShape(body: keyof typeof BUILDS, top: TopStyle): THREE.BufferGeometry {
  return shared(`torso:${body}:${top}`, () => {
    const b = BUILDS[body];
    const h = b.torso;
    const hem = top === "dress" ? ellipsoid(0, -h * 0.06, 0, b.waist * 1.3, h * 0.42, b.depth * 1.28) : ellipsoid(0, h * 0.04, 0, b.waist * 1.04, h * 0.2, b.depth * 1.06);
    const shape = blend(
      0.09,
      ellipsoid(0, h * 0.42, 0, b.waist, h * 0.48, b.depth),
      ellipsoid(0, h * 0.72, 0, b.shoulders * 0.98, h * 0.3, b.depth * 0.92),
      mirrorX(sphere(b.shoulders * 0.86, h * 0.84, 0, b.limb * 1.14)),
      hem,
      top === "hoodie" ? ellipsoid(0, h * 1.0, -b.depth * 0.52, b.shoulders * 0.68, h * 0.17, b.depth * 0.62) : sphere(0, h * 0.94, 0, b.limb * 0.7),
    );
    const size = Math.max(b.shoulders, b.waist) * 1.55;
    return sculpt(shape, [[-size, -h * 0.5, -size], [size, h * 1.3, size]], 0.018);
  });
}

export function pelvisShape(body: keyof typeof BUILDS): THREE.BufferGeometry {
  return shared(`pelvis:${body}`, () => {
    const b = BUILDS[body];
    const shape = blend(0.04, ellipsoid(0, 0.0, 0, b.waist * 0.84, 0.085, b.depth * 0.82), mirrorX(sphere(b.waist * 0.5, -0.04, 0, b.limb * 1.14)));
    const size = b.waist * 1.3;
    return sculpt(shape, [[-size, -0.18, -size], [size, 0.15, size]], 0.016);
  });
}

/** A collar under the chin: where the neck goes into the clothes. */
export const neckShape = (radius: number) => limb(0.06, radius, radius * 1.1);

// ---------------------------------------------------------------------------------------------------- what else one wears

export const glassesShape = () =>
  shared("glasses", () => {
    const rim: Sdf = (x, y, z) => {
      const lens = Math.abs(Math.hypot((Math.abs(x) - 0.38) / 1.1, y) - 0.24) - 0.022;
      return Math.max(lens, Math.abs(z - 0.92) - 0.025) - 0.006;
    };
    const bridge = capsule(-0.14, 0.03, 0.94, 0.14, 0.03, 0.94, 0.022);
    return sculpt(blend(0.012, rim, bridge), [[-0.76, -0.34, 0.8], [0.76, 0.34, 1.04]], 0.018);
  });

export const shadesShape = () =>
  shared("shades", () => {
    const lens = mirrorX(ellipsoid(0.39, -0.01, 0.9, 0.29, 0.21, 0.07));
    const bridge = capsule(-0.14, 0.04, 0.97, 0.14, 0.04, 0.97, 0.03);
    const arms = mirrorX(capsule(0.64, 0.04, 0.82, 1.0, 0.03, 0.08, 0.025));
    return sculpt(blend(0.02, lens, bridge, arms), [[-1.1, -0.3, 0], [1.1, 0.3, 1.06]], 0.024);
  });

export const beardShape = () =>
  shared("beard", () => {
    const beard = carve(blend(0.1, ellipsoid(0, -0.58, 0.32, 0.72, 0.5, 0.6), mirrorX(capsule(0.72, -0.32, 0.34, 0.5, -0.62, 0.54, 0.12))), ellipsoid(0, -0.36, 0.98, 0.34, 0.14, 0.3), 0.05);
    const trimmed = carve(beard, ellipsoid(0, -0.1, 0.5, 0.68, 0.34, 0.72), 0.06);
    return sculpt(trimmed, [[-0.95, -1.15, -0.25], [0.95, -0.05, 1.05]], 0.05);
  });

export const scarfShape = (radius: number) =>
  shared(`scarf:${radius.toFixed(3)}`, () => {
    const ring: Sdf = (x, y, z) => Math.hypot(Math.hypot(x, z) - radius, y / 0.8) - radius * 0.46;
    const tail = capsule(radius * 0.6, -0.01, radius * 0.9, radius * 0.7, -0.16, radius * 1.1, radius * 0.34, radius * 0.3);
    const size = radius * 2;
    return sculpt(blend(0.01, ring, tail), [[-size, -0.24, -size], [size, 0.1, size * 1.2]], 0.012);
  });

export const backpackShape = () =>
  shared("backpack", () =>
    sculpt(blend(0.03, ellipsoid(0, 0.14, -0.04, 0.14, 0.17, 0.08), ellipsoid(0, 0.06, -0.09, 0.09, 0.07, 0.05)), [[-0.2, -0.08, -0.2], [0.2, 0.36, 0.1]], 0.016),
  );

export function capeShape(width: number, length: number): THREE.BufferGeometry {
  return shared(`cape:${width.toFixed(2)}:${length.toFixed(2)}`, () => {
    const segments = 8;
    const across = 8;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let j = 0; j <= segments; j++) {
      const v = j / segments;
      for (let i = 0; i <= across; i++) {
        const u = i / across - 0.5;
        const spread = width * (0.65 + 0.55 * v);
        positions.push(u * spread * 2, -v * length, -0.02 - 0.03 * Math.cos(u * Math.PI) - 0.03 * v);
      }
    }
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < across; i++) {
        const a = j * (across + 1) + i;
        indices.push(a, a + across + 1, a + 1, a + 1, a + across + 1, a + across + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  });
}
