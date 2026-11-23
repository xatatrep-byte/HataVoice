// Turns motion-capture clips into what a VRM model's bones take, for public/motions.
//
//   node scripts/build-motions.mjs <UAL1.glb> <UAL1_RM.glb> <UAL2.glb> <UAL2_RM.glb> <out dir> <bandai dir>
//
// The source is Quaternius' Universal Animation Library 1 and 2, Standard (CC0, quaternius.com): clips recorded on a
// UE-mannequin skeleton that rests in a T-pose facing +Z, as a VRM's normalized skeleton does. So each bone's turn is
// exact: its world rotation now against its world rotation at rest (D = W · W_rest⁻¹), taken relative to its parent in
// the VRM's own hierarchy (l = D_parent⁻¹ · D). The hips' movement is kept in hips heights; the walks and runs carry
// their stride, read from the clips with root motion, so feet can be kept from sliding.
//
// The gestures (bow, waves, calls, hooray, a dance) come from the Bandai Namco Research Motion Dataset 1 and 2 (BVH,
// CC BY-NC 4.0: free for a program nobody pays for, with the authors named; github.com/BandaiNamcoResearchInc). Its
// skeleton faces +Z with Y up as a VRM does, but its joints' axes are its own (a bone runs along its local X) and its
// first frame is not a T-pose but standing with the arms down. So each bone gets a constant correction C from that first
// frame: the VRM bone's turn there (R0: its T-pose direction swung onto the bone's direction, «forward» kept forward; the
// feet as they stand), against the source joint's world turn (W0); every frame is then R = W · C, which carries the
// source's own twist of each bone.
//
// Output: motions.json (bones, clips) and motions.bin (int16 quaternions per frame, one frame for a bone that does not
// move; hips offsets per frame), 30 frames a second.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";

const FPS = 30;

/** UE-mannequin bone → VRM humanoid bone. */
const MAP = {
  pelvis: "hips",
  spine_01: "spine",
  spine_02: "chest",
  spine_03: "upperChest",
  neck_01: "neck",
  Head: "head",
};
for (const [s, side] of [["l", "left"], ["r", "right"]]) {
  Object.assign(MAP, {
    [`clavicle_${s}`]: `${side}Shoulder`,
    [`upperarm_${s}`]: `${side}UpperArm`,
    [`lowerarm_${s}`]: `${side}LowerArm`,
    [`hand_${s}`]: `${side}Hand`,
    [`thumb_01_${s}`]: `${side}ThumbMetacarpal`,
    [`thumb_02_${s}`]: `${side}ThumbProximal`,
    [`thumb_03_${s}`]: `${side}ThumbDistal`,
    [`thigh_${s}`]: `${side}UpperLeg`,
    [`calf_${s}`]: `${side}LowerLeg`,
    [`foot_${s}`]: `${side}Foot`,
    [`ball_${s}`]: `${side}Toes`,
  });
  for (const [finger, vrm] of [["index", "Index"], ["middle", "Middle"], ["ring", "Ring"], ["pinky", "Little"]]) {
    Object.assign(MAP, {
      [`${finger}_01_${s}`]: `${side}${vrm}Proximal`,
      [`${finger}_02_${s}`]: `${side}${vrm}Intermediate`,
      [`${finger}_03_${s}`]: `${side}${vrm}Distal`,
    });
  }
}

/** A VRM bone's parent in the VRM's hierarchy. */
const PARENT = { hips: null, spine: "hips", chest: "spine", upperChest: "chest", neck: "upperChest", head: "neck" };
for (const side of ["left", "right"]) {
  Object.assign(PARENT, {
    [`${side}Shoulder`]: "upperChest",
    [`${side}UpperArm`]: `${side}Shoulder`,
    [`${side}LowerArm`]: `${side}UpperArm`,
    [`${side}Hand`]: `${side}LowerArm`,
    [`${side}ThumbMetacarpal`]: `${side}Hand`,
    [`${side}ThumbProximal`]: `${side}ThumbMetacarpal`,
    [`${side}ThumbDistal`]: `${side}ThumbProximal`,
    [`${side}UpperLeg`]: "hips",
    [`${side}LowerLeg`]: `${side}UpperLeg`,
    [`${side}Foot`]: `${side}LowerLeg`,
    [`${side}Toes`]: `${side}Foot`,
  });
  for (const f of ["Index", "Middle", "Ring", "Little"]) {
    Object.assign(PARENT, {
      [`${side}${f}Proximal`]: `${side}Hand`,
      [`${side}${f}Intermediate`]: `${side}${f}Proximal`,
      [`${side}${f}Distal`]: `${side}${f}Intermediate`,
    });
  }
}
const BONES = Object.keys(PARENT);

/** Which clips, under which ids, from which file; `stride` for those whose root moves forward in the RM file. */
const CLIPS = [
  ["ual1", "Idle_Loop", "idle", { loop: true }],
  ["ual1", "Idle_Talking_Loop", "talk", { loop: true }],
  ["ual1", "Walk_Loop", "walk", { loop: true, stride: true }],
  ["ual1", "Walk_Formal_Loop", "walk_formal", { loop: true, stride: true }],
  ["ual1", "Jog_Fwd_Loop", "jog", { loop: true, stride: true }],
  ["ual1", "Sprint_Loop", "sprint", { loop: true, stride: true }],
  ["ual1", "Crouch_Idle_Loop", "crouch", { loop: true }],
  ["ual1", "Dance_Loop", "dance", { loop: true }],
  ["ual1", "Sitting_Enter", "sit_in", {}],
  ["ual1", "Sitting_Idle_Loop", "sit", { loop: true }],
  ["ual1", "Sitting_Talking_Loop", "sit_talk", { loop: true }],
  ["ual1", "Sitting_Exit", "sit_out", {}],
  ["ual1", "Jump_Start", "jump_in", {}],
  ["ual1", "Jump_Loop", "jump_air", { loop: true }],
  ["ual1", "Jump_Land", "jump_out", {}],
  ["ual1", "Roll", "roll", {}],
  ["ual1", "Hit_Head", "hit_head", {}],
  ["ual1", "Hit_Chest", "hit_chest", {}],
  ["ual1", "Interact", "interact", {}],
  ["ual1", "PickUp_Table", "pickup", {}],
  ["ual1", "Push_Loop", "push", { loop: true }],
  ["ual1", "Punch_Cross", "punch", {}],
  ["ual1", "Punch_Jab", "jab", {}],
  ["ual1", "Spell_Simple_Shoot", "spell", {}],
  ["ual1", "Death01", "death", {}],
  ["ual1", "Fixing_Kneeling", "kneel_fix", {}],
  ["ual2", "Idle_FoldArms_Loop", "fold", { loop: true }],
  ["ual2", "Idle_No_Loop", "no", { loop: true }],
  ["ual2", "Yes", "yes", {}],
  ["ual2", "Idle_TalkingPhone_Loop", "phone", { loop: true }],
  ["ual2", "OverhandThrow", "throw", {}],
  ["ual2", "Hit_Knockback", "knockback", {}],
  ["ual2", "LayToIdle", "lay_up", {}],
  ["ual2", "Consume", "consume", {}],
  ["ual2", "Chest_Open", "open_chest", {}],
  ["ual2", "Zombie_Walk_Fwd_Loop", "zombie", { loop: true, stride: true }],
  ["ual2", "NinjaJump_Start", "ninja_in", {}],
  ["ual2", "NinjaJump_Land", "ninja_out", {}],
  // Bandai Namco: seconds [from, to] of each take, where the gesture is.
  ["bandai", "d1_bow_feminine", "bow", { trim: [1.0, 4.2] }],
  ["bandai", "d1_bow_sad", "bow_sad", { trim: [0.6, 4.6] }],
  ["bandai", "d1_byebye_happy", "byebye", { trim: [0.5, 3.5] }],
  ["bandai", "d1_call_normal", "call", { trim: [0.4, 2.4] }],
  ["bandai", "d1_guide_happy", "guide", { trim: [0.5, 3.3] }],
  ["bandai", "d1_respond_normal", "respond", { trim: [0.2, 3.0] }],
  ["bandai", "d1_bye_angry", "bye_angry", { trim: [0.3, 3.1] }],
  ["bandai", "d2_raise-up-both-hands_youthful", "hooray", {}],
  ["bandai", "d2_wave-right-hand_youthful", "wave", { trim: [0.3, 3.3] }],
];

/** Bandai Namco joint → VRM humanoid bone. */
const BVH_MAP = { Hips: "hips", Spine: "spine", Chest: "chest", Neck: "neck", Head: "head" };
for (const [s, side] of [["L", "left"], ["R", "right"]]) {
  Object.assign(BVH_MAP, {
    [`Shoulder_${s}`]: `${side}Shoulder`,
    [`UpperArm_${s}`]: `${side}UpperArm`,
    [`LowerArm_${s}`]: `${side}LowerArm`,
    [`Hand_${s}`]: `${side}Hand`,
    [`UpperLeg_${s}`]: `${side}UpperLeg`,
    [`LowerLeg_${s}`]: `${side}LowerLeg`,
    [`Foot_${s}`]: `${side}Foot`,
    [`Toes_${s}`]: `${side}Toes`,
  });
}

/** Where a VRM bone points in its T-pose (null: it rests as it stands in the first frame — feet and toes). */
function tDirection(bone) {
  if (/Foot|Toes/.test(bone)) return null;
  if (/^left(Shoulder|UpperArm|LowerArm|Hand)$/.test(bone)) return new Vector3(1, 0, 0);
  if (/^right(Shoulder|UpperArm|LowerArm|Hand)$/.test(bone)) return new Vector3(-1, 0, 0);
  if (/Leg$/.test(bone)) return new Vector3(0, -1, 0);
  return new Vector3(0, 1, 0);
}

/** A turn that takes the pair (a, b) onto (c, d): directions, with the second made square to the first. */
function turnBetween(a, b, c, d) {
  const frame = (x, y) => {
    const u = x.clone().normalize();
    const v = y.clone().sub(u.clone().multiplyScalar(y.dot(u))).normalize();
    const w = u.clone().cross(v);
    return new Matrix4().makeBasis(u, v, w);
  };
  const from = frame(a, b);
  const to = frame(c, d);
  return new Quaternion().setFromRotationMatrix(to.multiply(from.invert()));
}

function readBvh(path) {
  const text = readFileSync(path, "utf8");
  const [head, motion] = text.split(/MOTION\s*/);
  const joints = [];
  const stack = [];
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^(ROOT|JOINT)\s+(\S+)/))) {
      joints.push({ name: m[2], parent: stack.length ? stack[stack.length - 1] : -1, offset: null, channels: [], end: null, children: [] });
      if (stack.length) joints[stack[stack.length - 1]].children.push(joints.length - 1);
      stack.push(joints.length - 1);
    } else if (line.startsWith("End Site")) {
      stack.push(-1 - stack[stack.length - 1]);
    } else if ((m = line.match(/^OFFSET\s+(\S+)\s+(\S+)\s+(\S+)/))) {
      const top = stack[stack.length - 1];
      const v = new Vector3(+m[1], +m[2], +m[3]);
      if (top >= 0) joints[top].offset ??= v;
      else joints[-1 - top].end = v;
    } else if ((m = line.match(/^CHANNELS\s+\d+\s+(.*)/))) {
      joints[stack[stack.length - 1]].channels = m[1].trim().split(/\s+/);
    } else if (line === "}") {
      stack.pop();
    }
  }
  const lines = motion.split(/\r?\n/).filter((l) => l.trim());
  const frameTime = +lines[1].split(":")[1];
  const data = lines.slice(2).map((l) => l.trim().split(/\s+/).map(Number));
  /** Every joint's world turn and place at frame `f`. */
  const world = (f) => {
    const values = data[Math.min(f, data.length - 1)];
    let k = 0;
    const out = [];
    joints.forEach((j, i) => {
      const t = j.offset.clone();
      const angles = { X: 0, Y: 0, Z: 0 };
      let order = "";
      for (const c of j.channels) {
        const v = values[k++];
        if (c.endsWith("position")) t[c[0].toLowerCase()] = v;
        else {
          angles[c[0]] = (v * Math.PI) / 180;
          order += c[0];
        }
      }
      const q = new Quaternion().setFromEuler(new Euler(angles.X, angles.Y, angles.Z, order || "XYZ"));
      if (j.parent < 0) out[i] = { rot: q, pos: t };
      else {
        const p = out[j.parent];
        out[i] = { rot: p.rot.clone().multiply(q), pos: t.applyQuaternion(p.rot).add(p.pos) };
      }
    });
    return out;
  };
  return { joints, frameTime, frames: data.length, world };
}

/** A clip from a Bandai Namco BVH, `trim` seconds [from, to] of it. */
function bakeBvh(path, options) {
  const bvh = readBvh(path);
  const index = new Map(bvh.joints.map((j, i) => [j.name, i]));
  const vrmToJoint = new Map(Object.entries(BVH_MAP).map(([src, vrm]) => [vrm, index.get(src)]));
  const first = bvh.world(0);
  const hipsJoint = index.get("Hips");
  const hipsHeight = first[hipsJoint].pos.y;
  // The correction of each bone, from the first frame.
  const correction = new Map();
  for (const [bone, i] of vrmToJoint) {
    const joint = bvh.joints[i];
    const W0 = first[i].rot;
    const t = tDirection(bone);
    let R0;
    if (!t) R0 = new Quaternion();
    else {
      // Where the bone points: toward its first child (along the chain), or its end site.
      const child = joint.children.find((c) => vrmToJoint.has(BVH_MAP[bvh.joints[c].name])) ?? joint.children[0];
      const local = (child !== undefined ? bvh.joints[child].offset : joint.end).clone().normalize();
      const now = local.applyQuaternion(W0);
      R0 = turnBetween(t, new Vector3(0, 0, 1), now, new Vector3(0, 0, 1));
    }
    correction.set(bone, W0.clone().invert().multiply(R0));
  }
  const [from, to] = options.trim ?? [0, (bvh.frames - 1) * bvh.frameTime];
  const length = to - from;
  const frames = Math.max(2, Math.round(length * FPS) + 1);
  const bones = BONES.filter((b) => vrmToJoint.has(b) || b === "upperChest");
  const tracks = new Map(bones.map((b) => [b, []]));
  const hips = [];
  const start = first[hipsJoint].pos;
  for (let f = 0; f < frames; f++) {
    const t = from + Math.min(length, f / FPS);
    const w = bvh.world(Math.round(t / bvh.frameTime));
    const turn = new Map();
    for (const [bone, i] of vrmToJoint) turn.set(bone, w[i].rot.clone().multiply(correction.get(bone)));
    // No upper chest in the source: it does not turn of its own, the chest carries what is above.
    turn.set("upperChest", turn.get("chest").clone());
    for (const bone of bones) {
      const up = PARENT[bone];
      const local = up ? turn.get(up).clone().invert().multiply(turn.get(bone)) : turn.get(bone).clone();
      const list = tracks.get(bone);
      const prev = list[list.length - 1];
      if (prev && prev.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      list.push(local.normalize());
    }
    const p = w[hipsJoint].pos.clone().sub(start);
    hips.push(new Vector3(p.x, w[hipsJoint].pos.y - hipsHeight, p.z).divideScalar(hipsHeight));
  }
  // The capture shivers: some joints (a forearm's twist above all) jump back and forth from one frame to the next, which
  // on a model reads as a twitch. A binomial window over five frames takes that out (it passes nothing at 15 Hz) and
  // leaves a human gesture (2–3 Hz) nearly whole.
  for (const [bone, list] of tracks) tracks.set(bone, smoothTurns(list));
  return { frames, length, tracks, hips: smoothPlaces(hips), stride: null, loop: !!options.loop };
}

const WINDOW = [1, 4, 6, 4, 1];

/** Neighbouring turns averaged (they are near each other and on one side already, so their components may be). */
function smoothTurns(list) {
  return list.map((_, i) => {
    const q = new Quaternion(0, 0, 0, 0);
    WINDOW.forEach((w, k) => {
      const n = list[Math.max(0, Math.min(list.length - 1, i + k - 2))];
      q.set(q.x + n.x * w, q.y + n.y * w, q.z + n.z * w, q.w + n.w * w);
    });
    return q.normalize();
  });
}

function smoothPlaces(list) {
  return list.map((_, i) => {
    const v = new Vector3();
    WINDOW.forEach((w, k) => v.addScaledVector(list[Math.max(0, Math.min(list.length - 1, i + k - 2))], w / 16));
    return v;
  });
}

function readGlb(path) {
  const data = readFileSync(path);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < view.getUint32(8, true)) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const chunk = data.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  const accessor = (index) => {
    const a = json.accessors[index];
    const bv = json.bufferViews[a.bufferView];
    const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
    if (a.componentType !== 5126) throw new Error(`accessor ${index}: not float`);
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const floats = new Float32Array(bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + a.count * comps * 4));
    return { count: a.count, comps, floats };
  };
  return { json, accessor };
}

/** A skeleton's nodes, their parents, and a way to pose them from a clip at a time. */
function skeletonOf(glb) {
  const nodes = glb.json.nodes;
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
  const byName = new Map(nodes.map((n, i) => [n.name, i]));
  const rest = nodes.map((n) => ({
    t: new Vector3(...(n.translation ?? [0, 0, 0])),
    r: new Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
    s: (n.scale ?? [1, 1, 1])[0],
  }));
  /** World rotation and position of every node, with `local` overriding rest TRS where it has a node. */
  const world = (local) => {
    const rot = new Array(nodes.length);
    const pos = new Array(nodes.length);
    const scale = new Array(nodes.length);
    const visit = (i) => {
      if (rot[i]) return;
      const l = local?.get(i) ?? {};
      const t = l.t ?? rest[i].t;
      const r = l.r ?? rest[i].r;
      const s = rest[i].s;
      if (parent[i] < 0) {
        rot[i] = r.clone();
        pos[i] = t.clone();
        scale[i] = s;
        return;
      }
      visit(parent[i]);
      const p = parent[i];
      rot[i] = rot[p].clone().multiply(r);
      pos[i] = t.clone().multiplyScalar(scale[p]).applyQuaternion(rot[p]).add(pos[p]);
      scale[i] = scale[p] * s;
    };
    nodes.forEach((_, i) => visit(i));
    return { rot, pos };
  };
  return { nodes, byName, world };
}

/** Local TRS of every animated node of `anim` at time `t` (linear, slerp). */
function sampleAt(glb, anim, t) {
  const out = new Map();
  for (const ch of anim.channels) {
    const sampler = anim.samplers[ch.sampler];
    const times = glb.accessor(sampler.input).floats;
    const values = glb.accessor(sampler.output);
    let k = 0;
    while (k < times.length - 2 && times[k + 1] <= t) k++;
    const t0 = times[k];
    const t1 = times[Math.min(k + 1, times.length - 1)];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    const at = (i) => Array.from(values.floats.subarray(i * values.comps, (i + 1) * values.comps));
    const a = at(k);
    const b = at(Math.min(k + 1, times.length - 1));
    const entry = out.get(ch.target.node) ?? {};
    if (ch.target.path === "rotation") entry.r = new Quaternion(...a).slerp(new Quaternion(...b), f);
    else if (ch.target.path === "translation") entry.t = new Vector3(...a).lerp(new Vector3(...b), f);
    out.set(ch.target.node, entry);
  }
  return out;
}

function duration(glb, anim) {
  let d = 0;
  for (const s of anim.samplers) {
    const a = glb.json.accessors[s.input];
    d = Math.max(d, a.max?.[0] ?? 0);
  }
  return d;
}

function bake(glb, rmGlb, name, options) {
  const sk = skeletonOf(glb);
  const anim = glb.json.animations.find((a) => a.name === name);
  if (!anim) throw new Error(`no clip ${name}`);
  const restWorld = sk.world(null);
  const vrmToNode = new Map(Object.entries(MAP).map(([src, vrm]) => [vrm, sk.byName.get(src)]));
  const hipsNode = sk.byName.get("pelvis");
  const hipsHeight = restWorld.pos[hipsNode].y;
  const restInverse = new Map(BONES.map((b) => [b, restWorld.rot[vrmToNode.get(b)].clone().invert()]));
  const length = duration(glb, anim);
  const frames = Math.max(2, Math.round(length * FPS) + 1);
  const tracks = new Map(BONES.map((b) => [b, []]));
  const hips = [];
  for (let f = 0; f < frames; f++) {
    const t = Math.min(length, f / FPS);
    const w = sk.world(sampleAt(glb, anim, t));
    const delta = new Map(BONES.map((b) => [b, w.rot[vrmToNode.get(b)].clone().multiply(restInverse.get(b))]));
    for (const bone of BONES) {
      const up = PARENT[bone];
      const local = up ? delta.get(up).clone().invert().multiply(delta.get(bone)) : delta.get(bone).clone();
      const list = tracks.get(bone);
      const prev = list[list.length - 1];
      if (prev && prev.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      list.push(local.normalize());
    }
    hips.push(w.pos[hipsNode].clone().sub(restWorld.pos[hipsNode]).divideScalar(hipsHeight));
  }
  let stride = null;
  if (options.stride && rmGlb) {
    const rm = skeletonOf(rmGlb);
    const rmAnim = rmGlb.json.animations.find((a) => a.name === name);
    const rmLength = duration(rmGlb, rmAnim);
    const start = rm.world(sampleAt(rmGlb, rmAnim, 0)).pos[rm.byName.get("pelvis")];
    const end = rm.world(sampleAt(rmGlb, rmAnim, rmLength)).pos[rm.byName.get("pelvis")];
    stride = Math.hypot(end.x - start.x, end.z - start.z) / hipsHeight;
  }
  return { frames, length, tracks, hips, stride, loop: !!options.loop };
}

const [ual1Path, ual1RmPath, ual2Path, ual2RmPath, outDir, bandaiDir] = process.argv.slice(2);
const files = { ual1: [readGlb(ual1Path), readGlb(ual1RmPath)], ual2: [readGlb(ual2Path), readGlb(ual2RmPath)] };

const chunks = [];
let offset = 0;
const index = [];
const put = (array) => {
  const buf = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  chunks.push(buf);
  const at = offset;
  offset += buf.length;
  return at;
};
const q16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));

for (const [file, name, id, options] of CLIPS) {
  let clip;
  if (file === "bandai") clip = bakeBvh(join(bandaiDir, `${name}.bvh`), options);
  else {
    const [glb, rm] = files[file];
    clip = bake(glb, rm, name, options);
  }
  const bones = [];
  for (const bone of BONES) {
    const list = clip.tracks.get(bone);
    // A bone the source does not have (fingers in Bandai Namco's takes): left to whatever plays under the act.
    if (!list) continue;
    const first = list[0];
    const still = list.every((q) => Math.abs(q.dot(first)) > 0.99999);
    const values = new Int16Array((still ? 1 : list.length) * 4);
    (still ? [first] : list).forEach((q, i) => values.set([q16(q.x), q16(q.y), q16(q.z), q16(q.w)], i * 4));
    bones.push({ bone: BONES.indexOf(bone), still, at: put(values) });
  }
  const hips = new Int16Array(clip.frames * 3);
  clip.hips.forEach((p, i) => hips.set([p.x, p.y, p.z].map((v) => Math.max(-32767, Math.min(32767, Math.round(v * 8192)))), i * 3));
  const hipsAt = put(hips);
  index.push({ id, source: name, frames: clip.frames, length: +clip.length.toFixed(4), loop: clip.loop, stride: clip.stride === null ? null : +clip.stride.toFixed(4), bones, hips: hipsAt });
  console.log(`${id.padEnd(12)} ${name.padEnd(24)} ${clip.frames} frames${clip.stride !== null ? `, stride ${clip.stride.toFixed(3)} hips` : ""}, moving bones ${bones.filter((b) => !b.still).length}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "motions.bin"), Buffer.concat(chunks));
writeFileSync(
  join(outDir, "motions.json"),
  JSON.stringify({ version: 1, fps: FPS, source: "Quaternius, Universal Animation Library 1 and 2 (CC0); Bandai Namco Research Motion Dataset 1 and 2 (CC BY-NC 4.0)", bones: BONES, quat: 32767, hips: 8192, clips: index }),
);
console.log(`motions.bin ${offset} bytes, ${index.length} clips`);
