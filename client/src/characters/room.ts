import * as THREE from "three";

/**
 * Where a call's characters stand, in one of three looks, each with its own light:
 * - «Ночь»: a studio at night. A curved backdrop going from graphite into the dark, a round stage with a thin line of
 *   light at its edge, a soft glow of the accent behind the people, and dust drifting in the light.
 * - «Студия»: a photo studio. One seamless light-grey surface from the floor up the back wall, big soft light, soft
 *   shadows: the models look as in a product photo.
 * - «Закат»: a wooden terrace at sundown. A sky from gold at the horizon to violet above, hills far away, a low warm sun
 *   with long shadows, motes of light drifting.
 * All drawn in code, so it weighs nothing.
 */

function painted(width: number, height: number, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.Texture {
  const canvas = typeof document === "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  paint(canvas.getContext("2d") as CanvasRenderingContext2D, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A number between 0 and 1 that stays the same for the same `i`. */
const hash = (i: number) => {
  const v = Math.sin(i * 91.17 + 3.3) * 43758.5453;
  return v - Math.floor(v);
};

/** The color everything fades into far away. */
export const STAGE_DARK = 0x0b0d11;

/** A soft round spot: white in the middle, nothing at the edge. */
export function softSpot(size = 128): THREE.Texture {
  return painted(size, size, (g, w, h) => {
    const r = w / 2;
    const glow = g.createRadialGradient(r, h / 2, 0, r, h / 2, r);
    glow.addColorStop(0, "rgba(255,255,255,1)");
    glow.addColorStop(0.35, "rgba(255,255,255,0.55)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
  });
}

import type { StageLook } from "./stageLook";
export type { StageLook };

/** How a look is lit: colors as 0xrrggbb, intensities, the key light's place. */
export type RoomLight = {
  background: number;
  fog: [color: number, near: number, far: number];
  hemisphere: [sky: number, ground: number, intensity: number];
  key: [color: number, intensity: number];
  keyAt: [number, number, number];
  rim: [color: number, intensity: number];
  rimAt: [number, number, number];
  /** The accent's colored light from behind; 0 for none. */
  kicker: number;
  environment: number;
  /** How soft the shadows are (the shadow map's blur). */
  shadowSoftness: number;
};

export type Room = {
  group: THREE.Group;
  light: RoomLight;
  /** Moves what drifts; `t` in seconds. */
  update: (t: number) => void;
  dispose: () => void;
};

/** Builds the stage in a look, with the accent color (`#rrggbb` as a THREE.Color). */
export function buildRoom(accent: THREE.Color = new THREE.Color("#45e3a2"), look: StageLook = "night"): Room {
  if (look === "studio") return buildStudio();
  if (look === "sunset") return buildSunset();
  return buildNight(accent);
}

/** Things to free when the room goes, and a way to note them as they are made. */
function keeper() {
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(thing: T) => {
    disposables.push(thing);
    return thing;
  };
  return { keep, dispose: () => disposables.forEach((thing) => thing.dispose()) };
}

/**
 * A surface swept along x from a profile in (z, y): a floor that curves up into a wall without a seam, as a studio's
 * cyclorama does.
 */
function sweep(profile: [number, number][], width: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const columns = 2;
  for (let i = 0; i < profile.length; i++) {
    const [z, y] = profile[i]!;
    for (let c = 0; c <= columns; c++) {
      positions.push((c / columns - 0.5) * width, y, z);
      uvs.push(c / columns, i / (profile.length - 1));
    }
  }
  for (let i = 0; i < profile.length - 1; i++) {
    for (let c = 0; c < columns; c++) {
      const a = i * (columns + 1) + c;
      const b = a + columns + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** Points of light drifting up slowly, in `color`: the place is alive even when nobody moves. */
function drifting(keep: <T extends { dispose: () => void }>(thing: T) => T, spot: THREE.Texture, color: number, count: number, opacity: number, size: number) {
  const seeds = new Float32Array(count * 3);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    seeds[i * 3] = (hash(i) - 0.5) * 9;
    seeds[i * 3 + 1] = hash(i + 500) * 3.4;
    seeds[i * 3 + 2] = -0.4 - hash(i + 900) * 4.2;
  }
  const geometry = keep(new THREE.BufferGeometry());
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(
    geometry,
    keep(new THREE.PointsMaterial({ map: spot, size, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true })),
  );
  points.frustumCulled = false;
  const update = (t: number) => {
    for (let i = 0; i < count; i++) {
      const rise = (seeds[i * 3 + 1]! + t * (0.04 + hash(i + 77) * 0.05)) % 3.4;
      positions[i * 3] = seeds[i * 3]! + Math.sin(t * 0.3 + i) * 0.12;
      positions[i * 3 + 1] = 0.1 + rise;
      positions[i * 3 + 2] = seeds[i * 3 + 2]! + Math.cos(t * 0.23 + i * 1.7) * 0.1;
    }
    geometry.attributes.position!.needsUpdate = true;
  };
  update(0);
  return { points, update };
}

/** «Студия»: one seamless surface, light, a soft pool of light under the people. */
function buildStudio(): Room {
  const group = new THREE.Group();
  const { keep, dispose } = keeper();
  const GREY = 0xa29d95;
  const AIR = 0x8f8b85;
  // The floor comes toward us, curves up behind the people (a cove of 2.4 m) and goes up as the wall.
  const profile: [number, number][] = [[8, 0]];
  const coveZ = -3.2;
  const radius = 2.4;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * (Math.PI / 2);
    profile.push([coveZ - Math.sin(a) * radius, radius - Math.cos(a) * radius]);
  }
  profile.push([coveZ - radius, 12]);
  const cyc = new THREE.Mesh(keep(sweep(profile, 40)), keep(new THREE.MeshStandardMaterial({ color: GREY, roughness: 0.96, metalness: 0 })));
  cyc.position.y = -0.03;
  cyc.receiveShadow = true;
  group.add(cyc);
  // Lighter where the light falls: a soft pool on the floor under the people.
  const pool = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(9, 6)),
    keep(new THREE.MeshBasicMaterial({ map: keep(softSpot(256)), color: 0xfff6ea, transparent: true, opacity: 0.12, depthWrite: false })),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, -0.025, -0.5);
  group.add(pool);
  return {
    group,
    light: {
      background: AIR,
      fog: [AIR, 11, 30],
      hemisphere: [0xf4f6ff, 0x6d675e, 0.8],
      key: [0xfff1e2, 2.5],
      keyAt: [-3.2, 6.5, 5.2],
      rim: [0xffffff, 1.0],
      rimAt: [2.8, 3.6, -5],
      kicker: 0,
      environment: 0.32,
      shadowSoftness: 7,
    },
    update: () => {},
    dispose,
  };
}

/** Wooden planks in warm browns, each a little different, with its grain. */
function planks(): THREE.Texture {
  const texture = painted(512, 512, (g, w, h) => {
    const rows = 8;
    const rowH = h / rows;
    for (let r = 0; r < rows; r++) {
      let x = -hash(r) * w * 0.5;
      let n = 0;
      while (x < w) {
        const length = w * (0.45 + hash(r * 31 + n) * 0.5);
        const tone = 0.82 + hash(r * 17 + n * 5) * 0.3;
        g.fillStyle = `rgb(${Math.round(112 * tone)},${Math.round(74 * tone)},${Math.round(50 * tone)})`;
        g.fillRect(x, r * rowH, length, rowH);
        g.strokeStyle = "rgba(40,22,12,0.18)";
        g.lineWidth = 1;
        for (let k = 0; k < 5; k++) {
          const y = r * rowH + rowH * (0.15 + 0.7 * hash(r * 7 + n * 3 + k));
          g.beginPath();
          g.moveTo(x, y);
          g.bezierCurveTo(x + length * 0.3, y + 2, x + length * 0.6, y - 2, x + length, y);
          g.stroke();
        }
        g.fillStyle = "rgba(30,16,8,0.55)";
        g.fillRect(x, r * rowH, 2, rowH);
        x += length;
        n++;
      }
      g.fillStyle = "rgba(30,16,8,0.6)";
      g.fillRect(0, r * rowH, w, 2);
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(9, 7);
  texture.anisotropy = 4;
  return texture;
}

/** «Закат»: a terrace, the sky going down gold behind the hills, warm motes in the air. */
function buildSunset(): Room {
  const group = new THREE.Group();
  const { keep, dispose } = keeper();
  const HORIZON = 0xf0a86e;
  const sky = keep(
    painted(4, 512, (g, w, h) => {
      const fade = g.createLinearGradient(0, 0, 0, h);
      fade.addColorStop(0, "#2a2350");
      fade.addColorStop(0.32, "#5b3f7a");
      fade.addColorStop(0.55, "#c46a6a");
      fade.addColorStop(0.7, "#f0a86e");
      fade.addColorStop(0.78, "#ffd29a");
      fade.addColorStop(1, "#ffd29a");
      g.fillStyle = fade;
      g.fillRect(0, 0, w, h);
    }),
  );
  const dome = new THREE.Mesh(
    keep(new THREE.SphereGeometry(40, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.62)),
    keep(new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false })),
  );
  dome.position.set(0, -6, 0);
  group.add(dome);
  // The sun, low over the hills, and its glow.
  const spot = keep(softSpot(256));
  const sun = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(14, 14)),
    keep(new THREE.MeshBasicMaterial({ map: spot, color: 0xffe2b0, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false })),
  );
  sun.position.set(-9, 1.6, -30);
  group.add(sun);
  // Hills far away, two layers, the far one paler.
  const hills = (depth: number, color: number, height: number, seed: number) => {
    const shape = new THREE.Shape();
    shape.moveTo(-60, -2);
    for (let i = 0; i <= 40; i++) {
      const x = -60 + i * 3;
      shape.lineTo(x, height * (0.55 + 0.45 * Math.sin(i * 0.55 + seed) * Math.cos(i * 0.21 + seed * 2)));
    }
    shape.lineTo(60, -2);
    const mesh = new THREE.Mesh(keep(new THREE.ShapeGeometry(shape)), keep(new THREE.MeshBasicMaterial({ color, fog: false, toneMapped: false })));
    mesh.position.set(0, -1.2, depth);
    return mesh;
  };
  group.add(hills(-34, 0x9a5e72, 3.2, 1.3));
  group.add(hills(-28, 0x5e3a5c, 2.4, 4.1));
  // The terrace: planks, and a low rail at its far edge.
  const deck = new THREE.Mesh(keep(new THREE.PlaneGeometry(22, 14)), keep(new THREE.MeshStandardMaterial({ map: keep(planks()), roughness: 0.78, metalness: 0 })));
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(0, -0.03, -1);
  deck.receiveShadow = true;
  group.add(deck);
  const wood = keep(new THREE.MeshStandardMaterial({ color: 0x5a3a26, roughness: 0.7 }));
  const rail = new THREE.Mesh(keep(new THREE.BoxGeometry(22, 0.07, 0.07)), wood);
  rail.position.set(0, 0.95, -6.2);
  rail.castShadow = true;
  group.add(rail);
  const postGeometry = keep(new THREE.BoxGeometry(0.07, 0.95, 0.07));
  for (let i = -10; i <= 10; i += 1.25) {
    const post = new THREE.Mesh(postGeometry, wood);
    post.position.set(i, 0.47, -6.2);
    post.castShadow = true;
    group.add(post);
  }
  const motes = drifting(keep, spot, 0xffc98a, 90, 0.5, 0.05);
  group.add(motes.points);
  return {
    group,
    light: {
      background: HORIZON,
      fog: [0xd98f72, 12, 34],
      hemisphere: [0xffd2b0, 0x3d2a45, 0.95],
      key: [0xffb27a, 2.6],
      keyAt: [-5.5, 3.0, 2.0],
      rim: [0xff8f6a, 1.6],
      rimAt: [3.5, 2.6, -5.5],
      kicker: 0,
      environment: 0.3,
      shadowSoftness: 4,
    },
    update: motes.update,
    dispose,
  };
}

/** «Ночь»: the studio at night, in the accent color. */
function buildNight(accent: THREE.Color): Room {
  const group = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(thing: T) => {
    disposables.push(thing);
    return thing;
  };

  // The floor: lighter under the people, gone into the dark at the sides.
  const floorTexture = keep(
    painted(512, 512, (g, w, h) => {
      const r = w / 2;
      const light = g.createRadialGradient(r, h * 0.47, 0, r, h * 0.5, r);
      light.addColorStop(0, "#262c37");
      light.addColorStop(0.3, "#1a1f28");
      light.addColorStop(0.75, "#0f1217");
      light.addColorStop(1, "#0b0d11");
      g.fillStyle = light;
      g.fillRect(0, 0, w, h);
    }),
  );
  const floor = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(26, 26)),
    keep(new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.9, metalness: 0 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -0.045, -1.2);
  floor.receiveShadow = true;
  group.add(floor);

  // The backdrop: a curve around the back, graphite low down, black high up.
  const wallTexture = keep(
    painted(8, 256, (g, w, h) => {
      const fade = g.createLinearGradient(0, 0, 0, h);
      fade.addColorStop(0, "#07080b");
      fade.addColorStop(0.45, "#0e1116");
      fade.addColorStop(0.85, "#171b23");
      fade.addColorStop(1, "#141820");
      g.fillStyle = fade;
      g.fillRect(0, 0, w, h);
    }),
  );
  const wall = new THREE.Mesh(
    keep(new THREE.CylinderGeometry(9, 9, 9, 64, 1, true, Math.PI * 0.6, Math.PI * 0.8)),
    keep(new THREE.MeshBasicMaterial({ map: wallTexture, side: THREE.BackSide, fog: false })),
  );
  wall.position.set(0, 4.45, 1.2);
  group.add(wall);

  // The accent's glow on the backdrop, behind the people.
  const spot = keep(softSpot(256));
  const halo = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(9, 4.6)),
    keep(new THREE.MeshBasicMaterial({ map: spot, color: accent, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false })),
  );
  halo.position.set(0, 1.55, -5.6);
  group.add(halo);

  // The round stage they stand on, and the line of light at its edge.
  const stage = new THREE.Mesh(
    keep(new THREE.CylinderGeometry(3.5, 3.56, 0.05, 96)),
    keep(new THREE.MeshStandardMaterial({ color: 0x171b23, roughness: 0.82, metalness: 0 })),
  );
  stage.position.set(0, -0.025, -0.35);
  stage.receiveShadow = true;
  group.add(stage);
  const edge = new THREE.Mesh(
    keep(new THREE.TorusGeometry(3.53, 0.008, 6, 160)),
    keep(new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.7, toneMapped: false })),
  );
  edge.rotation.x = Math.PI / 2;
  edge.position.set(0, 0.002, -0.35);
  group.add(edge);
  const edgeGlow = new THREE.Mesh(
    keep(new THREE.RingGeometry(3.35, 3.95, 96)),
    keep(new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.06, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })),
  );
  edgeGlow.rotation.x = -Math.PI / 2;
  edgeGlow.position.set(0, -0.02, -0.35);
  group.add(edgeGlow);

  // Dust in the light, drifting up slowly: the room is alive even when nobody moves.
  const dust = drifting(keep, spot, 0xdfe8ff, 140, 0.38, 0.045);
  group.add(dust.points);

  return {
    group,
    light: {
      background: STAGE_DARK,
      fog: [STAGE_DARK, 8.5, 17],
      hemisphere: [0xe4ecff, 0x1a1f2a, 0.75],
      key: [0xffffff, 1.85],
      keyAt: [-2.6, 5.4, 4.6],
      rim: [0xa9c4ff, 1.1],
      rimAt: [-2.5, 3.2, -5],
      kicker: 0.9,
      environment: 0.22,
      shadowSoftness: 5,
    },
    update: dust.update,
    dispose: () => {
      for (const thing of disposables) thing.dispose();
    },
  };
}
