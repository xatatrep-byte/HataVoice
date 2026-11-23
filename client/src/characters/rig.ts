/**
 * How the joints of `motion.ts` come to any human skeleton. A pose speaks of limbs hanging down; a model's skeleton is
 * spoken to the way VRM does it, «normalized»: every bone turned from a T-pose in the axes of the room, the model facing +Z.
 * Everything else (a skeleton in another pose or with other names) is brought to that by the rig of `model.ts`.
 */
import { Euler, Quaternion, Vector3 } from "three";
import type { Joint, JointName } from "./motion";

export const HUMAN_BONES = [
  "hips", "spine", "chest", "neck", "head",
  "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot",
] as const;
export type HumanBone = (typeof HUMAN_BONES)[number];

export const BONE_OF: Record<JointName, HumanBone> = {
  hips: "hips",
  spine: "spine",
  chest: "chest",
  neck: "neck",
  head: "head",
  armL: "leftUpperArm",
  foreL: "leftLowerArm",
  handL: "leftHand",
  armR: "rightUpperArm",
  foreR: "rightLowerArm",
  handR: "rightHand",
  legL: "leftUpperLeg",
  shinL: "leftLowerLeg",
  footL: "leftFoot",
  legR: "rightUpperLeg",
  shinR: "rightLowerLeg",
  footR: "rightFoot",
};

/** Lowering an arm out of the T-pose: the left one points to +X there, the right one to −X. */
const DOWN = {
  L: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2),
  R: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2),
};
const UP = { L: DOWN.L.clone().invert(), R: DOWN.R.clone().invert() };

const euler = new Euler(0, 0, 0, "YXZ");

/** A joint's turn as a quaternion: the same order a figure's joints have. */
export function jointQuaternion(joint: Joint, out = new Quaternion()): Quaternion {
  euler.set(joint[0], joint[1], joint[2], "YXZ");
  return out.setFromEuler(euler);
}

/** A quaternion as a joint's turn. */
export function quaternionJoint(q: Quaternion): Joint {
  euler.setFromQuaternion(q, "YXZ");
  return [euler.x, euler.y, euler.z];
}

const ARM = new Set<JointName>(["armL", "armR"]);
const FOREARM = new Set<JointName>(["foreL", "handL", "foreR", "handR"]);
const sideOf = (name: JointName) => (name.endsWith("L") ? "L" : "R");

/** One joint of a pose as the normalized bone's turn. */
export function normalizedBone(name: JointName, joint: Joint, out = new Quaternion()): Quaternion {
  jointQuaternion(joint, out);
  if (ARM.has(name)) return out.multiply(DOWN[sideOf(name)]);
  if (FOREARM.has(name)) {
    const side = sideOf(name);
    return out.premultiply(UP[side]).multiply(DOWN[side]);
  }
  return out;
}

/** The other way: a normalized bone's turn as the joint of a pose (for motions taken from a file). */
export function jointFromBone(name: JointName, bone: Quaternion): Joint {
  const q = bone.clone();
  if (ARM.has(name)) q.multiply(UP[sideOf(name)]);
  else if (FOREARM.has(name)) {
    const side = sideOf(name);
    q.premultiply(DOWN[side]).multiply(UP[side]);
  }
  return quaternionJoint(q);
}

/** Where a limb points in a T-pose, for telling a skeleton in another pose. */
export const T_POSE_DIRECTION: Partial<Record<HumanBone, Vector3>> = {
  leftUpperArm: new Vector3(1, 0, 0),
  leftLowerArm: new Vector3(1, 0, 0),
  rightUpperArm: new Vector3(-1, 0, 0),
  rightLowerArm: new Vector3(-1, 0, 0),
  leftUpperLeg: new Vector3(0, -1, 0),
  leftLowerLeg: new Vector3(0, -1, 0),
  rightUpperLeg: new Vector3(0, -1, 0),
  rightLowerLeg: new Vector3(0, -1, 0),
  spine: new Vector3(0, 1, 0),
  chest: new Vector3(0, 1, 0),
  neck: new Vector3(0, 1, 0),
};

const BONE_NAMES: Record<HumanBone, RegExp> = {
  hips: /^(hips?|pelvis|root_?hips|bip\d*_?pelvis)$/,
  spine: /^(spine|spine_?0?1|abdomen|waist|bip\d*_?spine)$/,
  chest: /^(chest|spine_?0?[23]|upper_?body|bip\d*_?spine1)$/,
  neck: /^(neck|neck_?0?1|bip\d*_?neck)$/,
  head: /^(head|bip\d*_?head)$/,
  leftUpperArm: /^(left_?(upper_?)?arm|l_?(upper_?)?arm|(upper_?)?arm_?l|upperarm_?left|arm_?left|bip\d*_?l_?upperarm)$/,
  leftLowerArm: /^(left_?(lower_?|fore_?)arm|l_?(lower_?|fore_?)arm|(lower_?|fore_?)arm_?l|lowerarm_?left|forearm_?left|bip\d*_?l_?forearm)$/,
  leftHand: /^(left_?hand|l_?hand|hand_?l|hand_?left|bip\d*_?l_?hand)$/,
  rightUpperArm: /^(right_?(upper_?)?arm|r_?(upper_?)?arm|(upper_?)?arm_?r|upperarm_?right|arm_?right|bip\d*_?r_?upperarm)$/,
  rightLowerArm: /^(right_?(lower_?|fore_?)arm|r_?(lower_?|fore_?)arm|(lower_?|fore_?)arm_?r|lowerarm_?right|forearm_?right|bip\d*_?r_?forearm)$/,
  rightHand: /^(right_?hand|r_?hand|hand_?r|hand_?right|bip\d*_?r_?hand)$/,
  leftUpperLeg: /^(left_?(up_?|upper_?)leg|l_?(up_?|upper_?)leg|(up_?|upper_?)leg_?l|left_?thigh|l_?thigh|thigh_?l|thigh_?left|bip\d*_?l_?thigh)$/,
  leftLowerLeg: /^(left_?(lower_?)?leg|l_?(lower_?)?leg|(lower_?)?leg_?l|left_?(shin|calf)|l_?(shin|calf)|(shin|calf)_?l|(shin|calf)_?left|bip\d*_?l_?calf)$/,
  leftFoot: /^(left_?foot|l_?foot|foot_?l|foot_?left|bip\d*_?l_?foot)$/,
  rightUpperLeg: /^(right_?(up_?|upper_?)leg|r_?(up_?|upper_?)leg|(up_?|upper_?)leg_?r|right_?thigh|r_?thigh|thigh_?r|thigh_?right|bip\d*_?r_?thigh)$/,
  rightLowerLeg: /^(right_?(lower_?)?leg|r_?(lower_?)?leg|(lower_?)?leg_?r|right_?(shin|calf)|r_?(shin|calf)|(shin|calf)_?r|(shin|calf)_?right|bip\d*_?r_?calf)$/,
  rightFoot: /^(right_?foot|r_?foot|foot_?r|foot_?right|bip\d*_?r_?foot)$/,
};

/** A bone's name without what rigging tools put around it: `mixamorig:LeftArm`, `Armature|DEF-thigh.L`, `CC_Base_Hip`. */
export function plainBoneName(name: string): string {
  let plain = name.split(/[|/]/).pop() ?? name;
  plain = plain.replace(/^(mixamorig\d*:?|cc_base_|def[-_]|armature_?|skeleton_?|character\d*_?|j_bip_[clr]_)/i, "");
  // CamelCase and separators become one way of writing: LeftUpperArm, left.upper_arm, upperarm.L.
  plain = plain.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.\s-]+/g, "_").toLowerCase();
  return plain;
}

/** Which human bone this name means, if any. */
export function humanBoneOf(name: string): HumanBone | null {
  const plain = plainBoneName(name);
  const squeezed = plain.replace(/_/g, "");
  for (const bone of HUMAN_BONES) {
    if (BONE_NAMES[bone].test(plain) || BONE_NAMES[bone].test(squeezed)) return bone;
  }
  return null;
}
