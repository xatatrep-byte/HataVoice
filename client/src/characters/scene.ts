import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { characterCode, isInteraction, isMove, parseCharacter, parseMove, type Character } from "./character";
import { clipWeight, isClipAct, playClip, type Clip } from "./clip";
import { Figure } from "./figure";
import type { ModelFigure } from "./model";
import { actLength, flight, followVoice, JOINTS, meetDistance, poseAt, type ActNow, type JointName, type Pose, type VoiceFollow } from "./motion";
import { loadMotions, newFrame, type MotionFrame, type MotionLibrary } from "./mocap";
import type { MotionLayer } from "./model";
import { actMotion, baseMotion, drawnLegs } from "./motionPlan";
import { buildRoom, softSpot, type Room, type StageLook } from "./room";
import { setStageWalks } from "./stageWalks";
import { DEFAULT_RADIUS, DESK_MAX_STEP_S, DESK_WALK_SCALE, deskStroll, deskWalkTarget, frameStep, freeSpot, GAP, separate, spreadOnDesk, strollPlan, wallTime, type Disc } from "./spacing";

/** What stands on the stage: a figure from code, or a model from a file. */
type Body = Figure | ModelFigure;

/** Someone on the stage. */
export type SceneMember = {
  id: string;
  name: string;
  /** Built in code: what is shown while a model loads, or if it does not. */
  character: Character;
  /** A model: `m1.…` or `p1.…` from the profile (see `gallery.ts`). */
  avatar?: string;
  /** The server that keeps a model of one's own. */
  source?: string;
  /** The voice now, 0–1. */
  level: number;
  speaking: boolean;
  /** Us: our figure can be dragged around. */
  local?: boolean;
};

/** An act someone began, on this PC's clock (`performance.now()`, ms). */
export type SceneAct = { key: number; user: string; act: string; to: string | null; startedAt: number };

/**
 * An act as this stage plays it. One done to someone a step away begins with a walk: the one who does it goes up to the
 * other with real steps (the act starts once there, `startedAt` moves), and walks back to where it stood after.
 */
type StagedAct = SceneAct & {
  /** Walked up to the other one: the act itself neither walks nor turns. */
  met?: boolean;
  /** It began with a walk there (and so ends with one back). */
  walks?: boolean;
  /** Sent back home already. */
  back?: boolean;
};

export type SceneOptions = {
  /** No background of its own: what is under the canvas shows through (the window over other apps). */
  transparent?: boolean;
  /**
   * The characters on the desktop: the canvas is the whole screen, seen straight from the front, and each one stands
   * where it was put ([`setDesk`]). No floor and no shadows: it has to stay light over a game.
   */
  desk?: boolean;
  /** One figure, close, turning to show itself (the character creator). */
  preview?: boolean;
  /** Frames a second at most. */
  fps?: number;
  /** The color of the light under one who speaks, and of the stage's glow. */
  accent?: string;
  /** Someone's figure was clicked, at these window coordinates. */
  onPick?: (id: string, x: number, y: number) => void;
  /** Our figure was dragged to a new place on the floor. */
  onMoved?: (x: number, z: number) => void;
  /**
   * The call's stage: it tells where each one walks (`stageWalks`), and keeps their strolls going while it draws nothing
   * (a screen in front, the window minimized), so that the desktop walks as it does.
   */
  feedWalks?: boolean;
  /** On the desktop: someone's figure was carried to a new place (feet, parts of the screen's width and height). */
  onPlaced?: (id: string, spot: [number, number]) => void;
  /** Motions of our own, not yet in a pack (the settings' preview). */
  clips?: Clip[];
  /** Drawn by whoever owns it ([`renderAt`]), at the size it sets ([`setSize`]): in a worker, on an offscreen canvas. */
  manual?: boolean;
  /** Where a call's characters stand: «Ночь», «Студия» or «Закат». */
  look?: StageLook;
};

/** A canvas to draw on: a page's, or an offscreen one in a worker. */
function drawingCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document === "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const SPACING = 0.98;
/** How tall a character is taken to be on the desktop, metres: the screen's height is this over the chosen size. */
const DESK_HEIGHT = 1.75;
const ROW_GAP = 0.86;
const WALK_SPEED = 1.15;
/** A walk shorter than this before a pair act is not worth taking; one this near its spot is there. */
const WALK_FROM = 0.12;
const ARRIVED = 0.06;
/** Figures keep this far from each other when they choose where to stand. */
const ELBOW_ROOM = 0.72;
/** The floor they may stand on. */
const FLOOR = { x: 4.6, back: -1.5, front: 1.45 };
/** How far a body reaches past the point it stands on, for keeping it whole in the picture, m. */
const BODY_MARGIN = 0.45;

/**
 * The floor one may walk on in a picture this wide: no wider than the camera sees at the front edge (a phone held upright
 * sees under two metres, and a stroll or a walk to a friend took a character off the picture), never wider than the stage.
 */
export function visibleFloor(distance: number, horizontalHalfAngle: number): typeof FLOOR {
  const seen = Math.tan(horizontalHalfAngle) * Math.max(0, distance - FLOOR.front) - BODY_MARGIN;
  return { ...FLOOR, x: Math.max(0.6, Math.min(FLOOR.x, seen)) };
}

type Placed = {
  member: SceneMember;
  code: string;
  figure: Body;
  /** Motions from the workshop that came with the model. */
  clips: Map<string, Clip> | null;
  /** Where it was put, or was told to stand. */
  home: THREE.Vector3;
  /** Its place in the rows of the call's stage (also once moved by hand): a walk is measured from it for the desktop. */
  anchor: THREE.Vector3;
  /** Where it heads now, and where it is. */
  spot: THREE.Vector3;
  pos: THREE.Vector3;
  facing: number;
  distance: number;
  speed: number;
  /** The stroll it took last (`strollPlan`); NaN before the first. */
  strollSlot: number;
  /** Put on the call's floor by a person: it strolls no more. */
  stays: boolean;
  /** Put here by a person: it stays. */
  placedByHand: boolean;
  seed: number;
  /** The voice smoothed from frame to frame: the call reads it in steps. */
  voice: VoiceFollow;
  /** The light on the floor under one who speaks. */
  ring: THREE.Mesh | null;
  /** A model's motion capture this frame, and the joints a drawn act keeps for itself. */
  motion?: { frame: MotionFrame; scratch: MotionFrame; keep: Set<JointName> };
};

/** How far apart two turns of a joint are, radians: a drawn act keeps the joints it moves from the recording. */
const jointGap = (a: readonly number[], b: readonly number[]) => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
const ACT_KEEPS = 0.05;

/** How far a character's body reaches from its middle (a model measures it; a drawn figure is slim). */
function radiusOf(placed: { figure: { radius?: number } }): number {
  return placed.figure.radius ?? DEFAULT_RADIUS;
}

/** On the desktop a character keeps this far (metres) inside the screen's sides. */
const DESK_MARGIN = 0.35;
/** A gap between the window's frames longer than this, and a plain timer draws instead (see `deskTicker`). */
const DESK_TICK_GAP_MS = 250;

function seedOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 33 + ch.charCodeAt(0)) % 10007;
  return (h / 10007) * 10;
}

// ---------------------------------------------------------------------------------------------------- effects

type Mark = "heart" | "star" | "z" | "note" | "drop" | "puff" | "ask" | "ha" | "cream" | "spark" | "magic";

const markTextures = new Map<string, THREE.Texture>();

function markTexture(mark: Mark): THREE.Texture {
  let texture = markTextures.get(mark);
  if (texture) return texture;
  const canvas = drawingCanvas(96, 96);
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.textAlign = "center";
  g.textBaseline = "middle";
  switch (mark) {
    case "heart":
      g.fillStyle = "#ff5a7e";
      g.beginPath();
      g.moveTo(48, 82);
      g.bezierCurveTo(4, 50, 12, 12, 36, 14);
      g.bezierCurveTo(42, 14, 46, 18, 48, 24);
      g.bezierCurveTo(50, 18, 54, 14, 60, 14);
      g.bezierCurveTo(84, 12, 92, 50, 48, 82);
      g.fill();
      break;
    case "star":
    case "spark": {
      g.fillStyle = mark === "star" ? "#ffd65a" : "#fff5d0";
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? 42 : mark === "star" ? 17 : 8;
        g.lineTo(48 + Math.cos(a) * r, 48 + Math.sin(a) * r);
      }
      g.fill();
      break;
    }
    case "magic": {
      // A spell's light: a violet glow with a thin four-pointed twinkle in it.
      const glow = g.createRadialGradient(48, 48, 0, 48, 48, 46);
      glow.addColorStop(0, "rgba(236, 222, 255, 0.95)");
      glow.addColorStop(0.25, "rgba(186, 140, 255, 0.6)");
      glow.addColorStop(1, "rgba(150, 100, 255, 0)");
      g.fillStyle = glow;
      g.fillRect(0, 0, 96, 96);
      g.fillStyle = "#ffffff";
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? 44 : 6;
        g.lineTo(48 + Math.cos(a) * r, 48 + Math.sin(a) * r);
      }
      g.fill();
      break;
    }
    case "z":
      g.font = "700 72px 'Segoe UI', sans-serif";
      g.fillStyle = "#cfe0ff";
      g.fillText("z", 48, 50);
      break;
    case "note":
      g.font = "700 72px 'Segoe UI Symbol', 'Segoe UI', sans-serif";
      g.fillStyle = "#ffe08a";
      g.fillText("♪", 48, 50);
      break;
    case "ask":
      g.font = "700 72px 'Segoe UI', sans-serif";
      g.fillStyle = "#ffffff";
      g.fillText("?", 48, 50);
      break;
    case "ha":
      g.font = "800 46px 'Segoe UI', sans-serif";
      g.fillStyle = "#fff4c8";
      g.fillText("ха", 48, 50);
      break;
    case "drop":
      g.fillStyle = "#7cc4ff";
      g.beginPath();
      g.moveTo(48, 10);
      g.bezierCurveTo(78, 52, 74, 84, 48, 84);
      g.bezierCurveTo(22, 84, 18, 52, 48, 10);
      g.fill();
      break;
    case "puff":
      g.fillStyle = "rgba(240, 240, 240, 0.85)";
      for (const [x, y, r] of [[48, 54, 26], [28, 56, 18], [68, 56, 18], [40, 36, 18], [60, 38, 16]] as const) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
      break;
    case "cream":
      g.fillStyle = "#fffaf0";
      for (const [x, y, r] of [[48, 50, 30], [20, 40, 14], [76, 44, 15], [34, 74, 13], [66, 74, 12], [50, 18, 12]] as const) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
      break;
  }
  texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  markTextures.set(mark, texture);
  return texture;
}

/** What a mark does: where it starts, on whom, and how its life goes. All stateless: time gives its place. */
type Effect = {
  mark: Mark;
  count: number;
  on: "actor" | "target";
  /** From the head, or the hand. */
  from?: "head" | "hand" | "between";
  /** When in the act it begins and ends, 0–1. */
  start: number;
  end: number;
  size: number;
  /** Each mark's way, for life 0–1 of mark number i. */
  path: (i: number, life: number, n: number) => [number, number, number];
  /** Marks go one after another over the effect's time. */
  stagger?: number;
};

const rise = (spread: number, height: number) => (i: number, life: number): [number, number, number] => {
  const side = Math.sin(i * 12.9) * spread;
  return [side + Math.sin(life * 6 + i) * 0.05, life * height, Math.cos(i * 7.7) * spread * 0.4];
};
const burst = (radius: number) => (i: number, life: number, n: number): [number, number, number] => {
  const a = (i / n) * Math.PI * 2;
  const out = Math.sin(life * Math.PI * 0.5) * radius;
  return [Math.cos(a) * out, Math.sin(a) * out * 0.7 + 0.05, Math.sin(a * 3) * 0.1];
};
const fall = (i: number, life: number): [number, number, number] => {
  const side = i % 2 === 0 ? -1 : 1;
  return [side * (0.12 + life * 0.16), 0.02 + life * 0.08 - life * life * 0.72, 0.14 + Math.sin(i) * 0.03];
};
const circle = (i: number, life: number, n: number): [number, number, number] => {
  const a = (i / n) * Math.PI * 2 + life * 10;
  return [Math.cos(a) * 0.3, 0.2 + Math.sin(a * 2) * 0.03, Math.sin(a) * 0.3];
};

/** Round and round the point, a little flattened, as a ball of light held in the hands. */
const orbit = (radius: number) => (i: number, life: number, n: number): [number, number, number] => {
  const a = (i / n) * Math.PI * 2 + life * 9;
  return [Math.cos(a) * radius, Math.sin(a) * radius * 0.8, Math.sin(a * 2) * radius * 0.4];
};

const EFFECTS: Record<string, Effect[]> = {
  love: [{ mark: "heart", count: 9, on: "actor", start: 0.1, end: 1, size: 0.16, stagger: 0.7, path: rise(0.3, 0.8) }],
  sleep: [{ mark: "z", count: 6, on: "actor", start: 0.1, end: 1, size: 0.16, stagger: 0.75, path: (_i, l) => [0.16 + l * 0.32, l * 0.72, 0.06 + Math.sin(l * 5) * 0.03] }],
  cry: [{ mark: "drop", count: 18, on: "actor", start: 0.05, end: 1, size: 0.075, stagger: 0.85, path: fall }],
  angry: [{ mark: "puff", count: 10, on: "actor", start: 0.08, end: 1, size: 0.17, stagger: 0.8, path: (i, l) => [(i % 2 === 0 ? -1 : 1) * (0.2 + l * 0.34), 0.06 + l * 0.3, 0] }],
  laugh: [{ mark: "ha", count: 5, on: "actor", start: 0.08, end: 1, size: 0.2, stagger: 0.75, path: rise(0.42, 0.56) }],
  dance: [{ mark: "note", count: 8, on: "actor", start: 0.05, end: 1, size: 0.16, stagger: 0.8, path: rise(0.46, 0.72) }],
  guitar: [{ mark: "note", count: 9, on: "actor", from: "hand", start: 0.05, end: 1, size: 0.16, stagger: 0.8, path: rise(0.3, 0.86) }],
  dj: [{ mark: "note", count: 10, on: "actor", from: "hand", start: 0.06, end: 1, size: 0.15, stagger: 0.82, path: rise(0.36, 0.8) }],
  // The ball of light between the hands, the sparks round the hand raised over the head, the burst where it is thrown.
  spell: [
    { mark: "magic", count: 8, on: "actor", from: "hand", start: 0.04, end: 0.36, size: 0.07, stagger: 0.5, path: orbit(0.09) },
    { mark: "magic", count: 10, on: "actor", from: "hand", start: 0.34, end: 0.58, size: 0.06, stagger: 0.85, path: (i, l) => [Math.sin(i * 7) * 0.07, l * 0.2, Math.cos(i * 5) * 0.07] },
    { mark: "star", count: 10, on: "actor", from: "hand", start: 0.57, end: 0.86, size: 0.1, path: burst(0.5) },
    { mark: "magic", count: 14, on: "actor", from: "hand", start: 0.57, end: 0.92, size: 0.08, stagger: 0.35, path: burst(0.34) },
  ],
  clap: [{ mark: "spark", count: 12, on: "actor", from: "hand", start: 0.08, end: 0.95, size: 0.07, stagger: 0.88, path: burst(0.2) }],
  flex: [{ mark: "star", count: 6, on: "actor", from: "head", start: 0.2, end: 0.9, size: 0.1, stagger: 0.7, path: burst(0.5) }],
  think: [{ mark: "ask", count: 3, on: "actor", start: 0.15, end: 1, size: 0.17, stagger: 0.7, path: (i, l) => [0.24 + Math.sin(i * 2) * 0.1, 0.1 + l * 0.46, 0] }],
  shrug: [{ mark: "ask", count: 2, on: "actor", start: 0.2, end: 0.95, size: 0.15, stagger: 0.4, path: (i, l) => [(i === 0 ? -1 : 1) * 0.26, 0.06 + l * 0.3, 0] }],
  flip: [{ mark: "star", count: 7, on: "actor", from: "head", start: 0.74, end: 1, size: 0.09, path: burst(0.5) }],
  hug: [{ mark: "heart", count: 7, on: "target", start: 0.34, end: 0.84, size: 0.13, stagger: 0.7, path: rise(0.42, 0.6) }],
  highfive: [{ mark: "star", count: 10, on: "actor", from: "between", start: 0.46, end: 0.68, size: 0.11, path: burst(0.5) }],
  fistbump: [{ mark: "spark", count: 10, on: "actor", from: "between", start: 0.46, end: 0.62, size: 0.08, path: burst(0.34) }],
  pat: [{ mark: "heart", count: 5, on: "target", start: 0.34, end: 0.8, size: 0.1, stagger: 0.7, path: rise(0.3, 0.5) }],
  kiss: [{ mark: "heart", count: 8, on: "target", from: "between", start: 0.42, end: 0.86, size: 0.12, stagger: 0.5, path: rise(0.36, 0.74) }],
  heart: [{ mark: "heart", count: 7, on: "target", start: 0.6, end: 1, size: 0.13, stagger: 0.5, path: burst(0.42) }],
  snowball: [{ mark: "puff", count: 7, on: "target", start: 0.6, end: 0.82, size: 0.14, path: burst(0.34) }],
  pie: [
    { mark: "cream", count: 1, on: "target", start: 0.44, end: 0.98, size: 0.46, path: () => [0, -0.06, 0.2] },
    { mark: "spark", count: 8, on: "target", start: 0.44, end: 0.6, size: 0.1, path: burst(0.46) },
  ],
  dancewith: [{ mark: "note", count: 9, on: "actor", from: "between", start: 0.28, end: 0.9, size: 0.14, stagger: 0.75, path: rise(0.5, 0.8) }],
  tickle: [{ mark: "ha", count: 6, on: "target", start: 0.3, end: 0.8, size: 0.17, stagger: 0.7, path: rise(0.4, 0.5) }],
  bonk: [{ mark: "star", count: 4, on: "target", start: 0.48, end: 0.98, size: 0.1, path: circle }],
};

// ---------------------------------------------------------------------------------------------------- the stage

/**
 * The call's characters together in one room, drawn with WebGL. It throws when this PC cannot draw 3D; the caller shows
 * the usual tiles then.
 */
export class CharacterScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  /** The floor one may walk on in this picture (see `visibleFloor`). */
  private floor = FLOOR;
  private readonly placed = new Map<string, Placed>();
  private acts: StagedAct[] = [];
  private readonly marks = new Map<string, THREE.Sprite>();
  private readonly flying = new Map<number, THREE.Mesh>();
  private disposed = false;
  private frame = 0;
  private last = 0;
  private lastDraw = 0;
  /** When the browser last asked for a frame; on the desktop a timer draws when it stops asking. */
  private lastTick = 0;
  private deskTicker: ReturnType<typeof setInterval> | null = null;
  /** On the desktop: where each one walks on the call's stage, metres from its place there (see `stageWalks`). */
  private walks: Record<string, [number, number]> = {};
  /** Frames drawn since `rateFrom`: how smoothly the scene is really drawn (see `takeDrawRate`). */
  private drawsSince = 0;
  private rateFrom = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly accent: THREE.Color;
  private readonly room: Room | null;
  private readonly floorShadow: THREE.Mesh | null;
  private readonly environment: THREE.Texture | null;
  private readonly glow = softSpot();
  private focusX = 0;
  private cameraBase = new THREE.Vector3();
  private lookBase = new THREE.Vector3();
  private dragging: { id: string; startX: number; startY: number; moved: boolean; offset?: THREE.Vector3 } | null = null;
  /** A press on the empty floor: let go there without moving, and our character walks to it. */
  private floorPress: { x: number; y: number } | null = null;
  /** On the desktop: a camera with no perspective over the whole screen, and where each one stands. */
  private readonly ortho = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 50);
  private desk: { spots: Record<string, [number, number]>; size: number } = { spots: {}, size: 0.26 };
  /** Motions recorded on people: models stand, talk, walk and do many acts with them once they come. */
  private motions: MotionLibrary | null = null;
  /** Stools under those who sit: the recording of sitting was made on a chair. */
  private readonly stools = new Map<string, THREE.Group>();

  constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly options: SceneOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(options.manual || options.desk ? 1 : Math.min(globalThis.devicePixelRatio || 1, 1.5));
    // Keeps colors as they were chosen: a character's orange stays that orange.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    void loadMotions().then((library) => {
      if (!this.disposed) this.motions = library;
    });
    this.renderer.shadowMap.enabled = !options.desk;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.accent = new THREE.Color(options.accent ?? "#45e3a2");

    const inRoom = !options.transparent && !options.preview && !options.manual;
    this.room = inRoom ? buildRoom(this.accent, options.look ?? "night") : null;
    const lit = this.room?.light;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = lit ? lit.environment : 0.3;

    this.scene.add(lit ? new THREE.HemisphereLight(...lit.hemisphere) : new THREE.HemisphereLight(0xffffff, 0x7a7670, 1.0));
    const key = new THREE.DirectionalLight(lit ? lit.key[0] : 0xffffff, lit ? lit.key[1] : 1.7);
    key.position.set(...(lit ? lit.keyAt : ([-2.6, 5.4, 4.6] as [number, number, number])));
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -7;
    key.shadow.camera.right = 7;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -4;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 18;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = lit ? lit.shadowSoftness : 5;
    this.scene.add(key);
    // Light from behind, to draw the edges of hair and shoulders against the dark. Not on the desktop: over the
    // windows under them it reads as a white seam round the character.
    if (!options.desk) {
      const rim = new THREE.DirectionalLight(lit ? lit.rim[0] : 0xffffff, lit ? lit.rim[1] : 0.5);
      rim.position.set(...(lit ? lit.rimAt : ([-2.5, 3.2, -5] as [number, number, number])));
      this.scene.add(rim);
    }

    if (this.room && lit) {
      this.scene.add(this.room.group);
      this.scene.background = new THREE.Color(lit.background);
      this.scene.fog = new THREE.Fog(...lit.fog);
      // The accent from behind the other side: a studio's colored kicker.
      if (lit.kicker > 0) {
        const kicker = new THREE.DirectionalLight(this.accent, lit.kicker);
        kicker.position.set(3, 2.4, -4.5);
        this.scene.add(kicker);
      }
      this.floorShadow = null;
    } else if (options.desk) {
      this.floorShadow = null;
    } else {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.32 }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      this.scene.add(floor);
      this.floorShadow = floor;
    }

    if (options.manual) {
      this.setSize(canvas.width, canvas.height);
      return;
    }
    const element = canvas as HTMLCanvasElement;
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerCancel);
    // A finger on the stage is for the characters: the browser takes no pan of it, which on a phone cancelled the touch
    // (pointercancel, no pointerup) as soon as it moved a hair, and a friend's character could not be tapped.
    if (!options.preview && element.style) element.style.touchAction = "none";
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
    if (options.desk) {
      this.deskTicker = setInterval(() => {
        if (this.paused || this.disposed) return;
        const now = performance.now();
        if (now - this.lastTick > DESK_TICK_GAP_MS) this.drawCapped(now);
      }, 33);
    } else if (options.feedWalks) {
      // Drawing nothing (a screen in front, the window minimized): the strolls go on all the same, for the desktop.
      this.deskTicker = setInterval(() => {
        if (this.disposed) return;
        const now = performance.now();
        if (this.paused || now - this.lastTick > DESK_TICK_GAP_MS) this.strollOn(now);
      }, 250);
    }
  }

  /** On the desktop: where each one walks on the call's stage now. */
  setWalks(walks: Record<string, [number, number]>) {
    this.walks = walks;
  }

  /** The strolls of a stage that draws nothing: who heads where, told to the desktop. */
  private strollOn(time: number) {
    const wall = wallTime(performance.timeOrigin, time);
    for (const [id, placed] of this.placed) if (!this.actOf(id, time)) this.stroll(id, placed, wall);
    this.tellWalks();
  }

  /** The call's stage: where each one heads, measured from its place in the rows (see `stageWalks`). */
  private tellWalks() {
    if (!this.options.feedWalks) return;
    const walks = new Map<string, [number, number]>();
    for (const [id, placed] of this.placed) walks.set(id, [placed.spot.x - placed.anchor.x, placed.spot.z - placed.anchor.z]);
    setStageWalks(walks);
  }

  /** Frames drawn per second since the last ask: on the desktop, whether Windows lets the window draw smoothly. */
  takeDrawRate(now = performance.now()): number {
    const seconds = (now - this.rateFrom) / 1000;
    const rate = this.rateFrom > 0 && seconds > 0 ? this.drawsSince / seconds : 0;
    this.drawsSince = 0;
    this.rateFrom = now;
    return rate;
  }

  /** The size to draw at, for a scene drawn by its owner. */
  setSize(width: number, height: number) {
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.fit();
  }

  /** On the desktop: where each one stands (feet, parts of the screen's width and height) and how tall they are. */
  setDesk(spots: Record<string, [number, number]>, size: number) {
    this.desk = { spots, size: Math.max(0.05, size) };
    this.fit();
  }

  /** Draws one frame for `time` (ms): for a scene drawn by its owner. */
  renderAt(time: number) {
    this.draw(time);
  }

  /** Who is on the stage now; a figure is built again only when its character changed. */
  setMembers(members: SceneMember[]) {
    const ids = new Set(members.map((m) => m.id));
    for (const [id, placed] of this.placed) {
      if (!ids.has(id)) this.remove(id, placed);
    }
    let added = false;
    for (const member of members) {
      const code = member.avatar ?? characterCode(member.character);
      const placed = this.placed.get(member.id);
      if (placed && placed.code === code) {
        placed.member = member;
        continue;
      }
      let keep: Pick<Placed, "home" | "spot" | "pos" | "facing" | "placedByHand"> | null = null;
      if (placed) {
        keep = { home: placed.home, spot: placed.spot, pos: placed.pos, facing: placed.facing, placedByHand: placed.placedByHand };
        this.remove(member.id, placed);
      } else {
        added = true;
      }
      const figure = new Figure(member.character);
      figure.root.userData.id = member.id;
      this.scene.add(figure.root);
      // The figure waits unseen for its model, and shows only if the model does not come.
      if (member.avatar) {
        figure.root.visible = false;
        void this.loadModel(member.id, code, member);
      }
      const ring = this.options.preview || this.options.desk ? null : this.ring();
      const seed = seedOf(member.id);
      this.placed.set(member.id, {
        member,
        code,
        figure,
        clips: null,
        home: keep?.home ?? new THREE.Vector3(),
        anchor: keep?.home?.clone() ?? new THREE.Vector3(),
        spot: keep?.spot ?? new THREE.Vector3(),
        pos: keep?.pos ?? new THREE.Vector3(),
        facing: keep?.facing ?? 0,
        distance: 0,
        speed: 0,
        strollSlot: Number.NaN,
        stays: false,
        placedByHand: keep?.placedByHand ?? false,
        seed,
        voice: { mouth: 0, energy: 0 },
        ring,
      });
    }
    if (added || this.placed.size !== members.length) this.layout(members.map((m) => m.id));
  }

  private async loadModel(id: string, code: string, member: SceneMember, attempt = 0) {
    const stillWanted = () => !this.disposed && this.placed.get(id)?.code === code;
    try {
      const { loadAvatar } = await import("./model");
      const loaded = await loadAvatar(code, member.source);
      const placed = this.placed.get(id);
      if (!stillWanted() || !placed) {
        loaded.figure?.dispose();
        return;
      }
      placed.clips = loaded.clips;
      const body: Body | null = loaded.figure ?? (loaded.figureCode ? this.figureFrom(loaded.figureCode) : null);
      if (!body) {
        placed.figure.root.visible = true;
        return;
      }
      body.root.userData.id = id;
      this.scene.remove(placed.figure.root);
      placed.figure.dispose();
      this.scene.add(body.root);
      placed.figure = body;
    } catch (e) {
      console.warn("no model for", id, e);
      if (!stillWanted()) return;
      this.placed.get(id)!.figure.root.visible = true;
      // A friend's file may be still on its way to the server.
      if (attempt < 4) setTimeout(() => stillWanted() && void this.loadModel(id, code, member, attempt + 1), 15_000);
    }
  }

  private figureFrom(code: string): Figure | null {
    const character = parseCharacter(code);
    return character ? new Figure(character) : null;
  }

  /** How long an act goes: a motion from the workshop says it itself. */
  private lengthOf(act: string, user: string): number {
    if (!isClipAct(act)) return actLength(act);
    return this.placed.get(user)?.clips?.get(act)?.duration ?? this.options.clips?.find((c) => c.id === act)?.duration ?? 0;
  }

  /** Someone's figure does an act (with someone else's, if `to` is on the stage). */
  play(act: SceneAct) {
    if (this.acts.some((a) => a.key === act.key)) return;
    if (isMove(act.act)) {
      // A step on the call's floor means nothing on the desktop: there each one stays where they were put.
      if (this.options.desk) return;
      const to = parseMove(act.act);
      const who = this.placed.get(act.user);
      if (to && who) this.placeAt(who, to.x, to.z);
      return;
    }
    this.acts.push(this.stage(act));
  }

  /**
   * A pair act done to someone a step away begins with a walk up to them, on this stage's floor (on the desktop: along
   * the screen, to the other one's level), at walking pace with feet in step; the act starts once there.
   */
  private stage(act: SceneAct): StagedAct {
    const close = meetDistance(act.act);
    const me = this.placed.get(act.user);
    const other = act.to && act.to !== act.user ? this.placed.get(act.to) : undefined;
    if (close === undefined || !me || !other || !isInteraction(act.act)) return { ...act };
    const stop = close * Math.max(1, (radiusOf(me) + radiusOf(other)) / (2 * DEFAULT_RADIUS));
    const desk = !!this.options.desk;
    // Beside the other one, on the side the walker comes from.
    const dx = me.pos.x - other.pos.x;
    const dz = desk ? 0 : me.pos.z - other.pos.z;
    const apart = Math.hypot(dx, dz);
    const ux = apart > 1e-3 ? dx / apart : 1;
    const uz = apart > 1e-3 ? dz / apart : 0;
    // On the stage, never past what the picture shows (the other side of the friend, then).
    let mx = other.pos.x + ux * stop;
    if (!desk && Math.abs(mx) > this.floor.x) mx = other.pos.x - ux * stop;
    const meet = new THREE.Vector3(mx, desk ? other.pos.y : 0, other.pos.z + uz * stop);
    const way = me.pos.distanceTo(meet);
    if (way < WALK_FROM) return { ...act, met: true };
    me.spot.copy(meet);
    // Walking pace, and a little to slow down at the end; the act starts at once if the walker gets there sooner.
    return { ...act, startedAt: act.startedAt + (way / WALK_SPEED + 1.2) * 1000, met: true, walks: true };
  }

  /** The walks of pair acts: one who got there starts the act; one whose act is over goes back to where it stood. */
  private walkActs(time: number) {
    for (const act of this.acts) {
      if (!act.walks || act.back) continue;
      const me = this.placed.get(act.user);
      if (!me) continue;
      const elapsed = (time - act.startedAt) / 1000;
      if (elapsed < 0) {
        if (me.pos.distanceTo(me.spot) < ARRIVED) act.startedAt = time;
      } else if (elapsed > this.lengthOf(act.act, act.user)) {
        act.back = true;
        me.spot.copy(me.home);
      }
    }
  }

  /** Whether someone is on the way to a pair act, in it, or on the way back from it: no stroll then. */
  private busy(id: string): boolean {
    return this.acts.some((a) => a.walks && !a.back && (a.user === id || a.to === id));
  }

  /**
   * Stops drawing while the stage is out of sight (a shared screen is in front of it) and starts again where it is now:
   * the models stay loaded, so coming back is instant, and a parked stage costs the video card nothing.
   */
  setPaused(paused: boolean) {
    if (this.options.manual || this.disposed || this.paused === paused) return;
    this.paused = paused;
    cancelAnimationFrame(this.frame);
    if (!paused) {
      this.last = 0;
      this.resize();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private paused = false;

  resize() {
    if (this.options.manual) return;
    const canvas = this.canvas as HTMLCanvasElement;
    this.setSize(canvas.clientWidth, canvas.clientHeight);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    if (this.deskTicker) clearInterval(this.deskTicker);
    if (this.options.feedWalks) setStageWalks(new Map());
    if (!this.options.manual) {
      const element = this.canvas as HTMLCanvasElement;
      element.removeEventListener("pointerdown", this.onPointerDown);
      element.removeEventListener("pointermove", this.onPointerMove);
      element.removeEventListener("pointerup", this.onPointerUp);
      element.removeEventListener("pointercancel", this.onPointerCancel);
    }
    for (const [id, placed] of this.placed) this.remove(id, placed);
    for (const stool of this.stools.values()) {
      stool.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
      });
    }
    for (const sprite of this.marks.values()) sprite.material.dispose();
    for (const mesh of this.flying.values()) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.room?.dispose();
    if (this.floorShadow) {
      this.floorShadow.geometry.dispose();
      (this.floorShadow.material as THREE.Material).dispose();
    }
    this.environment?.dispose();
    this.glow.dispose();
    this.renderer.dispose();
  }

  /** A soft pool of the accent's light on the floor: shown under one who speaks, as loud as they are. */
  private ring(): THREE.Mesh {
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 1.15),
      new THREE.MeshBasicMaterial({ map: this.glow, color: this.accent, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.006;
    ring.renderOrder = 2;
    this.scene.add(ring);
    return ring;
  }

  private remove(id: string, placed: Placed) {
    this.scene.remove(placed.figure.root);
    placed.figure.dispose();
    if (placed.ring) {
      this.scene.remove(placed.ring);
      placed.ring.geometry.dispose();
      (placed.ring.material as THREE.Material).dispose();
    }
    this.placed.delete(id);
  }

  /** Everyone but `placed`, as discs where they stand and where they head. */
  private othersThan(placed: Placed): Disc[] {
    const discs: Disc[] = [];
    for (const other of this.placed.values()) {
      if (other === placed) continue;
      const r = radiusOf(other);
      discs.push({ x: other.pos.x, z: other.pos.z, r }, { x: other.spot.x, z: other.spot.z, r });
    }
    return discs;
  }

  private placeAt(placed: Placed, x: number, z: number) {
    // Never onto someone: the nearest spot where the two only stand side by side.
    const { x: cx, z: cz } = freeSpot(x, z, radiusOf(placed), this.othersThan(placed), this.floor);
    placed.home.set(cx, 0, cz);
    placed.spot.set(cx, 0, cz);
    placed.placedByHand = true;
    placed.stays = true;
  }

  /** On the desktop, each one goes where it was put; those not told yet stand in the middle at the bottom. */
  private placeOnDesk() {
    const height = DESK_HEIGHT / this.desk.size;
    const width = height * this.camera.aspect;
    // Those not put anywhere yet all start at the middle of the bottom; spread on one line, nobody stands in another.
    const items = [...this.placed].map(([id, placed]) => {
      const [x, y] = this.desk.spots[id] ?? [0.5, 1];
      return { id, x: x * width, y: (1 - y) * height, r: radiusOf(placed) };
    });
    const spread = spreadOnDesk(items, DESK_MARGIN - DEFAULT_RADIUS, width - DESK_MARGIN + DEFAULT_RADIUS, DESK_HEIGHT * 0.5);
    for (const [id, placed] of this.placed) {
      const item = items.find((i) => i.id === id)!;
      const sx = spread.get(id) ?? item.x;
      const at = new THREE.Vector3(Math.max(DESK_MARGIN, Math.min(width - DESK_MARGIN, sx)), item.y, 0);
      // Where it was put has not changed (the window was only resized or told the same again): it stays on its stroll.
      if (placed.placedByHand && placed.home.distanceTo(at) <= 0.02) continue;
      // Moved at once (dragged, or the screen changed): hair and skirts start from the new place, not fly over from the old one.
      if (placed.pos.distanceTo(at) > 0.02) placed.figure.jump();
      const first = !placed.placedByHand;
      placed.home.copy(at);
      placed.spot.copy(at);
      placed.pos.copy(at);
      placed.placedByHand = true;
      // Carried somewhere: it stays there until the next stroll. Just come: it takes the stroll everyone is on.
      if (!first) placed.strollSlot = strollPlan(placed.seed, wallTime(performance.timeOrigin, performance.now())).slot;
    }
  }

  /** Rows, a little bowed toward the camera; those who were put somewhere by hand stay there. */
  private layout(order: string[]) {
    if (this.options.desk) {
      this.fit();
      return;
    }
    // The same rows on every screen in the call: by the person's id, which is the same everywhere, not as the list here has
    // them (ourselves first), or a phone and a PC put the same two characters the other way round.
    const free = [...order].sort().filter((id) => !this.placed.get(id)?.placedByHand);
    const n = free.length;
    const perRow = n <= 6 ? Math.max(1, n) : n <= 12 ? Math.ceil(n / 2) : Math.ceil(n / 3);
    free.forEach((id, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, n - row * perRow);
      const k = i - row * perRow;
      const x = (k - (inRow - 1) / 2) * SPACING + (row % 2 === 1 ? SPACING / 2 : 0);
      const z = 0.35 - row * ROW_GAP - 0.035 * x * x;
      const placed = this.placed.get(id)!;
      const fresh = placed.home.lengthSq() === 0 && placed.pos.lengthSq() === 0;
      placed.anchor.set(x, 0, z);
      placed.home.set(x, 0, z);
      placed.spot.set(x, 0, z);
      if (fresh) placed.pos.set(x, 0, z);
    });
    this.fit();
  }

  private fit() {
    const n = this.placed.size;
    if (this.options.desk) {
      // The screen in metres: a character of the chosen size is DESK_HEIGHT tall.
      const height = DESK_HEIGHT / this.desk.size;
      this.ortho.left = 0;
      this.ortho.right = height * this.camera.aspect;
      this.ortho.top = height;
      this.ortho.bottom = 0;
      this.ortho.position.set(0, 0, 10);
      this.ortho.updateProjectionMatrix();
      this.placeOnDesk();
      return;
    }
    if (this.options.preview) {
      this.cameraBase.set(0, 0.9, 3.7);
      this.lookBase.set(0, 0.76, 0);
      this.camera.position.copy(this.cameraBase);
      this.camera.lookAt(this.lookBase);
      this.camera.updateProjectionMatrix();
      return;
    }
    if (this.options.manual || this.options.transparent) {
      const perRow = n <= 6 ? Math.max(1, n) : n <= 12 ? Math.ceil(n / 2) : Math.ceil(n / 3);
      const vertical = THREE.MathUtils.degToRad(this.camera.fov) / 2;
      const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
      const halfWidth = ((perRow - 1) / 2) * SPACING + 0.62;
      const distance = Math.max(3.1, halfWidth / Math.tan(horizontal), 0.98 / Math.tan(vertical));
      this.cameraBase.set(0, 1.14, distance);
      this.lookBase.set(0, 0.8, 0);
    } else {
      // On the stage: far enough for everyone and the edge of the stage, a little from above.
      const vertical = THREE.MathUtils.degToRad(this.camera.fov) / 2;
      const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
      const perRow = n <= 6 ? Math.max(1, n) : n <= 12 ? Math.ceil(n / 2) : Math.ceil(n / 3);
      const halfWidth = ((perRow - 1) / 2) * SPACING + 0.95;
      const distance = Math.max(5.3, 1.45 / Math.tan(vertical), halfWidth / Math.tan(horizontal) + 0.8);
      this.cameraBase.set(0, 1.62, distance);
      this.lookBase.set(0, 0.78, -0.5);
      this.floor = visibleFloor(distance, horizontal);
      // Someone who stood out of a narrower picture (the phone turned upright) comes back into it.
      for (const placed of this.placed.values()) {
        for (const point of [placed.home, placed.spot]) point.x = Math.max(-this.floor.x, Math.min(this.floor.x, point.x));
      }
    }
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(this.lookBase);
    this.camera.updateProjectionMatrix();
  }

  private pointerRay(event: PointerEvent) {
    const rect = (this.canvas as HTMLCanvasElement).getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
  }

  /**
   * Whose character is under the pointer. Not the model's exact triangles (thin arms and legs make it a hunt) but a band
   * along the body on the screen, from the feet to the top of the head, as wide as the body or at least a finger.
   */
  private figureAt(event: PointerEvent): string | null {
    const rect = (this.canvas as HTMLCanvasElement).getBoundingClientRect();
    return this.figureAtPoint(event.clientX - rect.left, event.clientY - rect.top, event.pointerType === "touch");
  }

  /**
   * Whose character is at this point of the canvas (its own pixels from the top left), if anyone's: the desktop's
   * window asks it, to take the mouse only over a character, wherever that one has walked to.
   */
  figureAtPoint(px: number, py: number, finger = false): string | null {
    const rect = (this.canvas as HTMLCanvasElement).getBoundingClientRect();
    const camera = this.options.desk ? this.ortho : this.camera;
    const toScreen = (v: THREE.Vector3) => {
      const p = v.clone().project(camera);
      return { x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height, z: p.z };
    };
    let best: { id: string; d: number; z: number } | null = null;
    for (const [id, placed] of this.placed) {
      if (!placed.figure.root.visible) continue;
      const feet = placed.figure.root.position.clone();
      const head = placed.figure.headPosition().add(new THREE.Vector3(0, 0.12, 0));
      const a = toScreen(feet);
      const b = toScreen(head);
      const side = toScreen(feet.clone().add(new THREE.Vector3(radiusOf(placed), 0, 0)));
      // A finger is wider than a mouse's point, and a phone draws the characters small.
      const half = finger ? Math.max(30, Math.abs(side.x - a.x) * 1.5) : Math.max(18, Math.abs(side.x - a.x) * 1.15);
      // Distance from the pointer to the segment feet–head on the screen.
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / len));
      const d = Math.hypot(px - (a.x + t * vx), py - (a.y + t * vy));
      if (d > half) continue;
      if (!best || d < best.d - 4 || (Math.abs(d - best.d) <= 4 && a.z < best.z)) best = { id, d, z: a.z };
    }
    return best?.id ?? null;
  }

  /** On the desktop: the point of the scene (metres, the screen's bottom left at 0) under the pointer. */
  private deskPoint(event: PointerEvent): THREE.Vector3 {
    const rect = (this.canvas as HTMLCanvasElement).getBoundingClientRect();
    const height = DESK_HEIGHT / this.desk.size;
    const width = height * this.camera.aspect;
    return new THREE.Vector3(((event.clientX - rect.left) / rect.width) * width, (1 - (event.clientY - rect.top) / rect.height) * height, 0);
  }

  /** Our own character, if it is on this stage and may be moved. */
  private mine(): Placed | null {
    if (!this.options.onMoved || this.options.desk || this.options.preview) return null;
    for (const placed of this.placed.values()) if (placed.member.local) return placed;
    return null;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const id = this.figureAt(event);
    if (!id) {
      if (this.mine()) this.floorPress = { x: event.clientX, y: event.clientY };
      return;
    }
    const placed = this.placed.get(id);
    // On the desktop a figure is carried by the point it was taken at.
    const offset = this.options.desk && placed ? placed.pos.clone().sub(this.deskPoint(event)) : undefined;
    this.dragging = { id, startX: event.clientX, startY: event.clientY, moved: false, offset };
    (this.canvas as HTMLCanvasElement).setPointerCapture?.(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.dragging;
    if (!drag) return;
    const placed = this.placed.get(drag.id);
    if (this.options.desk) {
      // On one's own desktop anyone may be carried anywhere, and stays where they are let go.
      if (!placed || !drag.offset || !this.options.onPlaced) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      drag.moved = true;
      const height = DESK_HEIGHT / this.desk.size;
      const width = height * this.camera.aspect;
      const at = this.deskPoint(event).add(drag.offset);
      at.set(Math.max(DESK_MARGIN, Math.min(width - DESK_MARGIN, at.x)), Math.max(0, Math.min(height - DESK_HEIGHT, at.y)), 0);
      placed.home.copy(at);
      placed.spot.copy(at);
      placed.pos.copy(at);
      return;
    }
    if (!placed?.member.local || !this.options.onMoved) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.moved = true;
    this.pointerRay(event);
    const onFloor = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (onFloor) this.placeAt(placed, onFloor.x, onFloor.z);
  };

  /** The touch was taken away (a system gesture): nothing is picked and nothing carried further. */
  private readonly onPointerCancel = () => {
    this.dragging = null;
    this.floorPress = null;
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const press = this.floorPress;
    this.floorPress = null;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8) {
      // A click on the floor: our character walks there.
      const me = this.mine();
      this.pointerRay(event);
      const onFloor = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (me && onFloor) {
        this.placeAt(me, onFloor.x, onFloor.z);
        this.options.onMoved?.(me.home.x, me.home.z);
      }
      return;
    }
    const drag = this.dragging;
    this.dragging = null;
    if (!drag) return;
    if (drag.moved) {
      const placed = this.placed.get(drag.id);
      if (placed && this.options.desk) {
        const height = DESK_HEIGHT / this.desk.size;
        this.options.onPlaced?.(drag.id, [placed.home.x / (height * this.camera.aspect), 1 - placed.home.y / height]);
      } else if (placed) this.options.onMoved?.(placed.home.x, placed.home.z);
      return;
    }
    this.options.onPick?.(drag.id, event.clientX, event.clientY);
  };

  /** The act a figure is in now, as it or the other one sees it. */
  private actOf(id: string, now: number): ActNow | null {
    for (let i = this.acts.length - 1; i >= 0; i--) {
      const act = this.acts[i]!;
      const elapsed = (now - act.startedAt) / 1000;
      if (elapsed < 0 || elapsed > this.lengthOf(act.act, act.user)) continue;
      const other = act.to ? this.placed.get(act.to) : undefined;
      const together = isInteraction(act.act) && other && act.to !== act.user;
      const met = !!act.met;
      if (act.user === id) {
        if (!together) return { id: act.act, elapsed, role: isInteraction(act.act) ? "actor" : "solo", toward: { x: 0, z: 0.7 } };
        const me = this.placed.get(id)!;
        const reach = (radiusOf(me) + radiusOf(other)) / (2 * DEFAULT_RADIUS);
        return { id: act.act, elapsed, role: "actor", toward: { x: other.pos.x - me.pos.x, z: other.pos.z - me.pos.z }, reach, met };
      }
      if (together && act.to === id) {
        const actor = this.placed.get(act.user);
        if (!actor) continue;
        const me = this.placed.get(id)!;
        return { id: act.act, elapsed, role: "target", toward: { x: actor.pos.x - me.pos.x, z: actor.pos.z - me.pos.z }, met };
      }
    }
    return null;
  }

  private readonly tick = (time: number) => {
    this.frame = requestAnimationFrame(this.tick);
    this.lastTick = time;
    this.drawCapped(time);
  };

  /** A frame, unless one was drawn less than a frame's time ago at the scene's rate. */
  private drawCapped(time: number) {
    const fps = this.options.fps ?? 60;
    if (time - this.last < 1000 / fps - 2) return;
    this.last = time;
    this.draw(time);
  }

  /**
   * A model's motion capture for this frame: standing, talking and walking from recordings, an act from its recording
   * where it has one, and a drawn act over a living body where it does not (the act keeps the joints it moves). Null for a
   * drawn figure, or while the recordings are still coming.
   */
  private recordedLayer(
    placed: Placed,
    pose: Pose,
    bare: Pose | null,
    act: ActNow | null,
    input: Omit<Parameters<typeof poseAt>[0], "act">,
    t: number,
    look: { yaw: number; pitch: number } | null,
  ): MotionLayer | null {
    const lib = this.motions;
    const figure = placed.figure as { recorded?: boolean; hipsHeight?: number };
    if (!lib || !figure.recorded) return null;
    const m = (placed.motion ??= { frame: newFrame(), scratch: newFrame(), keep: new Set<JointName>() });
    baseMotion(lib, { t, seed: placed.seed, talking: input.energy ?? 0, speed: placed.speed, distance: placed.distance, hipsHeight: figure.hipsHeight ?? 0.8 }, m.frame, m.scratch);
    m.keep.clear();
    if (act) {
      const role = act.role === "target" ? "target" : act.role === "actor" ? "actor" : "solo";
      const played = actMotion(lib, { id: act.id, elapsed: act.elapsed, length: this.lengthOf(act.id, placed.member.id), role }, m.frame, m.scratch);
      if (played && drawnLegs(act.id)) {
        // The recording's arms and body, the drawn legs and lift.
        for (const joint of ["legL", "shinL", "footL", "legR", "shinR", "footR"] as const) m.keep.add(joint);
      } else if (played) {
        // The recording moves the whole body: the drawn act only keeps its face, and where it walks to.
        const still = bare ?? poseAt({ ...input, act: null });
        pose.y = still.y;
        pose.roll = still.roll;
      } else {
        const without = bare ?? poseAt({ ...input, act: null });
        for (const joint of JOINTS) if (jointGap(pose[joint], without[joint]) > ACT_KEEPS) m.keep.add(joint);
      }
    }
    return { frame: m.frame, weight: 1, keep: m.keep, lookYaw: look ? look.yaw * 0.7 : 0 };
  }

  /**
   * The stool of one who sits: where the recording puts the hips once seated, as high as this model's seat, coming in
   * as they sit down and going as they stand up. Gone when they do not sit.
   */
  private placeStool(id: string, placed: Placed, act: ActNow | null) {
    let stool = this.stools.get(id);
    if (!act) {
      if (stool) stool.visible = false;
      return;
    }
    const seated = this.motions?.clip("sit")?.sample(0, newFrame()).hips;
    const hipsHeight = (placed.figure as { hipsHeight?: number }).hipsHeight ?? 0.8;
    if (!seated) return;
    if (!stool) {
      stool = makeStool();
      this.stools.set(id, stool);
      this.scene.add(stool);
    }
    const length = this.lengthOf(act.id, placed.member.id);
    const show = Math.min(1, act.elapsed / 0.35, (length - act.elapsed) / 0.35);
    const seat = Math.max(0.2, hipsHeight * (1 + seated.y) - hipsHeight * 0.16);
    const root = placed.figure.root;
    const back = new THREE.Vector3(seated.x * hipsHeight, 0, seated.z * hipsHeight - 0.04).applyAxisAngle(new THREE.Vector3(0, 1, 0), root.rotation.y);
    stool.visible = show > 0.01;
    stool.position.set(root.position.x + back.x, 0, root.position.z + back.z);
    stool.rotation.y = root.rotation.y;
    stool.scale.set(1, seat * Math.max(0.001, show), 1);
  }

  /**
   * A little stroll now and then, so that the room is alive. When and which way go by the wall clock (`strollPlan`):
   * the call's stage and the desktop, each in its own window, stroll together.
   */
  private stroll(id: string, placed: Placed, wall: number) {
    if (this.options.preview || this.options.manual || this.busy(id) || this.dragging?.id === id) return;
    if (this.options.desk) {
      // On the desktop each one walks as on the call's stage, from where it was put; its own strolls only while the call
      // has no stage to follow (3D off there).
      const walk = this.walks[id];
      if (walk) {
        const width = (DESK_HEIGHT / this.desk.size) * this.camera.aspect;
        const x = deskWalkTarget(placed.home.x, walk[0], width, DESK_MARGIN);
        if (Math.abs(placed.spot.x - x) > 0.01) placed.spot.set(x, placed.home.y, 0);
        return;
      }
    }
    if (placed.stays) return;
    const plan = strollPlan(placed.seed, wall);
    if (plan.slot === placed.strollSlot) return;
    const first = Number.isNaN(placed.strollSlot);
    placed.strollSlot = plan.slot;
    // Just come into the call: it stands where it came in until the next stroll (no walk of its own at once).
    if (first) return;
    const a = plan.chance;
    const b = plan.depth;
    if (this.options.desk) {
      // On the desktop: a walk of up to two heights to one side or the other along the line it stands on, never off the
      // screen nor into someone standing on the same line.
      const width = (DESK_HEIGHT / this.desk.size) * this.camera.aspect;
      const x = deskStroll(placed.home.x, a, width, DESK_HEIGHT * 2, DESK_MARGIN);
      for (const other of this.placed.values()) {
        if (other !== placed && Math.abs(other.spot.y - placed.home.y) < DESK_HEIGHT * 0.3 && Math.abs(other.spot.x - x) < radiusOf(placed) + radiusOf(other) + GAP) return;
      }
      placed.spot.set(x, placed.home.y, 0);
      return;
    }
    const reach = this.options.transparent ? 0.2 : 0.7;
    const x = Math.max(-this.floor.x, Math.min(this.floor.x, placed.home.x + (a - 0.5) * 2 * reach));
    // More to the sides than away: nobody wants to talk to a back.
    const z = Math.max(FLOOR.back, Math.min(FLOOR.front, placed.home.z + (b - 0.3) * reach * 0.5));
    for (const other of this.placed.values()) {
      if (other !== placed && Math.hypot(other.spot.x - x, other.spot.z - z) < Math.max(ELBOW_ROOM, radiusOf(placed) + radiusOf(other) + GAP)) return;
    }
    placed.spot.set(x, 0, z);
  }

  private draw(time: number) {
    const t = time / 1000;
    const dt = frameStep(time - this.lastDraw, 0.1);
    // Walking goes by the time that passed (see `DESK_MAX_STEP_S`); everything else keeps the small step.
    const walkDt = this.options.desk ? frameStep(time - this.lastDraw, DESK_MAX_STEP_S) : dt;
    const wall = wallTime(performance.timeOrigin, time);
    this.lastDraw = time;
    this.drawsSince++;
    this.walkActs(time);
    this.acts = this.acts.filter((a) => (time - a.startedAt) / 1000 <= this.lengthOf(a.act, a.user) + 0.2);

    // Whom everyone looks at: the loudest of those who speak.
    let speaker: Placed | null = null;
    for (const placed of this.placed.values()) {
      if (placed.member.speaking && (!speaker || placed.member.level > speaker.member.level)) speaker = placed;
    }

    for (const [id, placed] of this.placed) {
      const act = this.actOf(id, time);
      if (!act) this.stroll(id, placed, wall);

      // On the desktop one may walk up or down to another standing higher or lower (on a window's edge).
      const dx = placed.spot.x - placed.pos.x;
      const dy = placed.spot.y - placed.pos.y;
      const dz = placed.spot.z - placed.pos.z;
      const away = Math.hypot(dx, dy, dz);
      const walking = away > 0.03 && !act;
      const targetSpeed = walking ? Math.min(1, away * 3) : 0;
      placed.speed += (targetSpeed - placed.speed) * Math.min(1, walkDt * 8);
      if (walking) {
        // On the desktop a walk as the stage's is longer (the screen is wider): it is walked a little faster, to arrive
        // about when the stage's figure does.
        const pace = this.options.desk && this.walks[id] && !act ? DESK_WALK_SCALE * 0.7 : 1;
        const step = Math.min(away, placed.speed * WALK_SPEED * walkDt * pace);
        placed.pos.x += (dx / away) * step;
        placed.pos.y += (dy / away) * step;
        placed.pos.z += (dz / away) * step;
        placed.distance += step;
      }
      // Faces where it goes; doing something with someone, faces them; standing, faces the room a little turned
      // toward whoever speaks.
      let wanted = 0;
      const other = act?.met ? act.toward : undefined;
      if (walking && Math.hypot(dx, dz) > 0.01) wanted = Math.atan2(dx, dz);
      else if (other) wanted = Math.atan2(other.x, other.z);
      else if (speaker && speaker !== placed) wanted = Math.atan2(speaker.pos.x - placed.pos.x, speaker.pos.z - placed.pos.z) * 0.32;
      const diff = Math.atan2(Math.sin(wanted - placed.facing), Math.cos(wanted - placed.facing));
      placed.facing += diff * Math.min(1, dt * (walking || other ? 8 : 2.4));

      let look: { yaw: number; pitch: number } | null = null;
      if (speaker && speaker !== placed) {
        const yaw = Math.atan2(speaker.pos.x - placed.pos.x, speaker.pos.z - placed.pos.z) - placed.facing;
        const wrapped = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        if (Math.abs(wrapped) < 2) look = { yaw: Math.max(-0.8, Math.min(0.8, wrapped)), pitch: 0 };
      }

      const clip = act?.role === "solo" ? (placed.clips?.get(act.id) ?? (isClipAct(act.id) ? this.options.clips?.find((c) => c.id === act.id) : undefined)) : undefined;
      const voice = followVoice(placed.voice, placed.member.speaking ? placed.member.level : 0, dt);
      const input = { t, seed: placed.seed, level: voice.mouth, energy: voice.energy, walk: { speed: placed.speed, distance: placed.distance }, look };
      const pose = poseAt({ ...input, act: clip ? null : act });
      // The drawn pose with no act at all: what a drawn act changes is the joints it keeps.
      let bare: Pose | null = null;
      if (clip && act) {
        bare = structuredClone(pose);
        const voice = pose.mouth;
        playClip(clip, act.elapsed, pose);
        // Talking goes on through a motion: the mouth is whichever opens wider.
        pose.mouth = Math.max(pose.mouth, voice);
      }
      // A gallery take choreographs the entire body. Crossfade the idle recording at its edges, so a held
      // wrist or planted leg never snaps back to motion capture halfway through the performance.
      const galleryTake = clip && !isClipAct(clip.id);
      const layer = this.recordedLayer(placed, pose, bare, galleryTake ? null : act, input, t, look);
      if (galleryTake && layer && act) {
        layer.weight = 1 - clipWeight(clip, act.elapsed);
        layer.lookYaw *= layer.weight;
      }
      if (this.options.preview) pose.turn += 0.5 * Math.sin(t * 0.55);
      pose.turn += placed.facing;
      let x = placed.pos.x + pose.x;
      if (this.options.desk) {
        // Never off the screen, whatever an act does.
        const width = (DESK_HEIGHT / this.desk.size) * this.camera.aspect;
        x = Math.max(DESK_MARGIN, Math.min(width - DESK_MARGIN, x));
      }
      placed.figure.root.position.set(x, placed.pos.y, placed.pos.z + pose.z);
      placed.figure.apply(pose, t, layer);
      this.placeStool(id, placed, layer && act?.id === "sit" ? act : null);
      if (placed.ring) {
        const material = placed.ring.material as THREE.MeshBasicMaterial;
        const wantedOpacity = placed.member.speaking ? 0.45 + 0.55 * Math.min(1, placed.member.level * 2) : 0;
        material.opacity += (wantedOpacity - material.opacity) * Math.min(1, dt * 14);
        placed.ring.visible = material.opacity > 0.01;
        placed.ring.position.x = placed.pos.x + pose.x;
        placed.ring.position.z = placed.pos.z + pose.z;
      }
    }

    this.keepApart(time, dt);
    this.tellWalks();

    // The camera breathes, and leans a little toward whoever speaks.
    if (!this.options.preview && !this.options.manual && !this.options.transparent) {
      const focus = speaker ? speaker.pos.x * 0.14 : 0;
      this.focusX += (focus - this.focusX) * Math.min(1, dt * 1.2);
      this.camera.position.set(this.cameraBase.x + this.focusX * 1.2 + Math.sin(t * 0.13) * 0.035, this.cameraBase.y + Math.sin(t * 0.21) * 0.012, this.cameraBase.z);
      this.camera.lookAt(this.lookBase.x + this.focusX, this.lookBase.y, this.lookBase.z);
    }

    this.room?.update(t);
    this.drawActs(time);
    this.renderer.render(this.scene, this.options.desk ? this.ortho : this.camera);
  }

  /**
   * Nobody stands inside anybody: those who come too close are pushed apart a little every frame (and their spot with
   * them, so they do not walk back in). Two doing something together are left as their act puts them.
   */
  private keepApart(time: number, dt: number) {
    if (this.options.desk || this.placed.size < 2) return;
    const list = [...this.placed.values()];
    const ids = [...this.placed.keys()];
    const together = new Set<string>();
    for (const act of this.acts) {
      const elapsed = (time - act.startedAt) / 1000;
      // Two doing something together, and one on the way up to the other for it.
      if (act.to && act.to !== act.user && (elapsed >= 0 || act.walks) && elapsed <= this.lengthOf(act.act, act.user)) {
        together.add(`${act.user}|${act.to}`);
        together.add(`${act.to}|${act.user}`);
      }
    }
    const discs = list.map((p) => ({ x: p.pos.x, z: p.pos.z, r: radiusOf(p) }));
    separate(discs, Math.min(1, dt * 6), (i, j) => !together.has(`${ids[i]}|${ids[j]}`));
    discs.forEach((disc, i) => {
      const p = list[i]!;
      const dx = disc.x - p.pos.x;
      const dz = disc.z - p.pos.z;
      if (dx === 0 && dz === 0) return;
      // One on the way keeps its goal and only steps aside; one standing stays where the push left it.
      const walking = Math.hypot(p.spot.x - p.pos.x, p.spot.z - p.pos.z) > 0.05;
      p.pos.x = disc.x;
      p.pos.z = disc.z;
      if (walking) return;
      p.spot.x += dx;
      p.spot.z += dz;
      p.home.x += dx;
      p.home.z += dz;
    });
  }

  /** Hearts, stars and the like; hearts, snowballs and pies on their way. */
  private drawActs(time: number) {
    const liveMarks = new Set<string>();
    const liveFlights = new Set<number>();
    for (const act of this.acts) {
      const elapsed = (time - act.startedAt) / 1000;
      if (elapsed < 0) continue;
      const length = this.lengthOf(act.act, act.user);
      if (length <= 0) continue;
      const p = elapsed / length;
      const actor = this.placed.get(act.user);
      const target = act.to && act.to !== act.user ? this.placed.get(act.to) : undefined;
      if (!actor) continue;
      (EFFECTS[act.act] ?? []).forEach((effect, index) => {
        const holder = effect.on === "target" ? (target ?? actor) : actor;
        if (p < effect.start || p > effect.end) return;
        const span = effect.end - effect.start;
        for (let i = 0; i < effect.count; i++) {
          const stagger = effect.stagger ?? 0;
          const begin = effect.start + (i / Math.max(1, effect.count)) * span * stagger;
          const lifeLength = span * (1 - stagger) + span * stagger * 0.42;
          const life = (p - begin) / lifeLength;
          if (life < 0 || life > 1) continue;
          const key = `${act.key}:${index}:${i}`;
          liveMarks.add(key);
          let sprite = this.marks.get(key);
          if (!sprite) {
            sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: markTexture(effect.mark), transparent: true, depthWrite: false, toneMapped: false }));
            sprite.renderOrder = 8;
            this.marks.set(key, sprite);
            this.scene.add(sprite);
          }
          const origin =
            effect.from === "hand"
              ? holder.figure.handPosition()
              : effect.from === "between" && target
                ? actor.figure.headPosition().lerp(target.figure.headPosition(), 0.5)
                : holder.figure.headPosition();
          const [x, y, z] = effect.path(i, life, effect.count);
          sprite.position.set(origin.x + x, origin.y + y, origin.z + z);
          sprite.scale.setScalar(effect.size * (0.7 + 0.5 * Math.min(1, life * 4)));
          sprite.material.opacity = Math.min(1, (1 - life) * 3.5);
        }
      });
      const q = flight(act.act, elapsed);
      if (target && q !== null) {
        liveFlights.add(act.key);
        let thing = this.flying.get(act.key);
        if (!thing) {
          thing =
            act.act === "snowball"
              ? new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 2), new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.65 }))
              : new THREE.Mesh(heartGeometry(), new THREE.MeshBasicMaterial({ color: 0xff4f7b, side: THREE.DoubleSide, toneMapped: false }));
          thing.castShadow = true;
          this.flying.set(act.key, thing);
          this.scene.add(thing);
        }
        const from = actor.figure.handPosition();
        const to = target.figure.headPosition();
        thing.position.lerpVectors(from, to, q);
        thing.position.y += Math.sin(q * Math.PI) * 0.5;
        if (act.act === "heart") thing.lookAt(this.camera.position);
      }
    }
    for (const [key, sprite] of this.marks) {
      if (!liveMarks.has(key)) {
        this.scene.remove(sprite);
        sprite.material.dispose();
        this.marks.delete(key);
      }
    }
    for (const [key, mesh] of this.flying) {
      if (!liveFlights.has(key)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.flying.delete(key);
      }
    }
  }
}

/** A round wooden stool a metre high, scaled down to a seat's height: a seat on three legs. */
function makeStool(): THREE.Group {
  const group = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6446, roughness: 0.62, metalness: 0.02 });
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.19, 0.06, 28), wood);
  seat.position.y = 0.97;
  seat.castShadow = true;
  seat.receiveShadow = true;
  group.add(seat);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.95, 10), wood.clone());
    leg.position.set(Math.sin(a) * 0.13, 0.475, Math.cos(a) * 0.13);
    leg.rotation.set(Math.cos(a) * 0.08, 0, -Math.sin(a) * 0.08);
    leg.castShadow = true;
    group.add(leg);
  }
  group.visible = false;
  return group;
}

let heart: THREE.ShapeGeometry | null = null;
/** A small flat heart. */
function heartGeometry(): THREE.ShapeGeometry {
  if (heart) return heart.clone();
  const s = new THREE.Shape();
  s.moveTo(0, -0.1);
  s.bezierCurveTo(-0.16, 0.02, -0.12, 0.14, 0, 0.07);
  s.bezierCurveTo(0.12, 0.14, 0.16, 0.02, 0, -0.1);
  heart = new THREE.ShapeGeometry(s);
  return heart.clone();
}
