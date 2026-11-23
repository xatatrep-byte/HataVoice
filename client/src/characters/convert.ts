/**
 * Files other tools make: an FBX model becomes a GLB (friends get one format), and a motion from an FBX, BVH or GLB file
 * (Mixamo and the like) becomes a clip of the workshop. Loaded only when such a file is opened.
 */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { BVHLoader } from "three/examples/jsm/loaders/BVHLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { emptyClip, keyFromPose, MAX_DURATION, MAX_KEYS, type Clip } from "./clip";
import { ModelError } from "./glb";
import { findBones } from "./model";
import { JOINTS, restPose, type JointName } from "./motion";
import { BONE_OF, humanBoneOf, jointFromBone, type HumanBone } from "./rig";

/** An FBX model as a GLB. Materials become simple ones with their pictures inside. */
export async function fbxToGlb(bytes: ArrayBuffer): Promise<Uint8Array> {
  let scene: THREE.Group;
  try {
    scene = new FBXLoader().parse(bytes, "");
  } catch (e) {
    throw new ModelError(`FBX не читается: ${String(e).slice(0, 120)}`);
  }
  findBones(scene);
  scene.animations = [];
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
  return new Uint8Array(glb as ArrayBuffer);
}

/** What is needed of a file with a motion: a skeleton at rest and a track of it. */
async function motionSource(file: File): Promise<{ root: THREE.Object3D; clip: THREE.AnimationClip }> {
  const name = file.name.toLowerCase();
  const bytes = await file.arrayBuffer();
  if (name.endsWith(".bvh")) {
    const { skeleton, clip } = new BVHLoader().parse(new TextDecoder().decode(bytes));
    const root = new THREE.Group();
    root.add(skeleton.bones[0]!);
    return { root, clip };
  }
  if (name.endsWith(".fbx")) {
    const root = new FBXLoader().parse(bytes, "");
    const clip = root.animations[0];
    if (!clip) throw new ModelError("В этом FBX нет движения");
    return { root, clip };
  }
  if (name.endsWith(".glb") || name.endsWith(".vrma")) {
    const gltf = await new GLTFLoader().parseAsync(bytes, "");
    const clip = gltf.animations[0];
    if (!clip) throw new ModelError("В этом файле нет движения");
    return { root: gltf.scene, clip };
  }
  throw new ModelError("Движение можно взять из .fbx, .bvh или .glb");
}

const STEP = 1 / 15;

/**
 * Plays a motion on its own skeleton and writes down how each bone turned from where it stood: that is what a pose
 * says. The file's skeleton is taken as standing in a T-pose at its start of the rest, as Mixamo's does.
 */
export async function motionToClip(file: File): Promise<Clip> {
  const { root, clip } = await motionSource(file);
  const bones = new Map<HumanBone, THREE.Object3D>();
  root.traverse((node) => {
    if (!node.name) return;
    const bone = humanBoneOf(node.name);
    if (bone && !bones.has(bone)) bones.set(bone, node);
  });
  if (!bones.has("hips") || !bones.has("leftUpperArm") || !bones.has("rightUpperLeg")) throw new ModelError("В файле нет человеческого скелета");

  root.updateWorldMatrix(true, true);
  const rest = new Map<HumanBone, THREE.Quaternion>();
  for (const [bone, node] of bones) rest.set(bone, node.getWorldQuaternion(new THREE.Quaternion()));
  const hips = bones.get("hips")!;
  const hipRest = hips.getWorldPosition(new THREE.Vector3());
  const footY = (bones.get("leftFoot") ?? hips).getWorldPosition(new THREE.Vector3()).y;
  const hipHeight = Math.max(0.001, hipRest.y - footY);

  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  const duration = Math.min(MAX_DURATION, Math.max(0.2, clip.duration));
  const out = emptyClip(file.name.replace(/\.[^.]+$/, "").slice(0, 32));
  out.duration = Number(duration.toFixed(3));
  out.keys = [];
  const parentOf: Partial<Record<HumanBone, HumanBone>> = {
    spine: "hips", chest: "spine", neck: "chest", head: "neck",
    leftUpperArm: "chest", leftLowerArm: "leftUpperArm", leftHand: "leftLowerArm",
    rightUpperArm: "chest", rightLowerArm: "rightUpperArm", rightHand: "rightLowerArm",
    leftUpperLeg: "hips", leftLowerLeg: "leftUpperLeg", leftFoot: "leftLowerLeg",
    rightUpperLeg: "hips", rightLowerLeg: "rightUpperLeg", rightFoot: "rightLowerLeg",
  };
  const total = new Map<HumanBone, THREE.Quaternion>();
  const world = new THREE.Quaternion();
  const steps = Math.min(MAX_KEYS - 1, Math.ceil(duration / STEP));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration;
    mixer.setTime(t);
    root.updateWorldMatrix(true, true);
    total.clear();
    const pose = restPose();
    for (const name of JOINTS as readonly JointName[]) {
      const bone = BONE_OF[name];
      const node = bones.get(bone);
      if (!node) continue;
      node.getWorldQuaternion(world);
      // How far it has turned in the room's axes since rest, and what of that its parent had done already.
      const now = world.clone().multiply(rest.get(bone)!.clone().invert());
      total.set(bone, now);
      let up = parentOf[bone];
      while (up && !total.has(up)) up = parentOf[up];
      const local = up ? total.get(up)!.clone().invert().multiply(now) : now;
      pose[name] = jointFromBone(name, local);
    }
    const position = hips.getWorldPosition(new THREE.Vector3());
    pose.y = (position.y - hipRest.y) / hipHeight * 0.56;
    pose.x = THREE.MathUtils.clamp(((position.x - hipRest.x) / hipHeight) * 0.56, -2, 2);
    pose.z = THREE.MathUtils.clamp(((position.z - hipRest.z) / hipHeight) * 0.56, -2, 2);
    out.keys.push(keyFromPose(pose, t, "linear"));
  }
  return out;
}
