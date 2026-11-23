/**
 * A real 3D model on the stage: VRM (with its expressions, its gaze and hair that moves by itself), or any GLB with a
 * human skeleton. It takes the same poses as the figures built in code, so every emote, every act between friends and
 * every motion from the workshop works on it. Loaded only when someone is shown with one.
 */
import * as THREE from "three";
import { bodyRadius, DEFAULT_RADIUS } from "./spacing";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { parsePack, type Clip } from "./clip";
import { armPush, buildProfile, type BodyProfile } from "./clearance";
import { avatarFileUrl, galleryUrl, parseAvatar } from "./gallery";
import { galleryMotions } from "./iskraMotions";
import { inspectModel, ModelError } from "./glb";
import { JOINTS, type JointName, type Pose } from "./motion";
import { BONE_OF, HUMAN_BONES, humanBoneOf, normalizedBone, T_POSE_DIRECTION, type HumanBone } from "./rig";
import type { MotionFrame } from "./mocap";

/** Every model stands this tall on the stage: next to each other, they look like people in one room. */
const STAGE_HEIGHT = 1.46;

const FINGERS = ["Index", "Middle", "Ring", "Little"] as const;
const JOINT_PARTS = ["Proximal", "Intermediate", "Distal"] as const;

const q = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/**
 * Motion capture over a drawn pose: each bone's turn from the recording, blended in by `weight`, except the joints the
 * pose keeps (the arm an act waves with, say).
 */
export type MotionLayer = {
  frame: MotionFrame;
  weight: number;
  keep: ReadonlySet<JointName>;
  /** The head turned toward whoever speaks, radians, on top of the recording's head. */
  lookYaw: number;
};

/** Bones the drawn poses have no joint for: the recording moves them, by the joint they belong to. */
const EXTRA_BONES: [string, JointName][] = [
  ["upperChest", "chest"],
  ["leftShoulder", "armL"],
  ["rightShoulder", "armR"],
  ["leftToes", "footL"],
  ["rightToes", "footR"],
];
for (const side of ["left", "right"] as const) {
  const hand: JointName = side === "left" ? "handL" : "handR";
  EXTRA_BONES.push([`${side}ThumbMetacarpal`, hand], [`${side}ThumbProximal`, hand], [`${side}ThumbDistal`, hand]);
  for (const finger of ["Index", "Middle", "Ring", "Little"]) for (const part of ["Proximal", "Intermediate", "Distal"]) EXTRA_BONES.push([`${side}${finger}${part}`, hand]);
}
const FINGER = /Thumb|Index|Middle|Ring|Little/;

/** What a skeleton of any kind has to do. */
type Skeleton = {
  scene: THREE.Object3D;
  /** Turns a bone from the T-pose, in the axes of the room. */
  setBone: (bone: HumanBone, turn: THREE.Quaternion) => void;
  /** The same for a bone of the recordings that is no joint of a pose (fingers, shoulders, toes); false if there is none. */
  setExtra: (bone: string, turn: THREE.Quaternion) => boolean;
  /** Whether the skeleton has that bone. */
  hasExtra: (bone: string) => boolean;
  node: (bone: HumanBone) => THREE.Object3D | null;
  setHand: (side: "left" | "right", curl: number) => void;
  setFace: (pose: Pose) => void;
  commit: (dt: number) => void;
  /** Puts the bones where the turns set so far say, without moving hair or anything else that swings: to look before `commit`. */
  probe: () => void;
  /** Once, at rest: what the moving parts of the model hang back to. */
  settle: () => void;
  /** Once, where it first stands: the hair starts from there, or it would fly in from where the file had it. */
  arrive: () => void;
  dispose: () => void;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function mouthShapes(pose: Pose) {
  const open = clamp01(pose.mouth);
  const wide = Math.max(-1, Math.min(1, pose.mouthWide));
  return { aa: open * (0.55 + 0.45 * (1 - Math.abs(wide))), ih: open * Math.max(0, wide) * 0.55, ou: open * Math.max(0, -wide) * 0.75, ee: open * Math.max(0, wide) * 0.25 };
}

function vrmSkeleton(vrm: VRM): Skeleton {
  const humanoid = vrm.humanoid;
  const nodeOf = (bone: string) => humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName);
  const hasChest = !!nodeOf("chest");
  const hasNeck = !!nodeOf("neck");
  const keep = { spine: new THREE.Quaternion(), neck: new THREE.Quaternion() };
  // A VRM 0 was made facing away from us and stands turned round: inside that turn, x and z go the other way.
  const turned = vrm.meta?.metaVersion === "0";
  const facing = new THREE.Quaternion();
  const inFacing = (q: THREE.Quaternion) => (turned ? facing.set(-q.x, q.y, -q.z, q.w) : facing.copy(q));
  const faces = vrm.expressionManager;
  const set = (name: string, value: number) => faces?.setValue(name, value);
  const hasShape = (name: string) => !!faces?.getExpression(name);
  return {
    scene: vrm.scene,
    node: (bone) => humanoid.getRawBoneNode(bone as VRMHumanBoneName),
    setBone(bone, turn) {
      const local = inFacing(turn);
      // A skeleton without some bones takes their turn in the next one down the spine.
      if (bone === "spine" && !hasChest) {
        keep.spine.copy(local);
        return;
      }
      if (bone === "chest" && !hasChest) {
        nodeOf("spine")?.quaternion.copy(keep.spine).multiply(local);
        return;
      }
      if (bone === "neck" && !hasNeck) {
        keep.neck.copy(local);
        return;
      }
      if (bone === "head" && !hasNeck) {
        nodeOf("head")?.quaternion.copy(keep.neck).multiply(local);
        return;
      }
      nodeOf(bone)?.quaternion.copy(local);
    },
    setExtra(bone, turn) {
      const node = nodeOf(bone);
      if (!node) return false;
      node.quaternion.copy(inFacing(turn));
      return true;
    },
    hasExtra: (bone) => !!nodeOf(bone),
    setHand(side, curl) {
      const sign = (side === "left" ? -1 : 1) * (turned ? -1 : 1);
      for (const finger of FINGERS) {
        for (const [i, part] of JOINT_PARTS.entries()) {
          nodeOf(`${side}${finger}${part}`)?.quaternion.setFromAxisAngle(AXIS_Z, sign * curl * (i === 0 ? 0.85 : 1.1));
        }
      }
      nodeOf(`${side}ThumbProximal`)?.quaternion.setFromAxisAngle(AXIS_Y, -sign * curl * 0.5);
      nodeOf(`${side}ThumbDistal`)?.quaternion.setFromAxisAngle(AXIS_Y, -sign * curl * 0.6);
    },
    setFace(pose) {
      const mouth = mouthShapes(pose);
      set("aa", mouth.aa);
      set("ih", mouth.ih);
      set("ou", mouth.ou);
      set("ee", mouth.ee);
      const smile = clamp01((pose.smile - 0.12) * 0.75);
      const hasJoy = hasShape("happy");
      const happy = clamp01(pose.happy);
      set("happy", happy);
      set("relaxed", happy > 0.3 ? 0 : hasShape("relaxed") ? smile * 0.55 : 0);
      // A brow slanted one way is anger, the other way sorrow; high brows and an open mouth, surprise.
      const angry = clamp01(pose.browSlant * 1.2);
      const sad = clamp01(-pose.browSlant * 1.2 + (pose.smile < -0.2 ? -pose.smile * 0.5 : 0));
      set("angry", angry);
      set("sad", sad);
      set("surprised", clamp01((pose.brow - 0.45) * 1.8) * (pose.mouth > 0.2 ? 1 : 0.4));
      // Eyes shut in a laugh are in the expression already.
      const shut = clamp01(pose.eyes);
      set("blink", hasJoy && happy > 0.55 ? 0 : shut);
      if (vrm.lookAt) {
        vrm.lookAt.yaw = -pose.lookX * 16;
        vrm.lookAt.pitch = pose.lookY * 10;
      }
    },
    commit(dt) {
      vrm.update(dt);
    },
    probe() {
      vrm.humanoid.update();
    },
    settle() {
      vrm.scene.updateWorldMatrix(true, true);
      vrm.springBoneManager?.setInitState();
    },
    arrive() {
      vrm.humanoid.update();
      vrm.scene.updateWorldMatrix(true, true);
      vrm.springBoneManager?.reset();
    },
    dispose() {
      VRMUtils.deepDispose(vrm.scene);
    },
  };
}

const PARENT: Record<HumanBone, HumanBone | null> = {
  hips: null,
  spine: "hips",
  chest: "spine",
  neck: "chest",
  head: "neck",
  leftUpperArm: "chest",
  leftLowerArm: "leftUpperArm",
  leftHand: "leftLowerArm",
  rightUpperArm: "chest",
  rightLowerArm: "rightUpperArm",
  rightHand: "rightLowerArm",
  leftUpperLeg: "hips",
  leftLowerLeg: "leftUpperLeg",
  leftFoot: "leftLowerLeg",
  rightUpperLeg: "hips",
  rightLowerLeg: "rightUpperLeg",
  rightFoot: "rightLowerLeg",
};

const NEXT: Partial<Record<HumanBone, HumanBone>> = {
  spine: "chest",
  chest: "neck",
  neck: "head",
  leftUpperArm: "leftLowerArm",
  leftLowerArm: "leftHand",
  rightUpperArm: "rightLowerArm",
  rightLowerArm: "rightHand",
  leftUpperLeg: "leftLowerLeg",
  leftLowerLeg: "leftFoot",
  rightUpperLeg: "rightLowerLeg",
  rightLowerLeg: "rightFoot",
};

const REQUIRED: HumanBone[] = ["hips", "head", "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm", "leftUpperLeg", "leftLowerLeg", "rightUpperLeg", "rightLowerLeg"];

/** The human bones of a scene by their names; throws when something is missing. */
export function findBones(scene: THREE.Object3D): Map<HumanBone, THREE.Object3D> {
  const found = new Map<HumanBone, THREE.Object3D>();
  scene.traverse((node) => {
    if (!node.name) return;
    const bone = humanBoneOf(node.name);
    if (bone && !found.has(bone) && ((node as THREE.Bone).isBone || !(node as THREE.Mesh).isMesh)) found.set(bone, node);
  });
  const missing = REQUIRED.filter((bone) => !found.has(bone));
  if (missing.length > 0) throw new ModelError("В модели нет человеческого скелета: её нельзя двигать. Подойдёт VRM или модель с костями как у Mixamo");
  return found;
}

/** Any GLB with a human skeleton, in any pose, with bones under any names, brought to what a VRM does by itself. */
function plainSkeleton(scene: THREE.Object3D, animations: THREE.AnimationClip[]): Skeleton {
  void animations;
  const bones = findBones(scene);
  const holder = new THREE.Group();
  holder.add(scene);
  holder.updateWorldMatrix(true, true);
  const position = (bone: HumanBone) => bones.get(bone)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
  // The model's left is +X when it faces us: one built looking away is turned round.
  if (position("leftUpperArm").x < position("rightUpperArm").x) {
    scene.rotation.y += Math.PI;
    holder.updateWorldMatrix(true, true);
  }
  type Part = { node: THREE.Object3D; rest: THREE.Quaternion; fix: THREE.Quaternion; turn: THREE.Quaternion; total: THREE.Quaternion };
  const parts = new Map<HumanBone, Part>();
  for (const bone of HUMAN_BONES) {
    const node = bones.get(bone);
    if (!node) continue;
    const fix = new THREE.Quaternion();
    const wanted = T_POSE_DIRECTION[bone];
    const next = NEXT[bone] && (bones.get(NEXT[bone]!) ? NEXT[bone]! : NEXT[NEXT[bone]!]);
    if (wanted && next && bones.get(next)) {
      const direction = position(next).sub(position(bone)).normalize();
      if (direction.lengthSq() > 0.5) fix.setFromUnitVectors(direction, wanted);
    }
    parts.set(bone, { node, rest: node.getWorldQuaternion(new THREE.Quaternion()), fix, turn: new THREE.Quaternion(), total: new THREE.Quaternion() });
  }
  const parentOf = (bone: HumanBone): Part | null => {
    let up = PARENT[bone];
    while (up && !parts.get(up)) up = PARENT[up];
    return up ? parts.get(up)! : null;
  };
  // Rest of the bones in between: what they add stays as it was.
  const worlds = new Map<THREE.Object3D, THREE.Quaternion>();
  const worldOf = (node: THREE.Object3D): THREE.Quaternion => {
    const known = worlds.get(node);
    if (known) return known;
    const parent = node.parent;
    const world = parent && parent !== holder ? worldOf(parent).clone().multiply(node.quaternion) : node.quaternion.clone();
    worlds.set(node, world);
    return world;
  };
  // Faces, as far as the model has them.
  type Shape = { mesh: THREE.Mesh; index: number };
  const shapes = { blink: [] as Shape[], mouth: [] as Shape[], smile: [] as Shape[] };
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
      const plain = name.toLowerCase();
      if (/blink$|blink_?both|eyes?_?clos|eye_?close/.test(plain)) shapes.blink.push({ mesh, index });
      else if (/^(a|aa|v_?aa|viseme_aa|mth_?a|jaw_?open|mouth_?open|mouthopen)$/.test(plain)) shapes.mouth.push({ mesh, index });
      else if (/smile|happy|joy/.test(plain)) shapes.smile.push({ mesh, index });
    }
  });
  const setShapes = (list: Shape[], value: number) => list.forEach(({ mesh, index }) => (mesh.morphTargetInfluences![index] = value));
  const fingers = new Map<"left" | "right", THREE.Object3D[]>([["left", []], ["right", []]]);
  scene.traverse((node) => {
    const plain = node.name.toLowerCase();
    if (!/(index|middle|ring|pinky|little)/.test(plain)) return;
    if (/(left|_l$|\.l$|^l_)/.test(plain)) fingers.get("left")!.push(node);
    else if (/(right|_r$|\.r$|^r_)/.test(plain)) fingers.get("right")!.push(node);
  });
  const fingerRest = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const list of fingers.values()) for (const node of list) fingerRest.set(node, node.quaternion.clone());
  const commit = () => {
    worlds.clear();
    for (const bone of HUMAN_BONES) {
      const part = parts.get(bone);
      if (!part) continue;
      const parent = parentOf(bone);
      part.total.copy(parent ? parent.total : q2.identity()).multiply(part.turn);
      const world = q.copy(part.total).multiply(part.fix).multiply(part.rest);
      const above = part.node.parent && part.node.parent !== holder ? worldOf(part.node.parent) : q2.identity();
      part.node.quaternion.copy(above).invert().multiply(world);
      worlds.set(part.node, world.clone());
    }
  };

  return {
    scene: holder,
    node: (bone) => bones.get(bone) ?? null,
    setBone(bone, turn) {
      parts.get(bone)?.turn.copy(turn);
    },
    // Only the human bones are brought to the T-pose here: fingers and the rest keep the file's own pose.
    setExtra: () => false,
    hasExtra: () => false,
    setHand(side, curl) {
      const sign = side === "left" ? -1 : 1;
      for (const node of fingers.get(side)!) node.quaternion.copy(fingerRest.get(node)!).multiply(q.setFromAxisAngle(AXIS_Z, sign * curl));
    },
    setFace(pose) {
      setShapes(shapes.blink, clamp01(pose.eyes));
      setShapes(shapes.mouth, clamp01(pose.mouth));
      setShapes(shapes.smile, clamp01(pose.smile));
    },
    commit,
    probe: commit,
    settle() {},
    arrive() {},
    dispose() {
      VRMUtils.deepDispose(scene);
    },
  };
}

const turn = new THREE.Quaternion();
const vertex = new THREE.Vector3();

type Arm = { upper: THREE.Object3D; lower: THREE.Object3D; hand: THREE.Object3D };

/**
 * The body of a model in its rest pose as points in `frame`, all of it but the arms and the head (hair hangs from it):
 * what an arm must not go into. And how thick the forearms are, sleeves included.
 */
function measureBody(body: THREE.Object3D, frame: THREE.Object3D, arms: Arm[], head: THREE.Object3D | null): { profile: BodyProfile | null; margin: number } {
  const skipped = new Set<THREE.Object3D>();
  for (const root of [...arms.map((a) => a.upper), head]) root?.traverse((node) => skipped.add(node));
  const forearms = new Map(arms.map((a) => [a.lower, a]));
  const inverse = new THREE.Matrix4().copy(frame.matrixWorld).invert();
  const line = new THREE.Line3();
  const closest = new THREE.Vector3();
  const points: number[] = [];
  let thickness = 0;
  body.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const attributes = mesh.geometry.attributes;
    const position = attributes.position;
    const index = attributes.skinIndex;
    const weight = attributes.skinWeight;
    if (!position || !index || !weight) return;
    const stride = position.count > 80_000 ? 2 : 1;
    for (let i = 0; i < position.count; i += stride) {
      let best = 0;
      let heaviest = -1;
      for (let k = 0; k < 4; k++) {
        const w = weight.getComponent(i, k);
        if (w > heaviest) {
          heaviest = w;
          best = index.getComponent(i, k);
        }
      }
      const bone = mesh.skeleton.bones[best];
      if (!bone) continue;
      mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
      const forearm = forearms.get(bone);
      if (forearm) {
        line.set(forearm.lower.getWorldPosition(new THREE.Vector3()), forearm.hand.getWorldPosition(new THREE.Vector3()));
        line.closestPointToPoint(vertex, true, closest);
        thickness = Math.max(thickness, Math.min(0.09, closest.distanceTo(vertex)));
      }
      if (skipped.has(bone)) continue;
      vertex.applyMatrix4(inverse);
      points.push(vertex.x, vertex.y, vertex.z);
    }
  });
  return { profile: buildProfile(points), margin: Math.min(0.06, Math.max(0.025, thickness * 0.7)) };
}

/** A model standing on the stage, with the same outside as a figure built in code. */
export class ModelFigure {
  readonly root = new THREE.Group();
  readonly height: number;
  private readonly tipper = new THREE.Group();
  private readonly hipHeight: number;
  private lastTime = 0;
  private fresh = true;
  private readonly handNode: THREE.Object3D | null;
  private readonly headNode: THREE.Object3D | null;
  /** How far a figure's hips are from the floor: a pose's crouch is measured by them. */
  private readonly crouchScale: number;
  /** Where the body is, for keeping the arms out of it; null when the model has nothing to measure. */
  private readonly profile: BodyProfile | null = null;
  private readonly margin: number = 0.03;
  /** How far the body reaches from its middle: nobody stands closer than two of these. */
  readonly radius: number = DEFAULT_RADIUS;
  private readonly arms: [Arm | null, Arm | null];
  /** How far each arm (left, right) is turned out now, eased from frame to frame. */
  private readonly push: [number, number] = [0, 0];
  /** The upper arms' turns as set this frame (pose and recording blended), for turning them out of the body. */
  private readonly armTurn: [THREE.Quaternion, THREE.Quaternion] = [new THREE.Quaternion(), new THREE.Quaternion()];
  /** Whether a recording moved each arm this frame. */
  private readonly armRecorded: [boolean, boolean] = [false, false];
  /** Whether the skeleton has an upper chest of its own; without one its turn goes into the neck and shoulders. */
  private readonly upperChest: boolean;
  /** A model plays motion capture (a drawn figure does not). */
  readonly recorded = true;

  /** How high its hips are, metres: a recording's stride and sway are measured in these. */
  get hipsHeight(): number {
    return this.hipHeight;
  }

  constructor(private readonly skeleton: Skeleton) {
    const body = skeleton.scene;
    this.tipper.add(body);
    this.root.add(this.tipper);
    this.root.updateWorldMatrix(true, true);
    // All models the same height, feet on the floor.
    const box = new THREE.Box3().setFromObject(body);
    const size = box.max.y - box.min.y;
    const scale = size > 0.01 ? STAGE_HEIGHT / size : 1;
    body.scale.setScalar(scale);
    body.position.y = -box.min.y * scale;
    this.root.updateWorldMatrix(true, true);
    const hips = skeleton.node("hips");
    this.hipHeight = hips ? hips.getWorldPosition(new THREE.Vector3()).y : STAGE_HEIGHT * 0.5;
    body.position.y -= this.hipHeight;
    this.tipper.position.y = this.hipHeight;
    this.height = STAGE_HEIGHT;
    this.crouchScale = this.hipHeight / 0.56;
    this.handNode = skeleton.node("rightHand");
    this.headNode = skeleton.node("head");
    body.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
      }
    });
    const arm = (side: "left" | "right"): Arm | null => {
      const upper = skeleton.node(`${side}UpperArm`);
      const lower = skeleton.node(`${side}LowerArm`);
      const hand = skeleton.node(`${side}Hand`);
      return upper && lower && hand ? { upper, lower, hand } : null;
    };
    this.arms = [arm("left"), arm("right")];
    this.root.updateWorldMatrix(true, true);
    try {
      const measured = measureBody(body, this.tipper, this.arms.filter((a): a is Arm => !!a), this.headNode);
      this.profile = measured.profile;
      this.margin = measured.margin;
      this.radius = bodyRadius(measured.profile);
    } catch (e) {
      // A model measured wrong only keeps its arms as the pose has them.
      console.warn("could not measure the model's body", e);
    }
    this.upperChest = skeleton.hasExtra("upperChest");
    skeleton.settle();
  }

  apply(pose: Pose, time = 0, layer: MotionLayer | null = null) {
    const dt = Math.min(0.05, Math.max(0.001, time - this.lastTime));
    this.lastTime = time;
    this.root.rotation.y = pose.turn;
    const w = layer ? Math.max(0, Math.min(1, layer.weight)) : 0;
    const recorded = (joint: JointName) => w > 0 && !layer!.keep.has(joint);
    // The hips: the pose's crouch and the recording's sway and bob, in this model's hips heights.
    const hips = layer && recorded("hips") ? layer.frame.hips : null;
    this.tipper.position.set(
      hips ? hips.x * this.hipHeight * w : 0,
      this.hipHeight + (pose.y < 0 ? pose.y * this.crouchScale : pose.y) + (hips ? hips.y * this.hipHeight * w : 0),
      hips ? hips.z * this.hipHeight * w : 0,
    );
    this.tipper.rotation.x = -pose.roll;
    const upperChest = layer && recorded("chest") && !this.upperChest ? layer.frame.rot.get("upperChest") : undefined;
    for (const name of JOINTS) {
      const bone = BONE_OF[name as JointName];
      normalizedBone(name, pose[name], turn);
      const mine = layer && recorded(name) ? layer.frame.rot.get(bone) : undefined;
      if (mine) {
        turn.slerp(mine, w);
        // A skeleton without an upper chest: the recording's upper chest turns the neck with it.
        if (name === "neck" && upperChest) turn.premultiply(q.identity().slerp(upperChest, w));
      }
      if (name === "head" && layer && layer.lookYaw !== 0) turn.premultiply(q.setFromAxisAngle(AXIS_Y, layer.lookYaw * (mine ? w : 0)));
      if (name === "armL" || name === "armR") {
        const i = name === "armL" ? 0 : 1;
        this.armTurn[i].copy(turn);
        this.armRecorded[i] = !!mine;
      }
      this.skeleton.setBone(bone, turn);
    }
    this.skeleton.setHand("left", pose.fistL ? 1.25 : 0.22);
    this.skeleton.setHand("right", pose.fistR ? 1.25 : 0.22);
    // Shoulders, upper chest, toes and fingers: the recording's where it moves that part (a fist keeps its fingers),
    // their rest where the pose does.
    for (const [bone, joint] of EXTRA_BONES) {
      const finger = FINGER.test(bone);
      if (finger && (bone.startsWith("left") ? pose.fistL : pose.fistR)) continue;
      const mine = layer && recorded(joint) ? layer.frame.rot.get(bone) : undefined;
      if (finger && !mine) continue;
      q2.identity();
      if (mine) q2.slerp(mine, w);
      if (upperChest && (bone === "leftShoulder" || bone === "rightShoulder")) q2.premultiply(q.identity().slerp(upperChest, w));
      this.skeleton.setExtra(bone, q2);
    }
    this.skeleton.setFace(pose);
    if (this.profile && this.keepOut) this.keepArmsOut(pose, dt, this.fresh);
    if (this.fresh) {
      this.fresh = false;
      this.skeleton.arrive();
    }
    this.skeleton.commit(dt);
  }

  /**
   * Whether arms are turned out of the body and the clothes. The workshop turns it off while a pose is being made, so the
   * hand goes exactly where it is pulled; calls always keep it on.
   */
  keepOut = true;

  /** Put somewhere else at once: what swings (hair, skirts) starts from the new place instead of flying over. */
  jump() {
    this.fresh = true;
  }

  /** An elbow or a hand that the pose puts inside the body or the clothes: its arm turns out from the shoulder to lie on top. */
  private keepArmsOut(pose: Pose, dt: number, snap: boolean) {
    this.skeleton.probe();
    const inFrame = (node: THREE.Object3D) => this.tipper.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
    for (const [i, side] of [[0, 1], [1, -1]] as const) {
      const arm = this.arms[i];
      if (!arm) continue;
      const shoulder = inFrame(arm.upper);
      const elbow = inFrame(arm.lower);
      const wrist = inFrame(arm.hand);
      // The elbow and the wrist only, with half the margin: a hand may rest on a skirt (cloth gives), it need not
      // stand off it — that turned arms out like a penguin's.
      const need = armPush(this.profile!, side, shoulder, [elbow, wrist], this.margin * 0.5);
      const now = this.push[i];
      // Out quickly, back slowly: a hand never sinks in, and never snaps.
      const k = snap ? 1 : 1 - Math.exp(-(need > now ? 30 : 7) * dt);
      this.push[i] = now + (need - now) * k;
      if (this.push[i] < 0.001) continue;
      const joint = side > 0 ? "armL" : "armR";
      if (this.armRecorded[i]) {
        // A recorded arm is turned out as a whole, about the axis from back to front.
        this.skeleton.setBone(BONE_OF[joint], turn.copy(this.armTurn[i]).premultiply(q.setFromAxisAngle(AXIS_Z, side * this.push[i])));
        continue;
      }
      const [x, y, z] = pose[joint];
      this.skeleton.setBone(BONE_OF[joint], normalizedBone(joint, [x, y, z + side * this.push[i]], turn));
    }
  }

  handPosition(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    return (this.handNode ?? this.root).getWorldPosition(new THREE.Vector3());
  }

  headPosition(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    const at = (this.headNode ?? this.root).getWorldPosition(new THREE.Vector3());
    at.y += 0.1;
    return at;
  }

  /** What the whole model tips over with. */
  tipperNode(): THREE.Object3D {
    return this.tipper;
  }

  /** Where each joint of a pose is on this model, in the model's own place: for the workshop's handles. */
  jointNode(name: JointName): THREE.Object3D | null {
    return this.skeleton.node(BONE_OF[name]);
  }

  dispose() {
    this.skeleton.dispose();
  }
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

/** A model from the bytes of its file, checked first: it may have come from a stranger. */
export async function modelFromBytes(bytes: ArrayBuffer, maxBytes?: number): Promise<ModelFigure> {
  inspectModel(bytes, maxBytes);
  const gltf = await loader.parseAsync(bytes, "");
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (vrm) {
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    return new ModelFigure(vrmSkeleton(vrm));
  }
  return new ModelFigure(plainSkeleton(gltf.scene, gltf.animations));
}

const fileCache = new Map<string, Promise<ArrayBuffer>>();

/** A file by its address; the same one for several people is fetched once. */
function fileAt(url: string): Promise<ArrayBuffer> {
  let file = fileCache.get(url);
  if (!file) {
    file = fetch(url).then((reply) => {
      if (!reply.ok) throw new ModelError(`Файл модели не получен: ${reply.status}`);
      return reply.arrayBuffer();
    });
    fileCache.set(url, file);
    // Enough for several people with one model at once; these files are big to keep for good.
    void file.then(
      () => setTimeout(() => fileCache.delete(url), 30_000),
      () => fileCache.delete(url),
    );
  }
  return file;
}

export type LoadedAvatar = { figure: ModelFigure | null; figureCode: string | null; clips: Map<string, Clip> };

/** A person's model by the code in their profile. `address` is the server that keeps the file. */
export async function loadAvatar(code: string, address: string | undefined): Promise<LoadedAvatar> {
  const parsed = parseAvatar(code);
  if (!parsed) throw new ModelError("Неизвестный код персонажа");
  if (parsed.kind === "gallery") return { figure: await modelFromBytes(await fileAt(galleryUrl(parsed.id))), figureCode: null, clips: galleryMotions(parsed.id) };
  // With no server named, only what is on this PC: our own model in the settings.
  if (!address) address = "local";
  const raw = new TextDecoder().decode(await fileAt(avatarFileUrl(address, parsed.sha, parsed.key)));
  const pack = parsePack(JSON.parse(raw));
  if (!pack) throw new ModelError("Файл персонажа испорчен");
  const clips = new Map(pack.clips.map((clip) => [clip.id, clip]));
  if (pack.model) return { figure: await modelFromBytes(await fileAt(avatarFileUrl(address, pack.model.sha, pack.model.key))), figureCode: null, clips };
  if (pack.gallery) return { figure: await modelFromBytes(await fileAt(galleryUrl(pack.gallery))), figureCode: null, clips: galleryMotions(pack.gallery, clips) };
  return { figure: null, figureCode: pack.figure ?? null, clips };
}
