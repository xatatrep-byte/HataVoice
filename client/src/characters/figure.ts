import * as THREE from "three";
import type { Character } from "./character";
import type { JointName, Pose } from "./motion";
import {
  backpackShape,
  beardShape,
  BUILDS,
  capeShape,
  earShape,
  fistShape,
  glassesShape,
  hairShape,
  handShape,
  hatShape,
  headShape,
  limb,
  neckShape,
  noseShape,
  pelvisShape,
  scarfShape,
  shadesShape,
  shoeShape,
  soleShape,
  tailShape,
  torsoShape,
} from "./shapes";

/** How far a hat rises over the head, in the head's radii: the name goes above it. */
const HAT_HEIGHT: Record<Character["hat"], number> = {
  none: 1.12,
  cap: 1.26,
  beanie: 1.76,
  crown: 1.7,
  cowboy: 1.66,
  horns: 1.6,
  bunny: 2.4,
  cat: 1.5,
  headphones: 1.26,
};

const HAIR_HEIGHT: Partial<Record<Character["hair"], number>> = { spiky: 1.62, mohawk: 1.62, bun: 1.62, curly: 1.34 };

const sphereGeometry = new THREE.SphereGeometry(1, 20, 14);
const domeGeometry = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
/** The arc of a closed mouth: a smile from corner to corner. */
const smileGeometry = new THREE.TorusGeometry(1, 0.11, 8, 18, Math.PI * 0.72);
smileGeometry.rotateZ(-Math.PI * 0.86);
smileGeometry.translate(0, 1, 0);
/** Eyes squeezed shut in a laugh. */
const happyGeometry = new THREE.TorusGeometry(1, 0.18, 8, 16, Math.PI * 0.8);
happyGeometry.rotateZ(Math.PI * 0.1);

const darker = (hex: string, by: number) => new THREE.Color(hex).multiplyScalar(by);
const mix = (a: string, b: string, k: number) => new THREE.Color(a).lerp(new THREE.Color(b), k);

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = shadow;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}

/** A small swinging thing (a ponytail, an ear): it follows its parent with a lag, and overshoots. */
class Swing {
  private angle = 0;
  private speed = 0;
  private lastX = 0;
  constructor(
    readonly pivot: THREE.Object3D,
    private readonly stiffness: number,
    private readonly damping: number,
    private readonly rest: number,
    private readonly gain: number,
    private readonly axis: "x" | "z",
  ) {}
  update(dt: number, push: number) {
    const force = -this.stiffness * this.angle - this.damping * this.speed + (push - this.lastX) * this.gain;
    this.lastX = push;
    this.speed += force * dt;
    this.angle += this.speed * dt;
    this.angle = Math.max(-0.9, Math.min(0.9, this.angle));
    this.pivot.rotation[this.axis] = this.rest + this.angle;
  }
}

/** A figure on the stage: its joints, its face, and how a pose moves them. */
export class Figure {
  readonly root = new THREE.Group();
  private readonly joints = {} as Record<JointName, THREE.Object3D>;
  private readonly tipper = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly standing: number;
  /** The height of the top of the head, for what floats above it. */
  readonly height: number;
  /** How far the body reaches from its middle (a drawn figure is a slim one). */
  readonly radius = 0.26;
  /** Where the right hand is in the figure, for what it throws. */
  readonly hand = new THREE.Object3D();
  private readonly headPoint = new THREE.Object3D();
  private handL!: THREE.Mesh;
  private handR!: THREE.Mesh;
  private readonly lids: THREE.Mesh[] = [];
  private readonly eyeballs: THREE.Group[] = [];
  private readonly irises: THREE.Group[] = [];
  private readonly happyArcs: THREE.Mesh[] = [];
  private readonly brows: THREE.Mesh[] = [];
  private readonly smileLine: THREE.Mesh;
  private readonly mouthInside: THREE.Group;
  private readonly blush: THREE.MeshBasicMaterial;
  private readonly swings: Swing[] = [];
  private lastTime = 0;

  constructor(readonly character: Character) {
    const c = character;
    const b = BUILDS[c.body];
    const material = (color: THREE.ColorRepresentation, roughness: number, metalness = 0) => {
      const made = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      this.materials.push(made);
      return made;
    };
    const skin = material(c.skin, 0.58);
    const hair = material(c.hairColor, 0.62);
    const top = material(c.outfit, 0.78);
    const sleeve = c.top === "suit" ? top : c.top === "tee" ? skin : top;
    const bottom = c.top === "dress" ? top : material(c.bottom, 0.82);
    const shoe = material(mix(c.bottom, "#f4f1ea", 0.82), 0.6);
    const sole = material("#2b2a2c", 0.8);
    const ink = material("#17151a", 0.25);
    const white = material("#fbfaf6", 0.35);

    const hipHeight = b.thigh + b.shin + 0.05;
    this.standing = hipHeight;

    const joint = (name: JointName, parent: THREE.Object3D, x: number, y: number, z: number) => {
      const j = new THREE.Group();
      j.position.set(x, y, z);
      j.rotation.order = "YXZ";
      parent.add(j);
      this.joints[name] = j;
      return j;
    };

    // The figure tips over around its middle (flips, push-ups).
    this.tipper.position.y = hipHeight;
    this.root.add(this.tipper);

    const hips = joint("hips", this.tipper, 0, 0, 0);
    const spine = joint("spine", hips, 0, 0.02, 0);
    const chest = joint("chest", spine, 0, b.torso * 0.36, 0);

    mesh(pelvisShape(c.body), bottom, hips);
    const torso = mesh(torsoShape(c.body, c.top), top, chest);
    torso.position.y = -b.torso * 0.36;

    if (c.top === "suit") {
      // A shirt and a tie down the front.
      const shirt = mesh(sphereGeometry, material("#f2efe8", 0.7), chest, false);
      shirt.scale.set(b.waist * 0.32, b.torso * 0.32, 0.02);
      shirt.position.set(0, b.torso * 0.26, b.depth * 0.86);
      const tie = mesh(sphereGeometry, material(mix(c.outfit, "#b0342a", 0.6), 0.6), chest, false);
      tie.scale.set(0.022, b.torso * 0.22, 0.016);
      tie.position.set(0, b.torso * 0.28, b.depth * 0.94);
    }
    if (c.top === "hoodie") {
      // Cords, and a pocket across the belly.
      const pocket = mesh(sphereGeometry, material(darker(c.outfit, 0.9), 0.85), chest, false);
      pocket.scale.set(b.waist * 0.6, b.torso * 0.085, 0.018);
      pocket.position.set(0, -b.torso * 0.14, b.depth * 0.98);
      for (const side of [-1, 1]) {
        const cord = mesh(limb(b.torso * 0.14, 0.006, 0.006), white, chest, false);
        cord.position.set(side * 0.03, b.torso * 0.5, b.depth * 0.86);
      }
    }

    const neckY = b.torso * 0.56;
    const neck = joint("neck", chest, 0, neckY, -0.005);
    const collar = mesh(neckShape(b.limb * 0.78), skin, neck, false);
    collar.position.y = 0.05;
    const headJoint = joint("head", neck, 0, 0.03, 0);
    const head = new THREE.Group();
    head.position.y = b.head * 0.86;
    head.scale.setScalar(b.head);
    headJoint.add(head);
    this.headPoint.position.set(0, 0.2, 0);
    head.add(this.headPoint);

    mesh(headShape(), skin, head);
    const nose = mesh(noseShape(), material(darker(c.skin, 0.9), 0.55), head, false);
    nose.position.set(0, -0.16, 0.95);
    const blush = new THREE.MeshBasicMaterial({ color: mix(c.skin, "#ff5470", 0.7), transparent: true, opacity: 0.2, depthWrite: false });
    this.materials.push(blush);
    this.blush = blush;
    for (const side of [-1, 1]) {
      const cheek = mesh(sphereGeometry, blush, head, false);
      cheek.scale.set(0.17, 0.11, 0.06);
      cheek.position.set(side * 0.58, -0.28, 0.76);
      cheek.rotation.y = side * 0.65;
    }

    // Eyes: a white, an iris that looks around, a highlight; a lid in the colour of the skin.
    const small = c.eyes === "dots" || c.eyes === "sleepy";
    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(side * 0.37, 0.03, 0.81);
      eye.rotation.y = side * 0.32;
      eye.scale.set(1, 1.1, 0.52);
      head.add(eye);
      this.eyeballs.push(eye);
      const iris = new THREE.Group();
      eye.add(iris);
      this.irises.push(iris);
      if (small) {
        const pupil = mesh(sphereGeometry, ink, iris, false);
        pupil.scale.setScalar(0.16);
        pupil.position.z = 0.03;
        const shine = mesh(sphereGeometry, white, iris, false);
        shine.scale.setScalar(0.048);
        shine.position.set(0.055, 0.065, 0.17);
      } else {
        const ball = mesh(sphereGeometry, white, eye, false);
        ball.scale.setScalar(0.22);
        const ring = mesh(sphereGeometry, material(darker(c.hairColor, 0.8).lerp(new THREE.Color("#4d3a2a"), 0.5), 0.3), iris, false);
        ring.scale.set(0.15, 0.15, 0.1);
        ring.position.z = 0.15;
        const pupil = mesh(sphereGeometry, ink, iris, false);
        pupil.scale.set(0.095, 0.095, 0.05);
        pupil.position.z = 0.215;
        const shine = mesh(sphereGeometry, white, iris, false);
        shine.scale.setScalar(0.042);
        shine.position.set(0.05, 0.06, 0.25);
      }
      const lid = mesh(domeGeometry, skin, eye, false);
      lid.scale.setScalar(small ? 0.215 : 0.245);
      this.lids.push(lid);
      const arc = mesh(happyGeometry, ink, head, false);
      arc.scale.setScalar(0.13);
      arc.position.set(side * 0.37, -0.02, 0.92);
      arc.rotation.y = side * 0.32;
      arc.visible = false;
      this.happyArcs.push(arc);
      const brow = mesh(limb(0.2, 0.034, 0.03), hair, head, false);
      brow.rotation.z = -Math.PI / 2;
      const browPivot = new THREE.Group();
      browPivot.position.set(side * 0.37, 0.35, 0.9);
      browPivot.rotation.y = side * 0.32;
      head.add(browPivot);
      brow.position.set(-0.1, 0, 0);
      browPivot.add(brow);
      this.brows.push(brow);
    }

    // The mouth: a line when closed, a real one when open.
    const mouthAt = new THREE.Group();
    mouthAt.position.set(0, -0.48, 0.815);
    mouthAt.rotation.x = 0.28;
    head.add(mouthAt);
    this.smileLine = mesh(smileGeometry, ink, mouthAt, false);
    this.smileLine.position.z = 0.06;
    this.mouthInside = new THREE.Group();
    mouthAt.add(this.mouthInside);
    const inside = mesh(sphereGeometry, material("#3d1219", 0.8), this.mouthInside, false);
    inside.scale.set(1, 1, 0.3);
    const tongue = mesh(sphereGeometry, material("#d8606e", 0.6), this.mouthInside, false);
    tongue.scale.set(0.68, 0.46, 0.2);
    tongue.position.set(0, -0.5, 0.16);
    const teeth = mesh(sphereGeometry, white, this.mouthInside, false);
    teeth.scale.set(0.74, 0.24, 0.18);
    teeth.position.set(0, 0.62, 0.15);

    if (c.hair !== "none") {
      mesh(hairShape(c.hair), hair, head);
      if (c.hair === "ponytail") {
        const pivot = new THREE.Group();
        pivot.position.set(0, 0.42, -1.1);
        head.add(pivot);
        mesh(tailShape(), hair, pivot);
        this.swings.push(new Swing(pivot, 26, 4, -0.2, 18, "x"));
      }
    }

    const accent = material(mix(c.outfit, "#ffffff", 0.12), 0.7);
    switch (c.hat) {
      case "none":
        break;
      case "bunny":
        for (const side of [-1, 1]) {
          const pivot = new THREE.Group();
          pivot.position.set(side * 0.4, 0.82, -0.08);
          pivot.rotation.z = -side * 0.14;
          head.add(pivot);
          const ear = mesh(earShape(), material("#f3efe8", 0.8), pivot);
          const inner = mesh(earShape(), material("#f0b6c0", 0.8), pivot, false);
          inner.scale.set(0.6, 0.86, 0.5);
          inner.position.set(0, 0.08, 0.1);
          ear.castShadow = true;
          this.swings.push(new Swing(pivot, 22, 2.8, -side * 0.14, side * 10, "z"));
        }
        break;
      default: {
        const hatMain = c.hat === "crown" ? material("#e0b23c", 0.28, 1) : c.hat === "horns" ? material("#d8d2c4", 0.45) : c.hat === "cowboy" ? material("#8b5a33", 0.75) : c.hat === "cat" ? material(c.hairColor, 0.7) : c.hat === "headphones" ? material("#1d1d21", 0.3, 0.3) : accent;
        const main = hatShape(c.hat, "main");
        if (main) mesh(main, hatMain, head);
        const second = hatShape(c.hat, "accent");
        if (second) {
          const secondMaterial = c.hat === "cowboy" ? material("#7e502c", 0.75) : c.hat === "beanie" ? material(mix(c.outfit, "#ffffff", 0.45), 0.8) : c.hat === "cat" ? material("#f0b6c0", 0.8) : c.hat === "headphones" ? material(c.outfit, 0.5) : material(darker(c.outfit, 0.8), 0.7);
          mesh(second, secondMaterial, head);
        }
      }
    }

    if (c.eyes === "cool") mesh(shadesShape(), material("#101014", 0.12, 0.5), head, false);
    if (c.extra === "glasses" && c.eyes !== "cool") mesh(glassesShape(), material("#22222a", 0.3, 0.2), head, false);
    if (c.extra === "beard") mesh(beardShape(), hair, head, false);
    if (c.extra === "scarf") {
      const scarf = mesh(scarfShape(b.limb * 1.5), material(mix(c.outfit, "#c64632", 0.6), 0.9), chest);
      scarf.position.y = neckY + 0.015;
    }
    if (c.extra === "backpack") {
      const bag = mesh(backpackShape(), material(darker(c.outfit, 0.55), 0.8), chest);
      bag.position.set(0, -b.torso * 0.04, -b.depth * 0.86);
    }
    if (c.extra === "cape") {
      const pivot = new THREE.Group();
      pivot.position.set(0, neckY - 0.01, -b.depth * 0.8);
      chest.add(pivot);
      const capeMaterial = new THREE.MeshStandardMaterial({ color: mix(c.outfit, "#a81f2e", 0.72), roughness: 0.65, side: THREE.DoubleSide });
      this.materials.push(capeMaterial);
      mesh(capeShape(b.shoulders * 0.82, hipHeight + b.torso * 0.5), capeMaterial, pivot);
      this.swings.push(new Swing(pivot, 16, 3.4, 0.1, 9, "x"));
    }

    // Arms: a ball of the shoulder, two tubes with round ends, a hand.
    for (const [name, sign] of [["L", 1], ["R", -1]] as const) {
      const shoulder = joint(`arm${name}`, chest, sign * b.shoulders * 0.92, b.torso * 0.44, 0);
      mesh(limb(b.armUpper, b.limb * 0.98, b.limb * 0.84), c.top === "dress" ? skin : c.top === "tee" ? top : sleeve, shoulder);
      const fore = joint(`fore${name}`, shoulder, 0, -b.armUpper, 0);
      mesh(limb(b.armLower, b.limb * 0.84, b.limb * 0.72), c.top === "tee" || c.top === "dress" ? skin : sleeve, fore);
      if (c.top === "hoodie" || c.top === "suit") {
        const cuff = mesh(limb(0.012, b.limb * 0.8, b.limb * 0.8), material(darker(c.outfit, c.top === "suit" ? 1.8 : 0.78), 0.8), fore, false);
        cuff.position.y = -b.armLower + 0.002;
      }
      const hand = joint(`hand${name}`, fore, 0, -b.armLower - b.limb * 0.42, 0);
      const open = mesh(handShape(), skin, hand);
      open.scale.set(sign * 1.1, 1.1, 1.1);
      if (name === "L") this.handL = open;
      else {
        this.handR = open;
        hand.add(this.hand);
      }
      const fist = mesh(fistShape(), skin, hand);
      fist.scale.set(sign * 1.1, 1.1, 1.1);
      fist.visible = false;
      open.userData.fist = fist;
    }

    // Legs: thigh, shin, a shoe with a sole.
    for (const [name, sign] of [["L", 1], ["R", -1]] as const) {
      const leg = joint(`leg${name}`, hips, sign * b.waist * 0.5, -0.03, 0);
      const trouser = c.top === "dress" ? skin : bottom;
      mesh(limb(b.thigh, b.limb * 1.08, b.limb * 1.0), trouser, leg);
      const shin = joint(`shin${name}`, leg, 0, -b.thigh, 0);
      mesh(limb(b.shin, b.limb * 1.0, b.limb * 0.8), trouser, shin);
      const foot = joint(`foot${name}`, shin, 0, -b.shin, 0);
      const upper = mesh(shoeShape(), shoe, foot);
      upper.position.y = -0.02;
      const bottomOfShoe = mesh(soleShape(), sole, foot);
      bottomOfShoe.position.y = -0.02;
    }

    const topOfHead = Math.max(HAT_HEIGHT[c.hat], HAIR_HEIGHT[c.hair] ?? 1.12);
    this.height = hipHeight + b.torso * 0.36 + neckY + 0.03 + b.head * 0.86 + b.head * topOfHead;
  }

  /** Puts a pose on the joints. `time` (seconds) moves what swings by itself. */
  apply(pose: Pose, time = 0) {
    for (const name in this.joints) {
      const joint = this.joints[name as JointName];
      const [x, y, z] = pose[name as JointName];
      joint.rotation.set(x, y, z);
    }
    this.root.rotation.y = pose.turn;
    this.tipper.position.y = this.standing + pose.y;
    this.tipper.rotation.x = -pose.roll;

    (this.handL.userData.fist as THREE.Mesh).visible = pose.fistL;
    this.handL.visible = !pose.fistL;
    (this.handR.userData.fist as THREE.Mesh).visible = pose.fistR;
    this.handR.visible = !pose.fistR;

    const happy = pose.happy > 0.55 && this.character.eyes !== "cool";
    const closed = Math.max(pose.eyes, this.character.eyes === "sleepy" ? 0.5 : 0);
    // −π/2: the lid behind the eye; +π/2: over it.
    const lid = -Math.PI / 2 + closed * Math.PI * 0.98;
    this.lids.forEach((l, i) => {
      l.rotation.x = happy ? 1.5 : lid;
      l.rotation.z = (i === 0 ? -1 : 1) * pose.browSlant * 0.28;
    });
    this.eyeballs.forEach((e) => (e.visible = !happy));
    this.happyArcs.forEach((a) => (a.visible = happy));
    this.irises.forEach((iris) => iris.position.set(pose.lookX * 0.06, pose.lookY * 0.05, 0));
    this.brows.forEach((brow, i) => {
      const side = i === 0 ? -1 : 1;
      const pivot = brow.parent!;
      pivot.position.y = 0.35 + pose.brow * 0.09;
      pivot.rotation.z = side * pose.browSlant * -0.42;
    });

    const open = pose.mouth > 0.03;
    this.smileLine.visible = !open;
    this.mouthInside.visible = open;
    if (open) {
      const wide = 0.2 + 0.1 * pose.mouthWide + 0.04 * pose.smile;
      this.mouthInside.scale.set(wide, 0.03 + 0.28 * pose.mouth, 0.1);
    } else {
      const width = 0.2 + 0.05 * Math.abs(pose.smile) + 0.04 * pose.mouthWide;
      this.smileLine.scale.set(width * 0.92, Math.sign(pose.smile || 0.01) * Math.max(0.12, Math.abs(pose.smile)) * width, 0.16);
    }
    this.blush.opacity = 0.14 + 0.6 * pose.blush;

    const dt = Math.min(0.05, Math.max(0.001, time - this.lastTime));
    this.lastTime = time;
    for (const swing of this.swings) swing.update(dt, pose.x * 2 + pose.turn * 0.3 + pose.y * 2 + pose.head[1] * 0.35 + pose.head[0] * 0.3);
  }

  /** The joint itself, for the workshop's handles. */
  jointNode(name: JointName): THREE.Object3D {
    return this.joints[name];
  }

  /** What the whole figure tips over with. */
  tipperNode(): THREE.Object3D {
    return this.tipper;
  }

  /** Put somewhere else at once: a figure built in code has nothing that swings behind it. */
  jump() {}

  /** A drawn figure plays no recordings: it ignores what `apply`'s third argument would bring a model. */
  readonly recorded = false;

  handPosition(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    return this.hand.getWorldPosition(new THREE.Vector3());
  }

  headPosition(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    return this.headPoint.getWorldPosition(new THREE.Vector3());
  }

  /** The figure's shapes are shared with everyone who wears them: only its colors go. */
  dispose() {
    for (const material of this.materials) material.dispose();
  }
}
