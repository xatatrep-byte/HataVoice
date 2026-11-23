/**
 * How a character moves: every joint for every moment, from the time, the voice, where it walks and the act it is
 * doing. Pure numbers, so the same act looks the same on every PC and in the window over other apps.
 *
 * Joints turn around their own axes: x forward (a raised arm, a nod), y around themselves, z to the side. For the
 * left limb +z goes outward, for the right one −z.
 */

export type Joint = [number, number, number];

export const JOINTS = ["hips", "spine", "chest", "neck", "head", "armL", "foreL", "handL", "armR", "foreR", "handR", "legL", "shinL", "footL", "legR", "shinR", "footR"] as const;
export type JointName = (typeof JOINTS)[number];

export type Pose = Record<JointName, Joint> & {
  /** Steps away from its place on the floor. */
  x: number;
  z: number;
  /** Up from standing; below 0, crouching. */
  y: number;
  /** Turned around the vertical; 0 faces us. */
  turn: number;
  /** The whole figure tipped over, forward (flips, push-ups). */
  roll: number;
  /** Fists instead of open hands. */
  fistL: boolean;
  fistR: boolean;
  /** 0 closed – 1 wide open. */
  mouth: number;
  /** −1 a narrow «о» – 1 a wide «э». */
  mouthWide: number;
  /** −1 frown – 1 a broad smile. */
  smile: number;
  /** 0 open – 1 closed. */
  eyes: number;
  /** Eyes squeezed into happy arcs, 0–1. */
  happy: number;
  /** Brows up (above 0) or down, and slanted: above 0 angry, below 0 sad. */
  brow: number;
  browSlant: number;
  /** Where the eyes look, −1–1. */
  lookX: number;
  lookY: number;
  blush: number;
};

/** What a figure does now: an emote alone, or one side of something two do together. */
export type ActNow = {
  id: string;
  /** Seconds since it began. */
  elapsed: number;
  /** Alone, the one who does it, or the one it is done to. */
  role: "solo" | "actor" | "target";
  /** From this figure to the other one, on the floor (for an actor or a target). */
  toward?: { x: number; z: number };
  /** Done from where it stands, without walking up or being knocked away. */
  stay?: boolean;
  /** The two already met: the scene walked the one who does it up to the other with real steps and turned both to face
   * each other, so the act neither walks nor turns of its own. */
  met?: boolean;
  /** How the two bodies compare to an average pair (their radii's sum over twice the average): a pair act stops that
   * much farther, so wide bodies meet at their edges instead of inside each other. */
  reach?: number;
};

export type MotionInput = {
  /** Seconds, any steady clock. */
  t: number;
  /** A number of the person's own, so that no two breathe in step. */
  seed: number;
  /** The voice now, 0–1, already smoothed ([`followVoice`]): the mouth follows it. */
  level: number;
  /** How much it has been talking lately, 0–1, slow: the head and the brows go along with it. The level if absent. */
  energy?: number;
  /** How fast it walks now, 0–1, and how far its feet have gone (in stage units). */
  walk?: { speed: number; distance: number };
  /** Whom it looks at, as a turn of the head and a tilt up, in radians; null: around. */
  look?: { yaw: number; pitch: number } | null;
  act: ActNow | null;
};

const LENGTHS: Record<string, number> = {
  wave: 2.6,
  jump: 2.4,
  hooray: 2.4,
  byebye: 3.5,
  call: 2.2,
  raise: 3.1,
  guide: 3.1,
  dance: 4.4,
  spin: 2.8,
  laugh: 2.6,
  love: 2.8,
  angry: 3.5,
  cry: 4,
  clap: 2.6,
  sleep: 5,
  bow: 3.2,
  flex: 2.8,
  facepalm: 2.6,
  think: 3.2,
  shrug: 2,
  thumbsup: 2,
  salute: 2.2,
  flip: 1.7,
  robot: 4,
  guitar: 3.6,
  dj: 4.4,
  sit: 4,
  pushups: 4.2,
  hug: 4,
  highfive: 3.2,
  push: 3.2,
  heart: 3,
  snowball: 3,
  fistbump: 3.2,
  handshake: 3.6,
  pat: 3.6,
  pie: 3.4,
  kiss: 3.2,
  dancewith: 5,
  tickle: 4,
  bonk: 3.2,
  yes: 2.5,
  no: 2.5,
  fold: 3.5,
  phone: 4.4,
  spell: 3.2,
  zombie: 4,
  faint: 5.2,
};

/** Those who walk up to the other, and how near they stop; the rest do it from where they stand. */
const CLOSE: Record<string, number> = {
  hug: 0.42,
  highfive: 0.74,
  push: 0.62,
  fistbump: 0.78,
  handshake: 0.7,
  pat: 0.58,
  pie: 0.7,
  kiss: 0.5,
  dancewith: 0.74,
  tickle: 0.56,
  bonk: 0.62,
};

const THROWN = new Set(["snowball", "heart"]);

/** How near the one who does a pair act comes to the other (before the two bodies' size), or undefined: from afar. */
export function meetDistance(id: string): number | undefined {
  return CLOSE[id];
}

export function actLength(id: string): number {
  return LENGTHS[id] ?? 2.4;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (from: number, to: number, x: number) => {
  const k = clamp01((x - from) / (to - from));
  return k * k * (3 - 2 * k);
};
/** 0 → 1 → 0 over the act, gently at both ends. */
const envelope = (p: number, edge: number) => smooth(0, edge, p) * (1 - smooth(1 - edge, 1, p));
/** 0 → 1 → 0 between `from` and `to`. */
const bump = (p: number, from: number, to: number) => {
  const mid = (from + to) / 2;
  return smooth(from, mid, p) * (1 - smooth(mid, to, p));
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** A joint's own number, with no hurry: a sum of two waves never repeats itself in a way the eye catches. */
const drift = (t: number, seed: number, speed: number) => Math.sin(t * speed + seed) * 0.6 + Math.sin(t * speed * 0.37 + seed * 2.3) * 0.4;

export function restPose(): Pose {
  return {
    hips: [0, 0, 0],
    spine: [0, 0, 0],
    chest: [0, 0, 0],
    neck: [0, 0, 0],
    head: [0, 0, 0],
    armL: [0.05, 0, 0.13],
    foreL: [-0.25, 0, 0],
    handL: [0, 0, 0],
    armR: [0.05, 0, -0.13],
    foreR: [-0.25, 0, 0],
    handR: [0, 0, 0],
    legL: [0, 0, 0.02],
    shinL: [0, 0, 0],
    footL: [0, 0, 0],
    legR: [0, 0, -0.02],
    shinR: [0, 0, 0],
    footR: [0, 0, 0],
    x: 0,
    z: 0,
    y: 0,
    turn: 0,
    roll: 0,
    fistL: false,
    fistR: false,
    mouth: 0,
    mouthWide: 0,
    smile: 0.28,
    eyes: 0,
    happy: 0,
    brow: 0,
    browSlant: 0,
    lookX: 0,
    lookY: 0,
    blush: 0,
  };
}

/** Standing: breath, the weight moving from foot to foot, glances. */
function stand(pose: Pose, t: number, seed: number) {
  const breath = Math.sin(t * 1.6 + seed);
  const sway = drift(t, seed, 0.42);
  pose.chest[0] = 0.018 * breath;
  pose.hips[2] = 0.028 * sway;
  pose.spine[2] = -0.032 * sway;
  pose.neck[2] = 0.018 * sway;
  pose.y = -0.004 + 0.003 * breath;
  pose.legL[2] += 0.012 * sway;
  pose.legR[2] += 0.012 * sway;
  pose.armL[2] += 0.018 * breath + 0.02 * sway;
  pose.armR[2] += -0.018 * breath + 0.02 * sway;
  pose.armL[0] += 0.03 * drift(t, seed + 3, 0.7);
  pose.armR[0] += 0.03 * drift(t, seed + 5, 0.63);
  // Looks around now and then, for a few seconds at a time.
  const glance = Math.floor(t / 3.1 + seed);
  const wander = Math.sin(glance * 12.9898 + seed * 78.233) * 43758.5453;
  const pick = wander - Math.floor(wander);
  const moving = smooth(0, 0.35, (t / 3.1 + seed) % 1);
  const lastPick = (() => {
    const w = Math.sin((glance - 1) * 12.9898 + seed * 78.233) * 43758.5453;
    return w - Math.floor(w);
  })();
  const yaw = lerp(lastPick, pick, moving) - 0.5;
  pose.head[1] = yaw * 0.55;
  pose.head[0] = 0.03 * drift(t, seed + 7, 0.5);
  pose.lookX = yaw * 0.7;
  // Blinks every few seconds, quickly, sometimes twice.
  const cycle = (t + seed * 1.7) % 3.9;
  const closed = cycle < 0.13 ? Math.sin((cycle / 0.13) * Math.PI) : cycle > 0.3 && cycle < 0.42 && Math.floor(t / 3.9) % 3 === 0 ? Math.sin(((cycle - 0.3) / 0.12) * Math.PI) : 0;
  pose.eyes = closed;
}

/**
 * The voice as a figure takes it, kept between frames: the call reads a level ten times a second, in steps, and a body
 * put straight on those steps twitches. The mouth follows within a few frames; the energy (head, brows) over seconds.
 */
export type VoiceFollow = { mouth: number; energy: number };

export function followVoice(voice: VoiceFollow, level: number, dt: number): VoiceFollow {
  // Time only goes forward here: a frame from before the last one would blow the smoothing up into NaN for good.
  dt = Math.max(0, dt);
  const to = clamp01(level);
  const rate = (up: number, down: number) => 1 - Math.exp(-(to > voice.mouth ? up : down) * dt);
  voice.mouth += (to - voice.mouth) * rate(22, 11);
  const energyRate = 1 - Math.exp(-(to > voice.energy ? 1.6 : 0.9) * dt);
  voice.energy += (to - voice.energy) * energyRate;
  return voice;
}

/**
 * Talking: the mouth follows the voice in shapes that change; the head nods and tilts slowly with how much it talks.
 * The arms stay as they are: a hand that moves with every syllable looks nervous and goes through clothes.
 */
function talk(pose: Pose, t: number, seed: number, level: number, energy: number) {
  const voice = clamp01(level * 2.2);
  const body = clamp01(energy * 2.2);
  if (voice > 0.002) {
    const syllable = Math.abs(Math.sin(t * 9.5 + seed)) * 0.55 + Math.abs(Math.sin(t * 15.7 + seed * 2)) * 0.45;
    pose.mouth = Math.max(pose.mouth, voice * (0.35 + 0.65 * syllable));
    pose.mouthWide = 0.8 * Math.sin(t * 6.3 + seed * 3) * Math.min(1, voice * 4);
  }
  if (body < 0.002) return;
  pose.smile = lerp(pose.smile, Math.max(pose.smile, 0.12), body);
  pose.head[0] += 0.035 * Math.sin(t * 2.1 + seed) * body;
  pose.head[1] += 0.04 * Math.sin(t * 0.9 + seed * 2) * body;
  pose.head[2] += 0.03 * Math.sin(t * 1.3 + seed) * body;
  pose.chest[1] += 0.02 * Math.sin(t * 1.1 + seed) * body;
  pose.brow += 0.2 * body * Math.max(0, Math.sin(t * 1.7 + seed * 1.3));
}

/** A walking cycle over the distance the feet have gone. */
function steps(pose: Pose, speed: number, distance: number) {
  if (speed < 0.01) return;
  const phase = distance * 8.2;
  const stride = 0.62 * speed;
  const left = Math.sin(phase);
  const right = -left;
  pose.legL[0] = -stride * left;
  pose.legR[0] = -stride * right;
  pose.shinL[0] = lerp(pose.shinL[0], 0.15 + 0.85 * Math.max(0, Math.cos(phase)) * speed, speed);
  pose.shinR[0] = lerp(pose.shinR[0], 0.15 + 0.85 * Math.max(0, -Math.cos(phase)) * speed, speed);
  pose.footL[0] = lerp(0, 0.35 * left - 0.1, speed);
  pose.footR[0] = lerp(0, 0.35 * right - 0.1, speed);
  pose.y += Math.abs(Math.cos(phase)) * 0.026 * speed - 0.014 * speed;
  pose.hips[1] = 0.1 * speed * left;
  pose.hips[2] += 0.04 * speed * Math.cos(phase);
  pose.chest[1] -= 0.16 * speed * left;
  pose.chest[0] += 0.06 * speed;
  pose.armL[0] = lerp(pose.armL[0], 0.55 * stride * right * 1.3, speed);
  pose.armR[0] = lerp(pose.armR[0], 0.55 * stride * left * 1.3, speed);
  pose.foreL[0] = lerp(pose.foreL[0], -0.55, speed);
  pose.foreR[0] = lerp(pose.foreR[0], -0.55, speed);
}

type Partial3 = Partial<Pose>;

/** Sets a joint to `to`, as far as `w` goes. */
function aim(pose: Pose, joint: JointName, to: Joint, w: number) {
  const j = pose[joint];
  j[0] = lerp(j[0], to[0], w);
  j[1] = lerp(j[1], to[1], w);
  j[2] = lerp(j[2], to[2], w);
}

/** Many joints at once, by the same weight. */
function hold(pose: Pose, w: number, joints: Partial<Record<JointName, Joint>>) {
  for (const name in joints) aim(pose, name as JointName, joints[name as JointName]!, w);
}

type Joints = Partial<Record<JointName, Joint>>;

/** Two sets of joints mixed, `t` of the way from `a` to `b`; a joint one of them lacks stands at rest there. */
function between(a: Joints, b: Joints, t: number): Joints {
  const out: Joints = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<JointName>) {
    const from = a[name] ?? [0, 0, 0];
    const to = b[name] ?? [0, 0, 0];
    out[name] = [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
  }
  return out;
}

function face(pose: Pose, w: number, f: Partial3) {
  for (const key of ["mouth", "mouthWide", "smile", "eyes", "happy", "brow", "browSlant", "lookX", "lookY", "blush"] as const) {
    const v = f[key];
    if (v !== undefined) pose[key] = lerp(pose[key], v, w);
  }
}

/** Both knees bent to crouch by `q`: the hips drop, the feet stay on the floor. */
function crouch(pose: Pose, q: number, w: number) {
  aim(pose, "legL", [-q, 0, 0.05], w);
  aim(pose, "legR", [-q, 0, -0.05], w);
  aim(pose, "shinL", [q * 1.9, 0, 0], w);
  aim(pose, "shinR", [q * 1.9, 0, 0], w);
  aim(pose, "footL", [-q * 0.9, 0, 0], w);
  aim(pose, "footR", [-q * 0.9, 0, 0], w);
  pose.y += -(1 - Math.cos(q)) * 0.28 * w;
}

const SOLO: Record<string, (pose: Pose, p: number, s: number, e: number) => void> = {
  wave(pose, _p, s, e) {
    // The elbow out at the shoulder's height, the forearm up, the open hand by the head swinging from the elbow: a hello,
    // not a straight arm swept like a wiper (the actor's take did that, and leaned the whole body over).
    const beat = Math.sin(s * 13);
    hold(pose, e, {
      armR: [-0.2, 0.3, -1.6],
      foreR: [-1.6 + 0.32 * beat, -1.4, 0],
      handR: [0, 0, 0.15 * beat],
      chest: [0, -0.06, 0.04],
      head: [0, -0.08, 0.08],
    });
    face(pose, e, { smile: 0.9, brow: 0.5 });
  },
  // One joyful hop: down, up with the arms, a moment in the air with the feet tucked back, down soft, up again.
  jump(pose, p, _s, e) {
    const air = Math.sin(clamp01((p - 0.3) / 0.3) * Math.PI);
    const squat = bump(p, 0.08, 0.32) + 0.8 * bump(p, 0.56, 0.82);
    const arms = smooth(0.18, 0.34, p) * (1 - smooth(0.66, 0.9, p));
    crouch(pose, 0.55 * squat, e);
    pose.y += air * 0.36 * e;
    hold(pose, e, { armL: [-0.15, 0, 0.3 + 2.2 * arms], foreL: [-0.35, 0, 0.2 * arms], armR: [-0.15, 0, -0.3 - 2.2 * arms], foreR: [-0.35, 0, -0.2 * arms] });
    aim(pose, "legL", [-0.25 * air, 0, 0.03], air * e);
    aim(pose, "legR", [-0.25 * air, 0, -0.03], air * e);
    aim(pose, "shinL", [1.1 * air, 0, 0], air * e);
    aim(pose, "shinR", [1.1 * air, 0, 0], air * e);
    face(pose, e, { mouth: 0.5 * air + 0.2 * arms, smile: 1, brow: 0.6 * arms, happy: 0.5 * arms });
  },
  // Both arms up, glad (a figure without recordings; models play the actor's take).
  hooray(pose, p, s, e) {
    const up = smooth(0.05, 0.25, p) * (1 - smooth(0.75, 0.95, p));
    const bounce = Math.abs(Math.sin(s * 7)) * up;
    crouch(pose, 0.15 * bounce, e);
    hold(pose, e, { armL: [-0.2, 0, 0.4 + 2.2 * up], foreL: [-0.4, 0, 0.3 * up], armR: [-0.2, 0, -0.4 - 2.2 * up], foreR: [-0.4, 0, -0.3 * up], head: [-0.15 * up, 0, 0] });
    face(pose, e, { mouth: 0.6 * up, smile: 1, happy: 0.8 * up, brow: 0.6 });
  },
  // Both hands waving at the chest.
  byebye(pose, _p, s, e) {
    const beat = Math.sin(s * 9);
    hold(pose, e, {
      armL: [-0.55, 0, 0.55],
      foreL: [-1.5, 0, beat * 0.35],
      handL: [0, 0, beat * 0.3],
      armR: [-0.55, 0, -0.55],
      foreR: [-1.5, 0, -beat * 0.35],
      handR: [0, 0, -beat * 0.3],
      head: [0, 0, beat * 0.06],
    });
    face(pose, e, { smile: 1, happy: 0.5, brow: 0.4 });
  },
  // Hands round the mouth, calling out.
  call(pose, p, _s, e) {
    const loud = bump(p, 0.25, 0.75);
    hold(pose, e, {
      armL: [-0.9, -0.3, 0.35],
      foreL: [-2.35, 0, 0],
      armR: [-0.9, 0.3, -0.35],
      foreR: [-2.35, 0, 0],
      chest: [-0.1 * loud, 0, 0],
      head: [-0.25 * loud, 0, 0],
    });
    face(pose, e, { mouth: 0.4 + 0.5 * loud, mouthWide: -0.4, brow: 0.6 * loud });
  },
  // «Я тут!»: a hand up high.
  raise(pose, p, _s, e) {
    const up = smooth(0.05, 0.25, p) * (1 - smooth(0.75, 0.95, p));
    hold(pose, e, { armR: [-0.1, 0, -2.75 * up], foreR: [-0.2 * up, 0, 0], chest: [0, 0, 0.06 * up], head: [0, 0, 0.08 * up] });
    face(pose, e, { smile: 0.8, mouth: 0.3 * up, brow: 0.6 * up });
  },
  // «Сюда!»: an open hand toward the side, the head after it.
  guide(pose, p, _s, e) {
    const show = smooth(0.1, 0.3, p) * (1 - smooth(0.75, 0.95, p));
    hold(pose, e, { armR: [-0.6 * show, -0.5 * show, -1.2 * show], foreR: [-0.3 * show, 0, 0], handR: [0, -0.6 * show, 0], chest: [0, -0.12 * show, 0], head: [0, -0.35 * show, 0] });
    face(pose, e, { smile: 0.8, brow: 0.3 });
  },
  dance(pose, _p, s, e) {
    const beat = s * 5.2;
    const side = Math.sin(beat);
    const bounce = Math.abs(Math.sin(beat));
    crouch(pose, 0.22 + 0.18 * bounce, e);
    pose.y += 0.02 * bounce * e;
    pose.x += 0.06 * side * e;
    pose.turn += 0.3 * Math.sin(beat * 0.5) * e;
    const up = Math.floor(s * 1.3) % 2 === 0;
    hold(pose, e, {
      hips: [0, 0.22 * side, 0.1 * side],
      spine: [0, 0, -0.1 * side],
      chest: [0, -0.25 * side, -0.08 * side],
      head: [0.06 * bounce, 0.2 * side, 0.14 * side],
      armL: up ? [-0.3 - 0.9 * bounce, 0, 1.5] : [-0.9, 0, 0.5 + 0.4 * bounce],
      foreL: up ? [-1.1, 0, 0] : [-1.5 * bounce - 0.4, 0, 0],
      armR: up ? [-0.9, 0, -0.5 - 0.4 * bounce] : [-0.3 - 0.9 * bounce, 0, -1.5],
      foreR: up ? [-1.5 * bounce - 0.4, 0, 0] : [-1.1, 0, 0],
    });
    face(pose, e, { smile: 0.95, happy: 0.55, mouth: 0.25 + 0.25 * bounce });
  },
  spin(pose, p, _s, e) {
    pose.turn += smooth(0.05, 0.95, p) * Math.PI * 4;
    pose.y += 0.06 * e;
    hold(pose, e, { armL: [0, 0, 1.45], foreL: [0, 0, 0], armR: [0, 0, -1.45], foreR: [0, 0, 0], head: [-0.08, 0, 0] });
    aim(pose, "legL", [-0.5, 0, 0.1], e);
    aim(pose, "shinL", [1.1, 0, 0], e);
    face(pose, e, { mouth: 0.5, smile: 1, eyes: 0.6 });
  },
  laugh(pose, _p, s, e) {
    const shake = Math.sin(s * 22);
    hold(pose, e, {
      spine: [-0.14 + 0.03 * shake, 0, 0.05 * Math.sin(s * 4)],
      chest: [-0.18 + 0.04 * shake, 0, 0],
      head: [-0.32 + 0.05 * shake, 0, 0.1 * Math.sin(s * 3)],
      armL: [-0.55, 0, 0.1],
      foreL: [-1.9, -0.7, 0],
      armR: [-0.55, 0, -0.1],
      foreR: [-1.9, 0.7, 0],
    });
    pose.y += 0.012 * Math.abs(shake) * e;
    face(pose, e, { mouth: 0.8 + 0.2 * shake, smile: 1, happy: 1, brow: 0.5, blush: 0.5 });
  },
  love(pose, _p, s, e) {
    const sway = Math.sin(s * 2.6);
    hold(pose, e, {
      armL: [-1.0, 0, 0.3],
      foreL: [-1.7, -0.8, 0],
      armR: [-1.0, 0, -0.3],
      foreR: [-1.7, 0.8, 0],
      spine: [0.03, 0, 0.09 * sway],
      head: [0.03, 0.08 * sway, 0.2 * sway],
    });
    pose.y += 0.03 * Math.abs(Math.sin(s * 5)) * e;
    aim(pose, "legR", [-0.35, 0, -0.02], e);
    aim(pose, "shinR", [0.85 + 0.2 * sway, 0, 0], e);
    face(pose, e, { smile: 1, happy: 0.85, blush: 1, brow: 0.45, browSlant: -0.4 });
  },
  angry(pose, _p, s, e) {
    const stomp = Math.abs(Math.sin(s * 7));
    pose.x += 0.008 * Math.sin(s * 44) * e;
    hold(pose, e, {
      spine: [0.1, 0, 0],
      chest: [0.1, 0, 0],
      head: [0.14, 0, 0.03 * Math.sin(s * 30)],
      armL: [-0.15, 0, 0.5],
      foreL: [-1.2, 0, 0],
      armR: [-0.15, 0, -0.5],
      foreR: [-1.2, 0, 0],
    });
    aim(pose, "legR", [-0.5 * stomp, 0, -0.02], e);
    aim(pose, "shinR", [0.8 * stomp, 0, 0], e);
    pose.fistL = pose.fistR = e > 0.3;
    face(pose, e, { smile: -0.9, brow: -0.7, browSlant: 1, mouth: 0.2 + 0.2 * Math.abs(Math.sin(s * 11)), mouthWide: 1, blush: 0.4 });
  },
  cry(pose, _p, s, e) {
    const sob = Math.sin(s * 11);
    hold(pose, e, {
      spine: [0.14, 0, 0],
      chest: [0.14 + 0.03 * sob, 0, 0],
      head: [0.22 + 0.03 * sob, 0, 0.06],
      armL: [-0.95, 0, 0.1],
      foreL: [-2.35, -0.5, 0],
      armR: [-0.95, 0, -0.1],
      foreR: [-2.35, 0.5, 0],
    });
    pose.y += -0.012 + 0.006 * sob * e;
    face(pose, e, { smile: -1, eyes: 0.85, brow: 0.5, browSlant: -1, mouth: 0.35 + 0.2 * Math.abs(sob), mouthWide: 0.6 });
  },
  clap(pose, _p, s, e) {
    const c = Math.abs(Math.sin(s * 9));
    hold(pose, e, {
      armL: [-0.9, 0, 0.32 + 0.24 * c],
      foreL: [-1.15, -0.5 + 0.5 * c, 0],
      armR: [-0.9, 0, -0.32 - 0.24 * c],
      foreR: [-1.15, 0.5 - 0.5 * c, 0],
      head: [0.03, 0, 0.05 * Math.sin(s * 3)],
    });
    pose.y += 0.01 * c * e;
    face(pose, e, { smile: 1, happy: 0.5, brow: 0.4 });
  },
  sleep(pose, _p, s, e) {
    const snore = Math.sin(s * 1.6);
    hold(pose, e, {
      spine: [0.1, 0, 0.03 * snore],
      chest: [0.1 + 0.03 * snore, 0, 0],
      neck: [0.2, 0, 0.1],
      head: [0.32 + 0.06 * snore, 0, 0.35],
      armL: [0.1, 0, 0.05],
      foreL: [-0.1, 0, 0],
      armR: [0.1, 0, -0.05],
      foreR: [-0.1, 0, 0],
    });
    pose.y += -0.02 * e;
    face(pose, e, { eyes: 1, smile: 0, mouth: 0.14 + 0.1 * snore, mouthWide: -0.6, brow: -0.1 });
  },
  bow(pose, p, _s, e) {
    const d = bump(p, 0.1, 0.9);
    hold(pose, e, {
      hips: [0.5 * d, 0, 0],
      spine: [0.45 * d, 0, 0],
      chest: [0.25 * d, 0, 0],
      head: [-0.15 * d, 0, 0],
      armL: [-0.25 * d, 0, 0.05],
      foreL: [-1.5 * d, -0.7 * d, 0],
      armR: [0.45 * d, 0, -0.05],
      foreR: [-1.4 * d, 0.8 * d, 0],
    });
    aim(pose, "legL", [-0.5 * d, 0, 0], e);
    aim(pose, "legR", [-0.5 * d, 0, 0], e);
    face(pose, e, { smile: 0.6, eyes: 0.8 * d });
  },
  flex(pose, _p, s, e) {
    const pump = Math.abs(Math.sin(s * 3.2));
    hold(pose, e, {
      armL: [0, 0, 1.55],
      foreL: [-2.05 - 0.25 * pump, 0, 0],
      armR: [0, 0, -1.55],
      foreR: [-2.05 - 0.25 * pump, 0, 0],
      chest: [-0.08, 0.14 * Math.sin(s * 1.6), 0],
      head: [-0.08, 0.3 * Math.sin(s * 1.6), 0],
    });
    pose.fistL = pose.fistR = e > 0.3;
    face(pose, e, { smile: 0.9, brow: -0.2, browSlant: 0.4, mouthWide: 1, mouth: 0.15 });
  },
  facepalm(pose, p, s, e) {
    const down = smooth(0.15, 0.3, p);
    hold(pose, e, {
      armR: [-1.3, 0, -0.1],
      foreR: [-2.2 * down, 0.5, 0],
      spine: [0.08, 0, 0],
      chest: [0.1, 0, 0],
      head: [0.32 * down + 0.04 * Math.sin(s * 2.3), 0.05 * Math.sin(s * 3), 0],
    });
    face(pose, e, { eyes: 1 * down, smile: -0.5, brow: -0.4, browSlant: -0.3 });
  },
  think(pose, _p, s, e) {
    hold(pose, e, {
      armL: [-0.5, 0, 0.1],
      foreL: [-1.55, -0.9, 0],
      armR: [-0.75, 0, -0.14],
      foreR: [-2.25, 0.25, 0],
      head: [-0.12, 0.16 + 0.06 * Math.sin(s * 0.9), 0.14],
      chest: [0, 0.08, 0],
      hips: [0, -0.05, 0.04],
    });
    pose.fistR = e > 0.3;
    face(pose, e, { lookX: 0.5, lookY: 0.75, smile: 0, mouthWide: -0.4, brow: 0.3, browSlant: 0.4 });
  },
  shrug(pose, p, _s, e) {
    const up = bump(p, 0.12, 0.88);
    hold(pose, e, {
      armL: [0.1, -0.4, 0.5],
      foreL: [-1.45, 0.3, 0],
      handL: [-0.5, 0, 0],
      armR: [0.1, 0.4, -0.5],
      foreR: [-1.45, -0.3, 0],
      handR: [-0.5, 0, 0],
      head: [0.03, 0, 0.14 * Math.sin(p * Math.PI * 2)],
      chest: [-0.04 * up, 0, 0],
    });
    pose.y += 0.012 * up;
    face(pose, e, { smile: -0.2, brow: 0.8 * up, mouthWide: 0.5, browSlant: -0.2 });
  },
  // The acts below are recorded on people for models (motionPlan.ts); these drawn ones are for figures and the workshop.
  yes(pose, _p, s, e) {
    hold(pose, e, { head: [0.22 * Math.max(0, Math.sin(s * 9)), 0, 0], neck: [0.08 * Math.max(0, Math.sin(s * 9)), 0, 0] });
    face(pose, e, { smile: 0.8, happy: 0.3 });
  },
  no(pose, _p, s, e) {
    hold(pose, e, { head: [0, 0.32 * Math.sin(s * 8), 0], neck: [0, 0.1 * Math.sin(s * 8), 0] });
    face(pose, e, { smile: -0.2, browSlant: 0.3 });
  },
  fold(pose, _p, s, e) {
    hold(pose, e, {
      armL: [-0.35, -0.65, 0.22],
      foreL: [-1.95, -0.4, 0],
      armR: [-0.35, 0.65, -0.22],
      foreR: [-1.95, 0.4, 0],
      head: [-0.06, 0.08 * Math.sin(s * 0.8), 0.05],
      chest: [-0.04, 0, 0],
    });
    face(pose, e, { smile: -0.3, browSlant: 0.5 });
  },
  phone(pose, _p, s, e) {
    hold(pose, e, {
      armR: [-0.35, 0, -0.55],
      foreR: [-2.45, -0.2, 0],
      handR: [0, 0.4, 0],
      head: [0.04, -0.12, -0.12],
    });
    pose.fistR = e > 0.3;
    face(pose, e, { mouthWide: 0.2, smile: 0.4 + 0.2 * Math.sin(s * 2) });
  },
  spell(pose, p, s, e) {
    // Three beats: the open hands hold a ball of light at the chest, the right one goes up over the head and twirls, then
    // it is thrown out in front with a step into it. The sparks gather, trail and burst in scene.ts.
    const up = smooth(0.26, 0.38, p);
    const cast = smooth(0.52, 0.6, p);
    const twirl = s * 9;
    const ball: Joints = {
      armL: [-0.95, 0, 0.3],
      foreL: [-1.55, -0.45, 0],
      handL: [0, 0.6, 0.2],
      armR: [-0.95, 0, -0.3],
      foreR: [-1.55, 0.45, 0],
      handR: [0, -0.6, -0.2],
      spine: [0.04, 0, 0],
      chest: [0.08, 0, 0],
      head: [0.18, 0, 0],
    };
    const raised: Joints = {
      armL: [-0.7, 0, 0.35],
      foreL: [-1.6, -0.6, 0],
      armR: [-2.55, 0.2, -0.3],
      foreR: [-0.45, 0, 0],
      handR: [0.45 * Math.cos(twirl), 0, 0.45 * Math.sin(twirl)],
      spine: [-0.04, 0, 0],
      chest: [-0.12, 0, 0],
      head: [-0.24, 0, 0],
    };
    const thrown: Joints = {
      armL: [0.4, 0, 0.4],
      foreL: [-0.35, 0, 0],
      handL: [0.2, 0, 0],
      armR: [-1.5, 0.05, 0.02],
      foreR: [-0.05, 0, 0],
      handR: [0.7, 0, 0],
      spine: [0.1, 0, 0],
      chest: [0.08, 0, 0],
      head: [-0.04, 0, 0],
    };
    hold(pose, e, between(between(ball, raised, up), thrown, cast));
    crouch(pose, 0.14 * (1 - up) + 0.1 * cast, e);
    // The step into the cast: the right foot forward, the left knee bent behind.
    aim(pose, "legR", [-0.45, 0, -0.06], cast * e);
    aim(pose, "shinR", [0.35, 0, 0], cast * e);
    aim(pose, "legL", [0.25, 0, 0.05], cast * e);
    aim(pose, "shinL", [0.45, 0, 0], cast * e);
    face(pose, e, { eyes: 0.45 * (1 - up), brow: 0.3 + 0.4 * up, mouth: 0.15 * up + 0.35 * cast, smile: 0.5 + 0.3 * cast });
  },
  zombie(pose, _p, s, e) {
    hold(pose, e, {
      armL: [-1.45, 0, 0.12],
      armR: [-1.45, 0, -0.12],
      foreL: [-0.1, 0, 0],
      foreR: [-0.1, 0, 0],
      head: [0.25, 0.15 * Math.sin(s * 1.4), 0.2 * Math.sin(s * 0.9)],
      hips: [0, 0, 0.06 * Math.sin(s * 2.2)],
    });
    face(pose, e, { eyes: 0.5, mouth: 0.5, smile: -0.4 });
  },
  faint(pose, p, _s, e) {
    const down = smooth(0.08, 0.32, p) * (1 - smooth(0.72, 0.95, p));
    // The knees give way first: a body that faints folds, it does not fall like a plank.
    crouch(pose, 0.45 * smooth(0.02, 0.2, p) * (1 - smooth(0.78, 0.97, p)), e);
    pose.roll += -1.45 * down;
    pose.y += -0.35 * down;
    hold(pose, e, { armL: [0, 0, 0.9 * down], armR: [0, 0, -0.9 * down], head: [-0.2 * down, 0.3 * down, 0] });
    face(pose, e, { eyes: down, mouth: 0.4 * down });
  },
  thumbsup(pose, _p, s, e) {
    // The fist in front of the chest, the elbow bent at the side: an elbow bends forward when its upper arm turns in (y).
    hold(pose, e, {
      armR: [-0.5, 0.45, -0.12],
      foreR: [-1.4, 0, 0],
      handR: [0, -1.5, 0],
      head: [-0.05, -0.05, 0.1 * Math.sin(s * 3.5)],
      chest: [0, -0.1, 0],
    });
    pose.fistR = e > 0.3;
    face(pose, e, { smile: 1, happy: 0.4, brow: 0.4 });
  },
  salute(pose, _p, _s, e) {
    // The arm up to the side, the forearm folded up to the temple: with the upper arm raised, a forearm's turn about it
    // (y) chooses whether it folds forward or up.
    hold(pose, e, {
      armR: [-0.15, 0.85, -1.5],
      foreR: [-2.45, -1.3, 0],
      handR: [0, 0, 0],
      chest: [-0.05, 0, 0],
      head: [-0.04, 0, 0],
      armL: [0.02, 0, 0.05],
      foreL: [-0.05, 0, 0],
    });
    face(pose, e, { smile: 0.4, brow: -0.1, browSlant: 0.2 });
  },
  flip(pose, p, _s, e) {
    const air = clamp01((p - 0.18) / 0.6);
    const spin = smooth(0, 1, air);
    const up = Math.sin(air * Math.PI);
    crouch(pose, 0.8 * (bump(p, 0, 0.26) + bump(p, 0.74, 1)) + 0.9 * up, e);
    pose.y += up * 0.62;
    pose.roll = -spin * Math.PI * 2;
    hold(pose, e * up, { armL: [-1.8, 0, 0.3], foreL: [-1.2, 0, 0], armR: [-1.8, 0, -0.3], foreR: [-1.2, 0, 0], spine: [0.25, 0, 0], head: [0.2, 0, 0] });
    face(pose, e, { mouth: 0.55 * up, smile: 1, eyes: 0.3 * up, brow: 0.6 });
  },
  robot(pose, _p, s, e) {
    const step = Math.floor(s * 3);
    const tick = (a: number, b: number) => (step % 2 === 0 ? a : b);
    hold(pose, e, {
      armL: [-1.5 * tick(1, 0.2), 0, 0.14],
      foreL: [tick(0, -1.5), 0, 0],
      armR: [-1.5 * tick(0.2, 1), 0, -0.14],
      foreR: [tick(-1.5, 0), 0, 0],
      head: [0, 0.5 * tick(1, -1), 0],
      chest: [0, 0.2 * tick(-1, 1), 0],
      hips: [0, 0.08 * tick(1, -1), 0],
    });
    pose.turn += 0.3 * ((step % 4) - 1.5) * e * 0.5;
    pose.y += 0.012 * tick(1, 0) * e;
    face(pose, e, { smile: 0, mouthWide: 1, mouth: 0.08, brow: 0.3 });
  },
  guitar(pose, _p, s, e) {
    const strum = Math.sin(s * 15);
    const head = Math.abs(Math.sin(s * 5.2));
    crouch(pose, 0.3, e);
    // The left hand holds the neck out to the side, the right one strums in front of the belly: an elbow bends forward
    // when its upper arm turns in on itself (y), so both arms turn in rather than twisting the forearms.
    hold(pose, e, {
      armL: [-0.5, -0.05, 0.78],
      foreL: [-1.15, 0, 0],
      handL: [0, 0, -0.3],
      armR: [-0.36, 0.62, -0.12],
      foreR: [-1.3 + 0.24 * strum, 0, 0],
      handR: [-0.2, 0, 0.18 * strum],
      spine: [-0.1, 0, 0],
      chest: [-0.05, 0, 0],
      head: [0.32 * head - 0.2, 0, 0.14 * Math.sin(s * 2.6)],
    });
    face(pose, e, { mouth: 0.5, mouthWide: -0.2, smile: 0.6, eyes: 0.6, brow: 0.5 });
  },
  dj(pose, _p, s, e) {
    // One hand presses a headphone to the ear, the other scratches a record at the waist (in bursts, as a DJ does);
    // the knees and the head bounce on the beat, about 126 a minute.
    const bounce = 0.5 - 0.5 * Math.cos(s * Math.PI * 2 * 2.1);
    const burst = smooth(-0.2, 0.2, Math.sin(s * 3.1));
    const scratch = Math.sin(s * 14) * burst;
    crouch(pose, 0.14 + 0.1 * bounce, e);
    hold(pose, e, {
      armL: [-0.35, 0, 0.6],
      foreL: [-2.45, 0.22, 0],
      handL: [0, -0.4, 0],
      // The forearm level in front of the belly (clear of it, or the arm gets turned out of the body), swept across
      // the record from the shoulder.
      armR: [-0.32, 0.6 + 0.26 * scratch, -0.1],
      foreR: [-1.4, -0.3, 0],
      handR: [-0.25, 0, 0],
      spine: [0.06, 0, 0],
      chest: [0.03 * bounce, -0.1, 0],
      head: [0.06 + 0.16 * bounce, 0.14, 0.13],
    });
    face(pose, e, { eyes: 0.5, smile: 0.75, mouth: 0.1 + 0.08 * bounce, mouthWide: 0.35, brow: 0.3 });
  },
  sit(pose, p, s, e) {
    crouch(pose, 1.36, e);
    pose.y += -0.02 * e;
    hold(pose, e, {
      spine: [-0.12, 0, 0],
      armL: [-0.65, 0, 0.14],
      foreL: [-0.55, 0.15, 0],
      armR: [-0.65, 0, -0.14],
      foreR: [-0.55, -0.15, 0],
      head: [0.03 * Math.sin(s * 0.8), 0.25 * Math.sin(s * 0.7), 0],
    });
    face(pose, e, { smile: 0.5, eyes: bump(p, 0.45, 0.55) });
  },
  pushups(pose, p, s, e) {
    const down = smooth(0, 0.16, p) * (1 - smooth(0.86, 1, p));
    const push = 0.5 + 0.5 * Math.sin(s * 5);
    pose.roll = (Math.PI / 2 - 0.08) * down;
    pose.y += -0.19 * down + 0.08 * push * down;
    hold(pose, down, {
      armL: [-1.45 - 0.45 * (1 - push), 0, 0.22],
      foreL: [-1.0 * (1 - push), 0, 0],
      handL: [-1.2, 0, 0],
      armR: [-1.45 - 0.45 * (1 - push), 0, -0.22],
      foreR: [-1.0 * (1 - push), 0, 0],
      handR: [-1.2, 0, 0],
      head: [-0.75, 0, 0],
      legL: [0, 0, 0],
      legR: [0, 0, 0],
      footL: [1.0, 0, 0],
      footR: [1.0, 0, 0],
    });
    face(pose, e, { smile: 0.2, mouthWide: 1, mouth: 0.15, brow: -0.1, browSlant: 0.5, lookY: 0.4 });
  },
};

type Pair = { pose: Pose; p: number; s: number; doing: number; role: "actor" | "target"; toward: { x: number; z: number } };

/** What two do together, each from their side. The figure already faces the other one. */
const TOGETHER: Record<string, (pair: Pair) => void> = {
  hug({ pose, doing, s }) {
    const w = doing;
    hold(pose, w, {
      armL: [-1.25, 0, 0.45],
      foreL: [-0.9, -0.8, 0],
      armR: [-1.25, 0, -0.45],
      foreR: [-0.9, 0.8, 0],
      spine: [0.09, 0, 0.05 * Math.sin(s * 3)],
      chest: [0.06, 0, 0],
      head: [0.12, 0.22, 0.18],
    });
    pose.y += 0.008 * Math.sin(s * 6) * w;
    face(pose, w, { eyes: 1, smile: 1, blush: 0.9 });
  },
  highfive({ pose, p, role, doing }) {
    const slap = bump(p, 0.4, 0.58);
    if (role === "actor") {
      hold(pose, doing, { armR: [-0.85, 0, -1.9 + 0.3 * slap], foreR: [-0.7 + 0.6 * slap, 0, 0], chest: [-0.05, 0.1, 0] });
    } else {
      hold(pose, doing, { armL: [-0.85, 0, 1.9 - 0.3 * slap], foreL: [-0.7 + 0.6 * slap, 0, 0], chest: [-0.05, -0.1, 0] });
    }
    pose.y += 0.1 * slap;
    face(pose, doing, { smile: 1, happy: slap, brow: 0.6 });
  },
  push({ pose, p, role, toward }) {
    if (role === "actor") {
      const shove = bump(p, 0.34, 0.62);
      hold(pose, shove, { armL: [-1.45, 0, 0.1], foreL: [-0.15, 0, 0], armR: [-1.45, 0, -0.1], foreR: [-0.15, 0, 0], spine: [0.26, 0, 0], chest: [0.1, 0, 0] });
      face(pose, shove, { smile: 0.8, brow: -0.1, browSlant: 0.6, mouthWide: 1, mouth: 0.15 });
    } else {
      const knocked = smooth(0.44, 0.55, p) * (1 - smooth(0.7, 0.95, p));
      const dist = Math.hypot(toward.x, toward.z) || 1;
      pose.x += (-toward.x / dist) * 0.6 * knocked;
      pose.z += (-toward.z / dist) * 0.6 * knocked;
      // Knocked back a step, arms thrown up a little to keep the balance (not flung out level like a scarecrow).
      const sway = Math.sin(p * 24);
      hold(pose, knocked, {
        spine: [-0.26, 0, 0],
        chest: [-0.16, 0, 0],
        head: [0.2, 0, 0],
        armL: [-0.7, 0, 0.75 + 0.15 * sway],
        foreL: [-0.8, 0, 0],
        armR: [-0.7, 0, -0.75 - 0.15 * sway],
        foreR: [-0.8, 0, 0],
      });
      face(pose, knocked, { mouth: 0.6, mouthWide: -0.7, smile: 0, brow: 0.9 });
    }
  },
  heart({ pose, p, role, s }) {
    if (role === "actor") {
      const blow = bump(p, 0.18, 0.56);
      hold(pose, blow, { armR: [-1.2, 0, -0.1], foreR: [-1.8 + 1.5 * smooth(0.36, 0.5, p), -0.2, 0], head: [-0.05, 0, 0.14] });
      face(pose, blow, { smile: 0.7, blush: 0.9, mouthWide: -1, mouth: 0.16, eyes: 0.5 });
    } else {
      const glad = bump(p, 0.54, 1);
      hold(pose, glad, { armL: [-1, 0, 0.3], foreL: [-1.7, 0.8, 0], armR: [-1, 0, -0.3], foreR: [-1.7, -0.8, 0], head: [0, 0, 0.2 * Math.sin(s * 3)] });
      pose.y += 0.08 * Math.abs(Math.sin(s * 6)) * glad;
      face(pose, glad, { smile: 1, happy: 0.9, blush: 1 });
    }
  },
  snowball({ pose, p, role, s }) {
    if (role === "actor") {
      const wind = bump(p, 0.08, 0.42);
      const release = bump(p, 0.36, 0.62);
      hold(pose, wind, { armR: [0.7, 0, -1.25], foreR: [-1.5, 0, 0], chest: [-0.1, 0.5, 0], armL: [-1, 0, 0.3], foreL: [-0.2, 0, 0] });
      hold(pose, release, { armR: [-1.65, 0, -0.2], foreR: [-0.1, 0, 0], chest: [0.14, -0.4, 0], spine: [0.1, 0, 0] });
      face(pose, wind + release, { smile: 0.9, brow: -0.1, browSlant: 0.5, mouthWide: 1, mouth: 0.15 });
    } else {
      const hit = bump(p, 0.58, 0.98);
      pose.x += 0.015 * Math.sin(s * 40) * hit;
      hold(pose, hit, { head: [-0.28, 0, 0.1 * Math.sin(s * 30)], spine: [-0.1, 0, 0], armL: [-0.5, 0, 0.8], armR: [-0.5, 0, -0.8] });
      face(pose, hit, { eyes: 1, mouth: 0.5, smile: -0.4, brow: 0.8 });
    }
  },
  fistbump({ pose, p, role, doing }) {
    const bumped = bump(p, 0.4, 0.56);
    if (role === "actor") {
      hold(pose, doing, { armR: [-1.35, 0, -0.1], foreR: [-0.3 + 0.2 * bumped, -0.25, 0], chest: [0.05 * bumped, -0.1, 0] });
      pose.fistR = doing > 0.2;
    } else {
      hold(pose, doing, { armL: [-1.35, 0, 0.1], foreL: [-0.3 + 0.2 * bumped, 0.25, 0], chest: [0.05 * bumped, 0.1, 0] });
      pose.fistL = doing > 0.2;
    }
    face(pose, doing, { smile: 0.9, brow: 0.2 + 0.5 * bumped, happy: bumped });
  },
  handshake({ pose, s, role, doing }) {
    const shake = Math.sin(s * 11) * 0.14;
    if (role === "actor") hold(pose, doing, { armR: [-0.9 + shake, 0, -0.08], foreR: [-0.25, -0.2, 0], handR: [0, 0, 0], chest: [0.05, 0, 0], head: [0.06, 0, 0] });
    else hold(pose, doing, { armR: [-0.9 + shake, 0, -0.08], foreR: [-0.25, -0.2, 0], chest: [0.05, 0, 0], head: [0.06, 0, 0] });
    face(pose, doing, { smile: 0.8, brow: 0.2 });
  },
  pat({ pose, s, role, doing }) {
    const pat = Math.abs(Math.sin(s * 5.5));
    if (role === "actor") {
      hold(pose, doing, { armR: [-1.95, 0, -0.12], foreR: [-0.3 - 0.35 * pat, 0, 0], handR: [0.5, 0, 0], chest: [0.05, 0, 0], head: [0.2, 0, 0.05] });
      face(pose, doing, { smile: 0.9, happy: 0.7, brow: 0.3 });
    } else {
      hold(pose, doing, { head: [0.2 + 0.07 * pat, 0, 0.05], spine: [0.05, 0, 0] });
      pose.y += -0.012 * pat * doing;
      face(pose, doing, { smile: 1, happy: 1, blush: 0.8 });
    }
  },
  pie({ pose, p, role, s }) {
    const hit = smooth(0.38, 0.46, p);
    if (role === "actor") {
      const wind = bump(p, 0.12, 0.48);
      hold(pose, wind, { armR: [-0.3 - 1.25 * hit, 0, -0.5 * (1 - hit)], foreR: [-1.5 + 1.35 * hit, 0, 0], chest: [0, 0.3 - 0.6 * hit, 0] });
      hold(pose, bump(p, 0.5, 1), { spine: [-0.1, 0, 0], head: [-0.16, 0, 0], armL: [-0.55, 0, 0.1], foreL: [-1.9, 0.7, 0], armR: [-0.55, 0, -0.1], foreR: [-1.9, -0.7, 0] });
      face(pose, bump(p, 0.5, 1), { mouth: 0.8, happy: 1, smile: 1 });
    } else {
      const w = bump(p, 0.4, 1);
      pose.x += 0.006 * Math.sin(s * 38) * w;
      hold(pose, w, { head: [-0.1, 0, 0], armL: [-0.1, 0, 0.5], foreL: [-1.0, 0, 0], armR: [-0.1, 0, -0.5], foreR: [-1.0, 0, 0] });
      face(pose, w, { eyes: 1, smile: -0.5, mouth: 0.1 });
    }
  },
  kiss({ pose, p, role, doing }) {
    const lean = bump(p, 0.36, 0.64);
    hold(pose, doing, { spine: [0.1 * lean, 0, 0], head: [0.1 * lean, role === "actor" ? 0.14 : -0.14, role === "actor" ? 0.14 : -0.14] });
    if (role === "actor") {
      hold(pose, doing, { armL: [-0.7, 0, 0.3], foreL: [-1.1, -0.8, 0], armR: [-0.7, 0, -0.3], foreR: [-1.1, 0.8, 0] });
      face(pose, doing, { mouth: 0.1, mouthWide: -1, eyes: 0.9 * lean, blush: 1, smile: 0.3 });
    } else {
      face(pose, doing, { eyes: 0.9 * lean, smile: 1, blush: 1 + 0.4 * lean, happy: lean });
    }
  },
  dancewith({ pose, s, role, doing }) {
    const beat = s * 4.4;
    const side = Math.sin(beat) * (role === "actor" ? 1 : -1);
    crouch(pose, 0.22 + 0.1 * Math.abs(Math.sin(beat)), doing);
    pose.x += 0.05 * side * doing;
    hold(pose, doing, {
      armR: [-1.1, 0, -0.2],
      foreR: [-0.5, -0.3, 0],
      armL: [-0.8, 0, 1.2],
      foreL: [-1, 0, 0],
      hips: [0, 0.18 * side, 0.08 * side],
      chest: [0, -0.15 * side, -0.05 * side],
      head: [0, 0.16 * side, 0.12 * side],
    });
    face(pose, doing, { smile: 1, happy: 0.7, blush: 0.5 });
  },
  tickle({ pose, s, role, doing }) {
    if (role === "actor") {
      const wiggle = Math.sin(s * 23) * 0.2;
      hold(pose, doing, { armL: [-1.1, 0, 0.18], foreL: [-0.5 + wiggle, 0.35, 0], armR: [-1.1, 0, -0.18], foreR: [-0.5 - wiggle, -0.35, 0], spine: [0.15, 0, 0], head: [-0.1, 0, 0] });
      face(pose, doing, { smile: 1, happy: 0.3, brow: 0.5, mouth: 0.2 });
    } else {
      const shake = Math.sin(s * 25);
      pose.x += 0.012 * shake * doing;
      hold(pose, doing, { armL: [-0.5, 0, 0.8 + 0.3 * shake], foreL: [-1.6, 0, 0], armR: [-0.5, 0, -0.8 - 0.3 * shake], foreR: [-1.6, 0, 0], spine: [-0.14 + 0.05 * shake, 0, 0.1 * shake], head: [-0.2, 0, 0.14 * shake] });
      face(pose, doing, { mouth: 0.85, happy: 1, smile: 1, blush: 0.8 });
    }
  },
  bonk({ pose, p, role, s }) {
    const hit = bump(p, 0.36, 0.56);
    if (role === "actor") {
      const up = bump(p, 0.12, 0.46);
      hold(pose, up, { armR: [-2.7 + 1.1 * smooth(0.36, 0.46, p), 0, -0.1], foreR: [-0.7, 0, 0], chest: [-0.06, 0, 0] });
      pose.fistR = up > 0.2;
      face(pose, up + hit, { smile: 0.6, brow: -0.3, browSlant: 0.8, mouthWide: 1, mouth: 0.1 });
    } else {
      const stun = bump(p, 0.42, 1);
      hold(pose, stun, { head: [0.34, 0.1 * Math.sin(s * 8), 0], neck: [0.1, 0, 0], armR: [-1.9, 0, -0.3], foreR: [-1.7, 0, 0] });
      pose.y += -0.015 * hit;
      face(pose, stun, { eyes: 1, smile: -0.5, mouth: 0.3, mouthWide: 0.7, brow: 0.4, browSlant: -0.6 });
    }
  },
};

/**
 * A drawn act held still looks like a doll: the joints it moved sway a little, each at its own slow beat, as a living
 * arm never stops quite where it was put. Nothing at the act's start and end (`e`), so it begins and ends as before.
 */
function alive(pose: Pose, before: Joint[], s: number, seed: number, e: number) {
  JOINTS.forEach((joint, i) => {
    const was = before[i]!;
    const now = pose[joint];
    const moved = Math.abs(now[0] - was[0]) + Math.abs(now[1] - was[1]) + Math.abs(now[2] - was[2]);
    if (moved < 0.15) return;
    const k = 0.045 * e * Math.min(1, moved / 0.6);
    for (let axis = 0; axis < 3; axis++) {
      const phase = seed * 1.7 + i * 2.3 + axis * 4.1;
      now[axis] += k * (Math.sin(s * (1.1 + 0.37 * axis) + phase) * 0.7 + Math.sin(s * (2.9 + 0.23 * i) + phase * 1.3) * 0.3);
    }
  });
}

/**
 * One moment of a figure: standing or walking, what it says, whom it looks at, and the act over all that. Fingers and
 * faces are decided here too, so a figure does nothing but put the numbers on its joints.
 */
export function poseAt({ t, seed, level, energy, walk, look, act }: MotionInput): Pose {
  const pose = restPose();
  stand(pose, t, seed);
  if (look) {
    pose.head[1] = look.yaw;
    pose.head[0] += -look.pitch;
    pose.lookX = Math.max(-1, Math.min(1, look.yaw * 1.4));
    pose.lookY = Math.max(-1, Math.min(1, look.pitch * 2));
  }
  talk(pose, t, seed, level, energy ?? level);
  if (walk) steps(pose, Math.min(1, walk.speed), walk.distance);
  if (!act) return pose;

  const length = actLength(act.id);
  const p = clamp01(act.elapsed / length);
  const s = act.elapsed;
  const solo = SOLO[act.id];
  if (solo) {
    const before = pose.armL ? JOINTS.map((j) => [...pose[j]] as Joint) : [];
    const e = envelope(p, Math.min(0.2, 0.35 / length));
    solo(pose, p, s, e);
    alive(pose, before, s, seed, e);
    return pose;
  }
  const pair = TOGETHER[act.id];
  if (!pair) return pose;

  const toward = act.toward ?? { x: 0, z: 1 };
  const distance = Math.hypot(toward.x, toward.z) || 1;
  const dir = { x: toward.x / distance, z: toward.z / distance };
  const facing = Math.atan2(dir.x, dir.z);
  const close = CLOSE[act.id];
  const stop = act.stay || act.met || close === undefined ? undefined : close * Math.max(1, act.reach ?? 1);
  const gather = stop === undefined ? 0 : 0.26;
  const doing = stop === undefined ? envelope(p, 0.14) : smooth(gather, gather + 0.08, p) * (1 - smooth(1 - gather - 0.04, 1 - gather + 0.03, p));
  // Turns to the other as soon as it starts, and back at the very end.
  const facingNow = envelope(p, 0.1);
  if (!act.met) pose.turn += facing * facingNow;
  if (act.role === "actor" && stop !== undefined) {
    const there = smooth(0, gather, p) * (1 - smooth(1 - gather, 1, p));
    const walkDistance = Math.max(0, distance - stop);
    const along = walkDistance * there;
    pose.x += dir.x * along;
    // A long way passes in front of whoever stands between, not through them.
    pose.z += dir.z * along + Math.sin(Math.PI * there) * 0.55 * clamp01(distance - 1.3);
    const moving = p < gather ? bump(p, 0, gather) : p > 1 - gather ? bump(p, 1 - gather, 1) : 0;
    const pace = Math.min(1, (walkDistance / (gather * length)) * 0.9);
    if (moving > 0.01 && walkDistance > 0.05) steps(pose, moving * pace, along + s * 0.2);
  }
  pair({ pose, p, s, doing, role: act.role === "target" ? "target" : "actor", toward });
  if (act.stay) {
    pose.x = 0;
    pose.z = 0;
  }
  return pose;
}

/**
 * Where a thrown thing (a heart, a snowball) is, 0–1 of its way, or null when nothing flies: it leaves the hand at
 * 40% of the act and lands at 60%.
 */
export function flight(id: string, elapsed: number): number | null {
  if (!THROWN.has(id)) return null;
  const p = elapsed / actLength(id);
  const q = (p - 0.4) / 0.2;
  return q >= 0 && q <= 1 ? q : null;
}
