/**
 * The stage of the workshop: one character in a light room, a camera to walk around it with the mouse, a handle on every
 * joint and rings on the chosen one. The handles turn a skeleton of plain objects with the same joints as a pose, so
 * whatever the model's bones are like, what the hand moves is what ends up in the clip.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { parseCharacter, DEFAULT_CHARACTER } from "./character";
import { Figure } from "./figure";
import { turnFromLeftForward, turnFromLeftUp, type Body as Tracked } from "./capture";
import { aimLocal, twoBone } from "./ik";
import { JOINTS, restPose, type Joint, type JointName, type Pose } from "./motion";
import type { ModelFigure } from "./model";

const PARENT: Record<JointName, JointName | null> = {
  hips: null,
  spine: "hips",
  chest: "spine",
  neck: "chest",
  head: "neck",
  armL: "chest",
  foreL: "armL",
  handL: "foreL",
  armR: "chest",
  foreR: "armR",
  handR: "foreR",
  legL: "hips",
  shinL: "legL",
  footL: "shinL",
  legR: "hips",
  shinR: "legR",
  footR: "shinR",
};

type Body = Figure | ModelFigure;

/** What is pulled in «Тянуть»: the ends of the limbs, the head (to look), the hips (to crouch, feet staying put). */
export type PullPart = "handL" | "handR" | "footL" | "footR" | "head" | "hips";
export const PULL_PARTS: readonly PullPart[] = ["handL", "handR", "footL", "footR", "head", "hips"];
const LIMB: Record<"handL" | "handR" | "footL" | "footR", [JointName, JointName]> = {
  handL: ["armL", "foreL"],
  handR: ["armR", "foreR"],
  footL: ["legL", "shinL"],
  footR: ["legR", "shinR"],
};
/** Where elbows and knees point when a limb is straight, in the body's own frame (it faces +Z, its left is +X). */
const POLE: Record<keyof typeof LIMB, THREE.Vector3> = {
  handL: new THREE.Vector3(0.45, -0.15, -1).normalize(),
  handR: new THREE.Vector3(-0.45, -0.15, -1).normalize(),
  footL: new THREE.Vector3(0.12, 0, 1).normalize(),
  footR: new THREE.Vector3(-0.12, 0, 1).normalize(),
};
const FORWARD = new THREE.Vector3(0, 0, 1);

export type StageMode = "turn" | "pull";

type V3 = [number, number, number];
/** A ready pose: where the hands go, from a joint, in arm lengths, in the body's frame; and where elbows point. */
export type ReachPose = { part: "handL" | "handR"; from: JointName; offset: V3; pole: V3 }[];

/** Ready poses, as places for the hands: they fit any body, tall or short, long-armed or not. */
export const READY_POSES: { id: string; name: string; reach: ReachPose }[] = [
  { id: "up", name: "Руки вверх", reach: [
    { part: "handL", from: "armL", offset: [0.18, 0.95, 0.05], pole: [1, 0, -0.3] },
    { part: "handR", from: "armR", offset: [-0.18, 0.95, 0.05], pole: [-1, 0, -0.3] },
  ] },
  { id: "wide", name: "Руки в стороны", reach: [
    { part: "handL", from: "armL", offset: [0.97, 0.05, 0], pole: [0, -0.2, -1] },
    { part: "handR", from: "armR", offset: [-0.97, 0.05, 0], pole: [0, -0.2, -1] },
  ] },
  { id: "hips", name: "Руки в боки", reach: [
    { part: "handL", from: "legL", offset: [0.12, 0.12, 0.02], pole: [1, 0.2, -0.4] },
    { part: "handR", from: "legR", offset: [-0.12, 0.12, 0.02], pole: [-1, 0.2, -0.4] },
  ] },
  { id: "point", name: "Указать", reach: [
    { part: "handR", from: "armR", offset: [-0.1, 0.12, 0.95], pole: [-0.5, -1, 0] },
  ] },
  { id: "heart", name: "Сердце руками", reach: [
    { part: "handL", from: "chest", offset: [0.06, 0.12, 0.5], pole: [1, -0.6, 0] },
    { part: "handR", from: "chest", offset: [-0.06, 0.12, 0.5], pole: [-1, -0.6, 0] },
  ] },
  { id: "wave", name: "Помахать", reach: [
    { part: "handR", from: "armR", offset: [-0.42, 0.7, 0.15], pole: [-0.6, -1, -0.3] },
  ] },
  { id: "think", name: "Думать", reach: [
    { part: "handR", from: "head", offset: [-0.05, -0.12, 0.2], pole: [-0.4, -1, 0.2] },
    { part: "handL", from: "spine", offset: [0.02, 0.05, 0.3], pole: [1, -0.5, 0] },
  ] },
];

/** Everything turned to zero: limbs hanging straight down, as a pose counts from. */
function zeroPose(): Pose {
  const pose = restPose();
  for (const name of JOINTS) pose[name] = [0, 0, 0];
  return pose;
}

export class WorkshopStage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 40);
  private readonly orbit: OrbitControls;
  private readonly rings: TransformControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly environment: THREE.Texture;
  private frame = 0;
  private body: Body | null = null;
  private code: string | null = null;
  private time = 0;
  private dragging = false;
  private pose: Pose = restPose();
  private chosen: JointName | null = null;
  private readonly bones = new Map<JointName, THREE.Group>();
  private readonly handles = new Map<JointName, THREE.Mesh>();
  private readonly handleGeometry = new THREE.SphereGeometry(0.018, 14, 10);
  private readonly handleMaterial: THREE.MeshBasicMaterial;
  private readonly chosenMaterial: THREE.MeshBasicMaterial;
  private downAt: { x: number; y: number } | null = null;
  private showHandles = true;
  private mode: StageMode = "turn";
  private pulling: { part: PullPart; plane: THREE.Plane; from: THREE.Vector3; y: number; feet: [THREE.Vector3, THREE.Vector3]; look: THREE.Vector3 } | null = null;
  private ghost: THREE.LineSegments | null = null;
  private readonly ghostMaterial: THREE.LineBasicMaterial;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    accent: string,
    private readonly onChoose: (joint: JointName | null) => void,
    /** A joint was turned by hand. */
    private readonly onTurn: (joint: JointName, turn: Joint) => void,
    private readonly onTurnEnd: () => void,
    /** «Тянуть»: the whole pose after a pull moved a limb, the head or the hips. */
    private readonly onPull: (pose: Pose) => void = () => {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.3;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x665a4a, 1.1));
    const key = new THREE.DirectionalLight(0xfff2e0, 2);
    key.position.set(-2, 4.4, 3.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -2;
    key.shadow.camera.right = 2;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -1;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;
    this.scene.add(key);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.35 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(8, 32, 0x8a7d6a, 0x4a4238);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(grid);

    this.handleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false });
    this.chosenMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(accent), depthTest: false, toneMapped: false });
    this.ghostMaterial = new THREE.LineBasicMaterial({ color: new THREE.Color(accent), transparent: true, opacity: 0.55, depthTest: false, toneMapped: false });

    this.camera.position.set(0.9, 1.15, 3.6);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 0.78, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.minDistance = 0.5;
    this.orbit.maxDistance = 8;
    this.orbit.maxPolarAngle = Math.PI * 0.62;
    this.orbit.update();

    this.rings = new TransformControls(this.camera, canvas);
    this.rings.setMode("rotate");
    this.rings.setSpace("local");
    this.rings.setSize(0.7);
    this.rings.addEventListener("dragging-changed", (event) => {
      this.dragging = !!event.value;
      this.orbit.enabled = !event.value;
      if (!event.value) this.onTurnEnd();
    });
    this.rings.addEventListener("objectChange", () => {
      const chosen = this.chosen;
      if (!chosen) return;
      const { x, y, z } = this.bones.get(chosen)!.rotation;
      this.pose[chosen] = [x, y, z];
      this.onTurn(chosen, [x, y, z]);
    });
    this.scene.add(this.rings.getHelper());

    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Who stands here: a code, or the figure when there is none. Says when it has come. */
  async setBody(code: string | null, address?: string): Promise<void> {
    if (code === this.code && this.body) return;
    this.code = code;
    let next: Body;
    const built = code ? parseCharacter(code) : null;
    if (code && !built) {
      const { loadAvatar } = await import("./model");
      const loaded = await loadAvatar(code, address);
      if (this.code !== code) {
        loaded.figure?.dispose();
        return;
      }
      next = loaded.figure ?? new Figure(parseCharacter(loaded.figureCode) ?? DEFAULT_CHARACTER);
    } else {
      next = new Figure(built ?? DEFAULT_CHARACTER);
    }
    if (this.body) {
      this.scene.remove(this.body.root);
      this.body.dispose();
    }
    this.body = next;
    this.scene.add(next.root);
    this.buildHandles();
    this.choose(this.chosen);
  }

  /** A skeleton of plain objects with the body's proportions, measured with everything at zero. */
  private buildHandles() {
    const body = this.body!;
    // Measured as the pose says, not with the arms turned out of a skirt.
    if ("keepOut" in body) body.keepOut = false;
    this.rings.detach();
    for (const bone of this.bones.values()) bone.removeFromParent();
    this.bones.clear();
    this.handles.clear();
    body.apply(zeroPose(), this.time);
    body.root.updateWorldMatrix(true, true);
    const at = new Map<JointName, THREE.Vector3>();
    for (const name of JOINTS) {
      const node = body.jointNode(name);
      at.set(name, node ? node.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3());
    }
    const holder = body.tipperNode();
    const holderAt = holder.getWorldPosition(new THREE.Vector3());
    for (const name of JOINTS) {
      const bone = new THREE.Group();
      bone.rotation.order = "YXZ";
      const parent = PARENT[name];
      bone.position.copy(at.get(name)!).sub(parent ? at.get(parent)! : holderAt);
      (parent ? this.bones.get(parent)! : holder).add(bone);
      this.bones.set(name, bone);
      const handle = new THREE.Mesh(this.handleGeometry, this.handleMaterial);
      handle.renderOrder = 1000;
      handle.userData.joint = name;
      handle.visible = this.showHandles;
      bone.add(handle);
      this.handles.set(name, handle);
    }
    this.showModeHandles();
    if ("keepOut" in body) body.keepOut = !this.showHandles;
  }

  setHandles(show: boolean) {
    this.showHandles = show;
    this.showModeHandles();
    // While posing the hand goes where it is pulled; played, arms keep out of the clothes as in a call.
    if (this.body && "keepOut" in this.body) this.body.keepOut = !show;
  }

  /** «Крутить»: rings on a chosen joint. «Тянуть»: big handles on the hands, feet, head and hips to drag. */
  setMode(mode: StageMode) {
    this.mode = mode;
    if (mode === "pull") this.rings.detach();
    else this.choose(this.chosen);
    this.showModeHandles();
  }

  private showModeHandles() {
    for (const [name, handle] of this.handles) {
      const pullable = (PULL_PARTS as readonly string[]).includes(name);
      handle.visible = this.showHandles && (this.mode === "turn" || pullable);
      handle.scale.setScalar(this.mode === "pull" && pullable ? 1.9 : 1);
    }
    this.rings.getHelper().visible = this.showHandles && this.mode === "turn";
  }

  /** A faint stick figure of another pose (the one before), to pose this one against; null takes it away. */
  setGhost(pose: Pose | null) {
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost.geometry.dispose();
      this.ghost = null;
    }
    if (!pose || !this.body) return;
    const points: THREE.Vector3[] = [];
    this.withPose(pose, () => {
      for (const name of JOINTS) {
        const parent = PARENT[name];
        if (!parent) continue;
        points.push(this.bones.get(parent)!.getWorldPosition(new THREE.Vector3()), this.bones.get(name)!.getWorldPosition(new THREE.Vector3()));
      }
    });
    this.ghost = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), this.ghostMaterial);
    this.ghost.renderOrder = 15;
    this.scene.add(this.ghost);
  }

  /** A small picture of the character as it stands now, for a pose's card. */
  snapshot(width = 96, height = 128): string | null {
    try {
      this.settle();
      const ghost = this.ghost?.visible;
      if (this.ghost) this.ghost.visible = false;
      const handles = this.showHandles;
      this.setHandles(false);
      this.renderer.render(this.scene, this.camera);
      this.setHandles(handles);
      if (this.ghost && ghost !== undefined) this.ghost.visible = ghost;
      const source = this.renderer.domElement;
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const sh = source.height;
      const sw = Math.min(source.width, (sh * width) / height);
      out.getContext("2d")?.drawImage(source, (source.width - sw) / 2, 0, sw, sh, 0, 0, width, height);
      return out.toDataURL("image/webp", 0.75);
    } catch {
      return null;
    }
  }

  /** The skeleton turned as `pose` for `run`, then back as it was. */
  private withPose(pose: Pose, run: () => void) {
    const saved = new Map<JointName, THREE.Euler>();
    for (const [name, bone] of this.bones) {
      saved.set(name, bone.rotation.clone());
      bone.rotation.set(pose[name][0], pose[name][1], pose[name][2]);
    }
    this.body?.tipperNode().updateWorldMatrix(true, true);
    run();
    for (const [name, bone] of this.bones) bone.rotation.copy(saved.get(name)!);
    this.body?.tipperNode().updateWorldMatrix(true, true);
  }

  /** The skeleton and the body as this pose stands, world positions fresh. */
  private settle() {
    if (!this.body) return;
    for (const name of JOINTS) this.bones.get(name)?.rotation.set(this.pose[name][0], this.pose[name][1], this.pose[name][2]);
    this.body.apply(this.pose, this.time);
    this.body.root.updateWorldMatrix(true, true);
  }

  private readonly at = (name: JointName) => this.bones.get(name)!.getWorldPosition(new THREE.Vector3());

  /**
   * The body the camera sees: hips, chest and head turned as the person's, each limb pointing the way theirs does
   * (legs stand when the camera does not see them). Says the pose it made.
   */
  follow(tracked: Tracked): Pose | null {
    if (!this.body || tracked.seen === "none") return null;
    const pose = { ...this.pose };
    for (const name of JOINTS) pose[name] = [0, 0, 0];
    pose.y = 0;
    this.pose = pose;
    this.settle();
    const worldOf = (name: JointName) => this.bones.get(name)!.getWorldQuaternion(new THREE.Quaternion());
    const parentOf = (name: JointName) => this.bones.get(name)!.parent!.getWorldQuaternion(new THREE.Quaternion());
    const setLocal = (name: JointName, world: THREE.Quaternion) => {
      const bone = this.bones.get(name)!;
      bone.quaternion.copy(parentOf(name).invert().multiply(world));
      bone.updateWorldMatrix(false, true);
      pose[name] = [bone.rotation.x, bone.rotation.y, bone.rotation.z];
    };
    const facing = this.body.tipperNode().getWorldQuaternion(new THREE.Quaternion());
    const inWorld = (v: THREE.Vector3) => v.clone().applyQuaternion(facing);
    if (tracked.hips) setLocal("hips", facing.clone().multiply(turnFromLeftUp(tracked.hips.left, tracked.hips.up)));
    if (tracked.chest) {
      const chest = facing.clone().multiply(turnFromLeftUp(tracked.chest.left, tracked.chest.up));
      // The spine takes half of the chest's turn from the hips, the chest the rest.
      const hips = worldOf("hips");
      setLocal("spine", hips.clone().slerp(chest, 0.5));
      setLocal("chest", chest);
    }
    const aim = (upperName: JointName, lowerName: JointName, tipName: JointName, upperDir: THREE.Vector3 | null, lowerDir: THREE.Vector3 | null) => {
      const upper = this.bones.get(upperName)!;
      const lower = this.bones.get(lowerName)!;
      const tip = this.bones.get(tipName)!;
      if (upperDir) {
        upper.quaternion.copy(aimLocal(parentOf(upperName), upper.quaternion, lower.position, inWorld(upperDir)));
        upper.updateWorldMatrix(false, true);
        pose[upperName] = [upper.rotation.x, upper.rotation.y, upper.rotation.z];
      }
      if (lowerDir) {
        lower.quaternion.copy(aimLocal(worldOf(upperName), lower.quaternion, tip.position, inWorld(lowerDir)));
        lower.updateWorldMatrix(false, true);
        pose[lowerName] = [lower.rotation.x, lower.rotation.y, lower.rotation.z];
      }
    };
    aim("armL", "foreL", "handL", tracked.upper.L, tracked.fore.L);
    aim("armR", "foreR", "handR", tracked.upper.R, tracked.fore.R);
    aim("legL", "shinL", "footL", tracked.thigh.L, tracked.shin.L);
    aim("legR", "shinR", "footR", tracked.thigh.R, tracked.shin.R);
    if (tracked.head) setLocal("head", facing.clone().multiply(turnFromLeftForward(tracked.head.left, tracked.head.forward)));
    return pose;
  }

  /** A ready pose: the arms hang down, then the hands reach their places. Says the pose it made. */
  reachPose(ready: ReachPose): Pose | null {
    if (!this.body) return null;
    this.pose = { ...this.pose };
    for (const name of JOINTS) this.pose[name] = [...this.pose[name]] as Joint;
    for (const name of ["armL", "foreL", "handL", "armR", "foreR", "handR"] as const) this.pose[name] = [0, 0, 0];
    this.settle();
    const turn = this.body.tipperNode().getWorldQuaternion(new THREE.Quaternion());
    const arm = (side: "L" | "R") => this.bones.get(side === "L" ? "foreL" : "foreR")!.position.length() + this.bones.get(side === "L" ? "handL" : "handR")!.position.length();
    for (const { part, from, offset, pole } of ready) {
      const length = arm(part === "handL" ? "L" : "R");
      const target = this.at(from).add(new THREE.Vector3(...offset).multiplyScalar(length).applyQuaternion(turn));
      this.reach(part, target, new THREE.Vector3(...pole).normalize().applyQuaternion(turn));
    }
    return this.pose;
  }

  /** Two bones reaching for `target`: the elbow or the knee bends the way it did, or the natural way when straight. */
  private reach(end: keyof typeof LIMB, target: THREE.Vector3, poleWanted?: THREE.Vector3) {
    const [upperName, lowerName] = LIMB[end];
    const upper = this.bones.get(upperName)!;
    const lower = this.bones.get(lowerName)!;
    const tip = this.bones.get(end)!;
    const root = this.at(upperName);
    const bodyTurn = this.body!.tipperNode().getWorldQuaternion(new THREE.Quaternion());
    const pole = poleWanted ?? this.at(lowerName).sub(root).normalize().addScaledVector(POLE[end].clone().applyQuaternion(bodyTurn), 0.35);
    const { mid, end: reached } = twoBone(root, lower.position.length(), tip.position.length(), target, pole);
    upper.quaternion.copy(aimLocal(upper.parent!.getWorldQuaternion(new THREE.Quaternion()), upper.quaternion, lower.position, mid.clone().sub(root)));
    upper.updateWorldMatrix(false, true);
    lower.quaternion.copy(aimLocal(upper.getWorldQuaternion(new THREE.Quaternion()), lower.quaternion, tip.position, reached.clone().sub(mid)));
    lower.updateWorldMatrix(false, true);
    this.pose[upperName] = [upper.rotation.x, upper.rotation.y, upper.rotation.z];
    this.pose[lowerName] = [lower.rotation.x, lower.rotation.y, lower.rotation.z];
  }

  private pullTo(target: THREE.Vector3) {
    const pull = this.pulling;
    if (!pull || !this.body) return;
    this.pose = { ...this.pose };
    for (const name of JOINTS) this.pose[name] = [...this.pose[name]] as Joint;
    this.settle();
    if (pull.part === "head") {
      // The head looks where the pointer goes: a point in front of it, moved twice as far as the pointer.
      const head = this.bones.get("head")!;
      const look = pull.look.clone().addScaledVector(target.clone().sub(pull.from), 2);
      head.quaternion.copy(aimLocal(head.parent!.getWorldQuaternion(new THREE.Quaternion()), head.quaternion, FORWARD, look.sub(this.at("head"))));
      this.pose.head = [head.rotation.x, head.rotation.y, head.rotation.z];
    } else if (pull.part === "hips") {
      // Up and down: crouching, the feet staying where they stood.
      this.pose.y = Math.max(-0.6, Math.min(0.25, pull.y + (target.y - pull.from.y)));
      this.settle();
      this.reach("footL", pull.feet[0]);
      this.reach("footR", pull.feet[1]);
    } else {
      this.reach(pull.part, target);
    }
    this.onPull(this.pose);
  }

  /** Where a joint of the pose shown is on the canvas, in CSS pixels: for labels over the body. Null without a body. */
  screenOf(joint: JointName): { x: number; y: number } | null {
    if (!this.body || !this.bones.has(joint)) return null;
    this.settle();
    const p = this.at(joint).project(this.camera);
    if (p.z > 1) return null;
    return { x: ((p.x + 1) / 2) * this.canvas.clientWidth, y: ((1 - p.y) / 2) * this.canvas.clientHeight };
  }

  choose(joint: JointName | null) {
    this.chosen = joint;
    for (const [name, handle] of this.handles) handle.material = name === joint ? this.chosenMaterial : this.handleMaterial;
    if (joint && this.bones.has(joint) && this.mode === "turn") this.rings.attach(this.bones.get(joint)!);
    else this.rings.detach();
  }

  /** The pose to show. While a hand is on the rings or pulling, the hand decides. */
  setPose(pose: Pose) {
    if (this.pulling) return;
    if (this.dragging) {
      const chosen = this.chosen;
      if (chosen) pose[chosen] = this.pose[chosen];
    }
    this.pose = pose;
  }

  private readonly tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    this.time = now / 1000;
    this.orbit.update();
    if (this.body) {
      for (const name of JOINTS) {
        const bone = this.bones.get(name);
        if (bone && !(this.dragging && name === this.chosen)) bone.rotation.set(this.pose[name][0], this.pose[name][1], this.pose[name][2]);
      }
      this.body.apply(this.pose, this.time);
      this.body.root.position.set(this.pose.x, 0, this.pose.z);
    }
    this.renderer.render(this.scene, this.camera);
  };

  private ray(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    return this.raycaster.ray;
  }

  private readonly onDown = (event: PointerEvent) => {
    this.downAt = { x: event.clientX, y: event.clientY };
    if (this.mode !== "pull" || !this.showHandles || !this.body) return;
    const ray = this.ray(event);
    let best: PullPart | null = null;
    let bestDistance = 0.07;
    for (const part of PULL_PARTS) {
      const distance = ray.distanceToPoint(this.at(part));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = part;
      }
    }
    if (!best) return;
    const from = this.at(best);
    const facing = this.camera.getWorldDirection(new THREE.Vector3());
    const bodyTurn = this.body.tipperNode().getWorldQuaternion(new THREE.Quaternion());
    this.pulling = {
      part: best,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(facing, from),
      from,
      y: this.pose.y,
      feet: [this.at("footL"), this.at("footR")],
      look: this.at("head").add(FORWARD.clone().applyQuaternion(bodyTurn).multiplyScalar(0.6)),
    };
    this.orbit.enabled = false;
    this.canvas.setPointerCapture(event.pointerId);
    this.choose(best);
    this.onChoose(best);
  };

  private readonly onMove = (event: PointerEvent) => {
    if (!this.pulling) return;
    const point = this.ray(event).intersectPlane(this.pulling.plane, new THREE.Vector3());
    if (point) this.pullTo(point);
  };

  /** A click, not a walk around: chooses the handle under the pointer, or nothing. */
  private readonly onUp = (event: PointerEvent) => {
    const from = this.downAt;
    this.downAt = null;
    if (this.pulling) {
      this.pulling = null;
      this.orbit.enabled = true;
      this.onTurnEnd();
      return;
    }
    if (this.mode === "pull") return;
    if (!from || this.dragging || this.rings.axis || Math.hypot(event.clientX - from.x, event.clientY - from.y) > 5) return;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    // Handles are small: anything near the ray counts, the nearest to it wins.
    let best: JointName | null = null;
    let bestDistance = 0.05;
    const point = new THREE.Vector3();
    for (const [name, handle] of this.handles) {
      handle.getWorldPosition(point);
      const distance = this.raycaster.ray.distanceToPoint(point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = name;
      }
    }
    this.choose(best);
    this.onChoose(best);
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.setGhost(null);
    this.ghostMaterial.dispose();
    this.rings.detach();
    this.rings.dispose();
    this.orbit.dispose();
    this.body?.dispose();
    this.handleGeometry.dispose();
    this.environment.dispose();
    this.renderer.dispose();
  }
}
