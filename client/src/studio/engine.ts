import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { defaultAvatarFor } from "../characters/gallery";
import { usePrefs } from "../state/prefs";
import { android, IS_ANDROID } from "../platform/android";
import { AndroidScreen } from "../voice/androidCapture";
import { DEFAULT_MIXER, StudioAudio, type MixerSettings } from "./audio";
import { loadJson, saveJson } from "../state/persist";
import {
  videoCodec,
  DEFAULT_LOOK,
  parseOutput,
  placeNew,
  videoBitrate,
  withSource,
  type Output,
  type Rect,
  type Scene,
  type SourceKind,
  type SourceLook,
  type StudioSource,
  type TextStyle,
  type Transition,
} from "./layout";
import type { EncoderOptions, FromWorker, StreamPacket, ToWorker, WorkerStats } from "./protocol";

export type Recording = { startedAt: number; bytes: number; path: string };

export type StudioState = {
  scenes: Scene[];
  /** The scene on the air: what the stream and the recording show. */
  activeScene: string;
  /**
   * Studio mode, as in OBS: a scene is prepared on the preview while another one is on the air, and goes on the air
   * through the transition at «Перевести». Off, the preview is the air itself.
   */
  studioMode: boolean;
  /** The scene being prepared in studio mode; the scene on the air otherwise. */
  editScene: string;
  /** The sources of the scene being edited (`editScene`). */
  sources: StudioSource[];
  transition: Transition;
  output: Output;
  recording: Recording | null;
  /** The last finished recording. */
  recorded: string | null;
  stats: WorkerStats;
  micDevice: string | null;
  mixer: MixerSettings;
  /** Seconds kept for «Сохранить повтор»; 0 is off. */
  replaySeconds: number;
  error: string | null;
};

const SETTINGS_KEY = "hatavoice.studio";

type Saved = { output?: unknown; mixer?: Partial<MixerSettings>; transition?: Transition; replaySeconds?: number };

function loadSaved(): Saved {
  const raw = loadJson(SETTINGS_KEY);
  return typeof raw === "object" && raw !== null ? (raw as Saved) : {};
}

const saved = loadSaved();
const FIRST_SCENE = "scene1";

export const useStudio = create<StudioState>(() => ({
  scenes: [{ id: FIRST_SCENE, name: "Сцена 1", sources: [] }],
  activeScene: FIRST_SCENE,
  studioMode: false,
  editScene: FIRST_SCENE,
  sources: [],
  transition: saved.transition && typeof saved.transition.ms === "number" ? saved.transition : { kind: "fade", ms: 400 },
  output: parseOutput(saved.output),
  recording: null,
  recorded: null,
  stats: { fps: 0, dropped: 0, queue: 0, renderMs: 0, kbps: 0 },
  micDevice: "",
  mixer: { ...DEFAULT_MIXER, ...saved.mixer, fx: { ...DEFAULT_MIXER.fx, ...saved.mixer?.fx } },
  replaySeconds: typeof saved.replaySeconds === "number" ? saved.replaySeconds : 0,
  error: null,
}));

useStudio.subscribe((s) => saveJson(SETTINGS_KEY, { output: s.output, mixer: s.mixer, transition: s.transition, replaySeconds: s.replaySeconds }));

/** The local time as a file name: `YYYY-MM-DD HH-MM-SS`. */
export function stamp(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`;
}

const NAMES: Record<SourceKind, string> = { screen: "Экран", camera: "Камера", character: "3D-персонаж", text: "Текст", image: "Картинка", color: "Цвет", clock: "Часы" };

let worker: Worker | null = null;
let audio: StudioAudio | null = null;
const tracks = new Map<string, MediaStreamTrack[]>();
/** The phone's screen as a source (Android's capture), to be stopped there when the source goes. */
const phoneScreens = new Map<string, AndroidScreen>();

/** A source's capture ends: its tracks, and on a phone Android's capture of the screen. */
function stopTracks(id: string) {
  for (const track of tracks.get(id) ?? []) {
    track.stop();
    if (track.kind === "audio") audio?.setScreen(null);
  }
  tracks.delete(id);
  const phone = phoneScreens.get(id);
  if (phone) {
    phoneScreens.delete(id);
    phone.stop();
    android()?.send({ op: "screen-stop" });
  }
}
let preview: ImageBitmapRenderingContext | null = null;
let editPreview: ImageBitmapRenderingContext | null = null;
let writes: Promise<unknown> = Promise.resolve();
let nextId = 1;
/** Whoever takes the stream's packets (the stream, once it runs). */
let packetSink: ((packet: StreamPacket) => void) | null = null;

const set = useStudio.setState;
const get = useStudio.getState;
const send = (message: ToWorker, transfer: Transferable[] = []) => worker?.postMessage(message, transfer);

function fail(e: unknown) {
  set({ error: e instanceof Error ? e.message : String(e) });
}

function onMessage(event: MessageEvent<FromWorker>) {
  const message = event.data;
  switch (message.type) {
    case "preview": {
      const target = message.edit ? editPreview : preview;
      if (target) target.transferFromImageBitmap(message.bitmap);
      else message.bitmap.close();
      send({ type: "preview-done", edit: message.edit });
      break;
    }
    case "file": {
      const { data, position } = message;
      writes = writes.then(() => invoke("studio_record_write", data, { headers: { "x-position": String(position) } })).catch(fail);
      const recording = get().recording;
      if (recording) set({ recording: { ...recording, bytes: Math.max(recording.bytes, position + data.byteLength) } });
      break;
    }
    case "recorded":
      writes = writes.then(async () => {
        const path = await invoke<string | null>("studio_record_close");
        set({ recording: null, recorded: path ?? get().recorded });
      });
      break;
    case "packet":
      packetSink?.(message.packet);
      break;
    case "snapshot":
      void invoke<string>("studio_snapshot", message.data, { headers: { "x-stamp": stamp() } })
        .then((path) => set({ recorded: path }))
        .catch(fail);
      break;
    case "stats":
      set({ stats: { fps: message.fps, dropped: message.dropped, queue: message.queue, renderMs: message.renderMs, kbps: message.kbps } });
      break;
    case "clip":
      if (!message.data) {
        fail("Повтор пока пуст: подожди пару секунд");
        break;
      }
      void invoke<string>("studio_save_clip", message.data, { headers: { "x-stamp": stamp() } })
        .then((path) => set({ recorded: path }))
        .catch(fail);
      break;
    case "error":
      fail(message.message);
      break;
  }
}

/** The compositor and the sound, started the first time the studio is used. */
async function ensure(): Promise<{ worker: Worker; audio: StudioAudio }> {
  if (worker && audio) return { worker, audio };
  worker = new Worker(new URL("./compositor.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = onMessage;
  audio = new StudioAudio();
  await audio.configure(get().mixer);
  pushOutput();
  pushLayout();
  if (get().replaySeconds > 0) send({ type: "replay", seconds: get().replaySeconds });
  const processor = new MediaStreamTrackProcessor({ track: audio.track as MediaStreamAudioTrack });
  send({ type: "audio", readable: processor.readable }, [processor.readable]);
  try {
    await audio.setMic(get().micDevice);
  } catch (e) {
    fail(`Микрофон: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const port = await audio.meterPort();
    send({ type: "level", port }, [port]);
  } catch {
    // The character just will not move its mouth.
  }
  return { worker, audio };
}

/** What the encoders are told from what the person chose. */
export function encoderOptions(output: Output): EncoderOptions {
  return {
    width: output.width,
    height: output.height,
    fps: output.fps,
    bitrate: videoBitrate(output),
    codec: videoCodec(output),
    bitrateMode: output.rate === "cbr" ? "constant" : "variable",
    keyEveryUs: output.keySeconds * 1_000_000,
    hardware: output.encoder === "hardware" ? "prefer-hardware" : output.encoder === "software" ? "prefer-software" : "no-preference",
    latency: output.latency,
    audioBitrate: output.audioKbps * 1000,
  };
}

function pushOutput() {
  send({ type: "output", ...encoderOptions(get().output) });
}

const drawn = (sources: StudioSource[]) => sources.map(({ id, kind, rect, visible, look, text, color }) => ({ id, kind, rect, visible, look, text, color }));
const sourcesOf = (id: string) => get().scenes.find((scene) => scene.id === id)?.sources ?? [];

/** The frame shows the scene on the air; in studio mode the preview shows the scene being prepared. */
function pushLayout(transition?: Transition) {
  const { activeScene, studioMode, editScene } = get();
  send({ type: "layout", sources: drawn(sourcesOf(activeScene)), transition });
  send({ type: "edit", sources: studioMode ? drawn(sourcesOf(editScene)) : null });
}

/** The sources of the scene being edited changed: the scene keeps them, the frame or the preview shows them. */
function setSources(sources: StudioSource[]) {
  const { scenes, editScene } = get();
  set({ sources, scenes: scenes.map((scene) => (scene.id === editScene ? { ...scene, sources } : scene)) });
}

/** Whether any scene still shows a source. */
const inUse = (id: string, scenes: Scene[]) => scenes.some((scene) => scene.sources.some((s) => s.id === id));

function addSource(kind: SourceKind, aspect?: number, extra: { text?: TextStyle; color?: string } = {}): string {
  const id = `s${nextId++}`;
  const { output, sources } = get();
  const source: StudioSource = { id, kind, name: NAMES[kind], rect: placeNew(kind, output, aspect), visible: true, look: DEFAULT_LOOK, ...extra };
  setSources(withSource(sources, source));
  set({ error: null });
  pushLayout();
  return id;
}

function feedVideo(id: string, track: MediaStreamTrack) {
  const processor = new MediaStreamTrackProcessor({ track: track as MediaStreamVideoTrack });
  send({ type: "video", id, readable: processor.readable }, [processor.readable]);
  track.addEventListener("ended", () => studio.remove(id));
}

/** The studio: its sources, its sound, its outputs. One per app; it goes on while the window shows something else. */
export const studio = {
  async addScreen() {
    if (IS_ANDROID && android()) return studio.addPhoneScreen();
    try {
      const { audio } = await ensure();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60, width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: true,
        systemAudio: "include",
        selfBrowserSurface: "exclude",
      } as DisplayMediaStreamOptions);
      const [track] = stream.getVideoTracks();
      if (!track) return;
      const { width = 16, height = 9 } = track.getSettings();
      const id = addSource("screen", width / height);
      tracks.set(id, stream.getTracks());
      feedVideo(id, track);
      const sound = stream.getAudioTracks()[0];
      if (sound) audio.setScreen(sound);
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") fail(e);
    }
  },

  /** The phone's whole screen (Android asks the person), with other apps' sound where Android gives it. */
  async addPhoneScreen() {
    const bridge = android();
    if (!bridge) return;
    try {
      const { audio } = await ensure();
      const capture = new AndroidScreen(bridge, bridge.features?.screenAudio !== false);
      const answer = bridge.next((w) => w.ev === "screen" && w.state !== "off", 5 * 60_000);
      bridge.send({ op: "screen-start", width: 1920, height: 1080, fps: 30, audio: !!capture.audio });
      const word = await answer;
      if (!word || word.state !== "on") {
        capture.stop();
        if (word && word.state !== "denied") fail(typeof word.why === "string" ? word.why : "Android не дал экран");
        return;
      }
      const width = typeof word.width === "number" ? word.width : 16;
      const height = typeof word.height === "number" ? word.height : 9;
      const id = addSource("screen", width / height);
      tracks.set(id, [capture.video]);
      phoneScreens.set(id, capture);
      feedVideo(id, capture.video);
      if (capture.audio && word.audio === true) audio.setScreen(capture.audio);
    } catch (e) {
      fail(e);
    }
  },

  async addCamera() {
    try {
      await ensure();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
      const [track] = stream.getVideoTracks();
      if (!track) return;
      const { width = 16, height = 9 } = track.getSettings();
      const id = addSource("camera", width / height);
      tracks.set(id, [track]);
      feedVideo(id, track);
    } catch (e) {
      fail(`Камера: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  async addCharacter() {
    await ensure();
    const prefs = usePrefs.getState();
    const code = prefs.character ?? defaultAvatarFor("me");
    const id = addSource("character");
    send({ type: "character", id, code });
  },

  async addText() {
    await ensure();
    addSource("text", undefined, { text: { text: usePrefs.getState().nickname || "ХатаВойс", size: 72, color: "#ffffff", outline: 0, bold: true } });
  },

  async addColor() {
    await ensure();
    addSource("color", undefined, { color: "#1f6b4a" });
  },

  async addClock() {
    await ensure();
    addSource("clock", undefined, { text: { text: "", size: 64, color: "#ffffff", outline: 4, bold: true } });
  },

  async addImage(file: File) {
    try {
      await ensure();
      const bitmap = await createImageBitmap(file);
      const id = addSource("image", bitmap.width / bitmap.height);
      send({ type: "image", id, bitmap }, [bitmap]);
    } catch (e) {
      fail(`Картинка: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  remove(id: string) {
    setSources(get().sources.filter((s) => s.id !== id));
    pushLayout();
    // Another scene may still show it; its capture goes on until no scene does.
    if (inUse(id, get().scenes)) return;
    stopTracks(id);
    send({ type: "remove", id });
  },

  update(id: string, change: Partial<Pick<StudioSource, "rect" | "visible" | "locked" | "text" | "color" | "name">>) {
    setSources(get().sources.map((s) => (s.id === id ? { ...s, ...change } : s)));
    pushLayout();
  },

  /** A source's look: crop, opacity, filters, green screen. */
  setLook(id: string, change: Partial<SourceLook>) {
    setSources(get().sources.map((s) => (s.id === id ? { ...s, look: { ...s.look, ...change } } : s)));
    pushLayout();
  },

  setSources(sources: StudioSource[]) {
    setSources(sources);
    pushLayout();
  },

  // ---- Scenes.

  addScene() {
    const { scenes } = get();
    const id = `scene${nextId++}`;
    const scene: Scene = { id, name: `Сцена ${scenes.length + 1}`, sources: [] };
    set({ scenes: [...scenes, scene] });
    studio.switchScene(id);
  },

  /** A new scene with the same sources: the usual start for a second layout. */
  duplicateScene() {
    const { scenes, activeScene } = get();
    const source = scenes.find((s) => s.id === activeScene);
    if (!source) return;
    const id = `scene${nextId++}`;
    set({ scenes: [...scenes, { id, name: `${source.name} (копия)`, sources: source.sources.map((s) => ({ ...s })) }] });
    studio.switchScene(id);
  },

  renameScene(id: string, name: string) {
    set({ scenes: get().scenes.map((scene) => (scene.id === id ? { ...scene, name } : scene)) });
  },

  removeScene(id: string) {
    const { scenes, activeScene, editScene } = get();
    if (scenes.length <= 1) return;
    const gone = scenes.find((scene) => scene.id === id);
    const left = scenes.filter((scene) => scene.id !== id);
    const air = id === activeScene ? left[0]!.id : activeScene;
    const edit = id === editScene ? air : editScene;
    set({ scenes: left, activeScene: air, editScene: edit, sources: left.find((scene) => scene.id === edit)?.sources ?? [] });
    pushLayout(id === activeScene ? get().transition : undefined);
    for (const source of gone?.sources ?? []) {
      if (inUse(source.id, left)) continue;
      stopTracks(source.id);
      send({ type: "remove", id: source.id });
    }
  },

  /** Another scene goes on the air, through the transition chosen; in studio mode it only goes on the preview. */
  switchScene(id: string) {
    const { scenes, activeScene, editScene, transition, studioMode } = get();
    const scene = scenes.find((s) => s.id === id);
    if (!scene) return;
    if (studioMode) {
      if (id === editScene) return;
      set({ editScene: id, sources: scene.sources });
      pushLayout();
      return;
    }
    if (id === activeScene) return;
    set({ activeScene: id, editScene: id, sources: scene.sources });
    pushLayout(transition);
  },

  /** Studio mode: the scene on the preview goes on the air, through the transition chosen. */
  goLive() {
    const { activeScene, editScene, transition, studioMode } = get();
    if (!studioMode || editScene === activeScene) return;
    set({ activeScene: editScene });
    pushLayout(transition);
  },

  /** Studio mode on: the preview starts with the scene on the air. Off: the preview is the air again. */
  setStudioMode(on: boolean) {
    const { activeScene, studioMode } = get();
    if (on === studioMode) return;
    set({ studioMode: on, editScene: activeScene, sources: sourcesOf(activeScene) });
    pushLayout();
  },

  setTransition(transition: Transition) {
    set({ transition });
  },

  /** The source as big as the frame, keeping its shape. */
  fill(id: string) {
    const { output, sources } = get();
    const s = sources.find((x) => x.id === id);
    if (!s) return;
    const aspect = s.rect.width / s.rect.height;
    const width = Math.min(output.width, output.height * aspect);
    const rect: Rect = { x: Math.round((output.width - width) / 2), y: Math.round((output.height - width / aspect) / 2), width: Math.round(width), height: Math.round(width / aspect) };
    studio.update(id, { rect });
  },

  setOutput(output: Output) {
    if (get().recording) return;
    const old = get().output;
    const scale = output.width / old.width;
    const scaled = (s: StudioSource): StudioSource => ({
      ...s,
      rect: { x: Math.round(s.rect.x * scale), y: Math.round(s.rect.y * scale), width: Math.round(s.rect.width * scale), height: Math.round(s.rect.height * scale) },
    });
    const scenes = get().scenes.map((scene) => ({ ...scene, sources: scene.sources.map(scaled) }));
    set({ output, scenes, sources: scenes.find((scene) => scene.id === get().editScene)?.sources ?? [] });
    pushOutput();
    pushLayout();
  },

  async setMic(deviceId: string | null) {
    set({ micDevice: deviceId });
    try {
      await audio?.setMic(deviceId);
    } catch (e) {
      fail(`Микрофон: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Everything on the mixer. */
  setMixer(change: Partial<MixerSettings>) {
    const mixer = { ...get().mixer, ...change };
    set({ mixer });
    audio?.configure(mixer).catch(fail);
  },

  /** Keeps the last `seconds` encoded, ready to be saved at a press of a button; 0 stops that. */
  async setReplay(seconds: number) {
    set({ replaySeconds: seconds });
    await ensure();
    send({ type: "replay", seconds });
  },

  saveReplay() {
    send({ type: "replay-save" });
  },

  levels: () => audio?.levels() ?? { mic: 0, screen: 0 },

  /** Shows the frame on `canvas` (a few times a second) while the studio's page is open. */
  async attachPreview(canvas: HTMLCanvasElement | null) {
    await ensure();
    preview = canvas?.getContext("bitmaprenderer") ?? null;
    send({ type: "preview", on: !!preview });
  },

  /** Studio mode: shows the scene being prepared on `canvas`. */
  attachEditPreview(canvas: HTMLCanvasElement | null) {
    editPreview = canvas?.getContext("bitmaprenderer") ?? null;
  },

  async startRecording() {
    if (get().recording) return;
    try {
      await ensure();
      const path = await invoke<string>("studio_record_open", { stamp: stamp() });
      set({ recording: { startedAt: Date.now(), bytes: 0, path }, error: null });
      send({ type: "record", on: true });
    } catch (e) {
      fail(e);
    }
  },

  stopRecording() {
    send({ type: "record", on: false });
  },

  async snapshot() {
    await ensure();
    send({ type: "snapshot" });
  },

  /** Where the stream's packets go while it runs. */
  setPacketSink(sink: ((packet: StreamPacket) => void) | null) {
    packetSink = sink;
    send({ type: "stream", on: !!sink });
  },
};
