/**
 * The studio's compositor, in a worker of its own: it draws the sources into the frame on its own clock (the window
 * may be hidden behind a game or minimized), encodes the frame and the sound with WebCodecs (H.264 and AAC), and
 * feeds an MP4 file (Mediabunny, fragmented) and the stream with the same packets.
 */
import { av1Config } from "./av1";
import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from "mediabunny";
import type { CharacterScene } from "../characters/scene";
import { DEFAULT_CHARACTER, parseCharacter } from "../characters/character";
import { parseAvatar } from "../characters/gallery";
import { DEFAULT_LOOK, type SourceLook, type Transition } from "./layout";
import { chromaKey } from "./chroma";
import type { DrawnSource, EncoderOptions, FromWorker, ToWorker } from "./protocol";

// The worker's own scope, typed as the other end of a Worker (the program is typed with the DOM library).
const scope = self as unknown as Worker;

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** A preview every this many frames (about 15 a second at 60). */
const PREVIEW_EVERY_MS = 66;

const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

let output: EncoderOptions = {
  width: 1920,
  height: 1080,
  fps: 60,
  bitrate: 9_300_000,
  codec: "avc1.64002a",
  bitrateMode: "constant",
  keyEveryUs: 2_000_000,
  hardware: "no-preference",
  latency: "quality",
  audioBitrate: 160_000,
};
const canvas = new OffscreenCanvas(output.width, output.height);
const mainCtx = canvas.getContext("2d", { alpha: false })!;
/** Where sources are drawn: the frame, or for a moment the studio mode's preview. */
let ctx: OffscreenCanvasRenderingContext2D = mainCtx;
/** Studio mode: the scene being prepared, drawn small and only when its preview is due. */
const EDIT_WIDTH = 960;
const editCanvas = new OffscreenCanvas(EDIT_WIDTH, 540);
const editCtx = editCanvas.getContext("2d", { alpha: false })!;
let editSources: DrawnSource[] | null = null;
/** Which tick is being drawn: a character shown in both scenes is rendered once a tick. */
let tickNumber = 0;
let sources: DrawnSource[] = [];
const frames = new Map<string, VideoFrame>();
const images = new Map<string, ImageBitmap>();
const characters = new Map<string, { scene: CharacterScene; canvas: OffscreenCanvas; code: string; tick: number }>();
let level = 0;
const epoch = performance.now();
const now = () => (performance.now() - epoch) * 1000;

// What reads each video source: the newest frame is kept, the older one let go of.
async function readFrames(id: string, readable: ReadableStream<VideoFrame>) {
  const reader = readable.getReader();
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
    if (done || !value) break;
    frames.get(id)?.close();
    frames.set(id, value);
  }
  frames.get(id)?.close();
  frames.delete(id);
}

/** Our character on the frame: a figure from code, or a model that the scene loads by itself. */
function studioMember(id: string, code: string, level: number, speaking: boolean) {
  const built = parseCharacter(code);
  return { id, name: "", character: built ?? DEFAULT_CHARACTER, ...(built ? {} : { avatar: code }), level, speaking };
}

async function addCharacter(id: string, code: string) {
  if (!parseCharacter(code) && !parseAvatar(code)) return;
  const { CharacterScene } = await import("../characters/scene");
  const surface = new OffscreenCanvas(480, 600);
  const scene = new CharacterScene(surface, { transparent: true, preview: true, manual: true });
  scene.setMembers([studioMember(id, code, 0, false)]);
  characters.get(id)?.scene.dispose();
  characters.set(id, { scene, canvas: surface, code, tick: -1 });
}

function remove(id: string) {
  frames.get(id)?.close();
  frames.delete(id);
  images.get(id)?.close();
  images.delete(id);
  characters.get(id)?.scene.dispose();
  characters.delete(id);
}

/** The time as a clock shows it. */
function clockText(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function drawText(source: DrawnSource, content: string) {
  const style = source.text;
  if (!style || !content) return;
  const { width, height } = source.rect;
  const size = Math.max(8, Math.min(style.size, height));
  ctx.font = `${style.bold ? 700 : 500} ${size}px "Segoe UI Variable Display", "Segoe UI", sans-serif`;
  ctx.textBaseline = "middle";
  if (style.outline > 0) {
    ctx.lineWidth = style.outline;
    ctx.strokeStyle = "#000";
    ctx.lineJoin = "round";
    ctx.strokeText(content, 0, height / 2, width);
  } else {
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = size * 0.12;
  }
  ctx.fillStyle = style.color;
  ctx.fillText(content, 0, height / 2, width);
}

/** The filters of a source as canvas understands them; none means no work at all. */
function filterOf(look: SourceLook): string {
  const parts: string[] = [];
  if (look.brightness !== 100) parts.push(`brightness(${look.brightness}%)`);
  if (look.contrast !== 100) parts.push(`contrast(${look.contrast}%)`);
  if (look.saturate !== 100) parts.push(`saturate(${look.saturate}%)`);
  if (look.blur > 0) parts.push(`blur(${look.blur}px)`);
  return parts.length ? parts.join(" ") : "none";
}

/** A picture with its crop, into the source's rectangle (the canvas is already at its corner). */
function drawPicture(image: CanvasImageSource, naturalWidth: number, naturalHeight: number, look: SourceLook, width: number, height: number) {
  const { left, top, right, bottom } = look.crop;
  const sw = naturalWidth * Math.max(0.01, 1 - left - right);
  const sh = naturalHeight * Math.max(0.01, 1 - top - bottom);
  ctx.drawImage(image, naturalWidth * left, naturalHeight * top, sw, sh, 0, 0, width, height);
}

function drawSource(source: DrawnSource, time: number, alpha: number) {
  if (!source.visible) return;
  const look = source.look ?? DEFAULT_LOOK;
  const { x, y, width, height } = source.rect;
  ctx.save();
  ctx.globalAlpha = alpha * look.opacity;
  ctx.translate(x + width / 2, y + height / 2);
  if (look.rotate) ctx.rotate((look.rotate * Math.PI) / 180);
  if (look.flip) ctx.scale(-1, 1);
  ctx.translate(-width / 2, -height / 2);
  const filter = filterOf(look);
  if (filter !== "none") ctx.filter = filter;
  if (look.radius > 0) {
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, look.radius);
    ctx.clip();
  }
  switch (source.kind) {
    case "screen":
    case "camera": {
      const frame = frames.get(source.id);
      if (!frame) break;
      if (look.chroma) drawPicture(chromaKey(frame, look.chroma), frame.displayWidth, frame.displayHeight, look, width, height);
      else drawPicture(frame, frame.displayWidth, frame.displayHeight, look, width, height);
      break;
    }
    case "image": {
      const bitmap = images.get(source.id);
      if (bitmap) drawPicture(bitmap, bitmap.width, bitmap.height, look, width, height);
      break;
    }
    case "color":
      ctx.fillStyle = source.color ?? "#000000";
      ctx.fillRect(0, 0, width, height);
      break;
    case "text":
      drawText(source, source.text?.text ?? "");
      break;
    case "clock":
      drawText(source, clockText());
      break;
    case "character": {
      const character = characters.get(source.id);
      if (!character) break;
      // Drawn at the size it takes in the frame, but never bigger than needed; once a tick, whichever scene shows it.
      if (character.tick !== tickNumber) {
        const w = Math.min(Math.round(width), 960);
        const h = Math.max(1, Math.round((w * height) / width));
        if (character.canvas.width !== w || character.canvas.height !== h) character.scene.setSize(w, h);
        const speaking = level > 0.04;
        character.scene.setMembers([studioMember(source.id, character.code, level, speaking)]);
        character.scene.renderAt(time);
        character.tick = tickNumber;
      }
      ctx.drawImage(character.canvas, 0, 0, width, height);
      break;
    }
  }
  ctx.restore();
}

/** The sources before a scene changed, while the new ones take over. */
let leaving: { sources: DrawnSource[]; transition: Transition; startedAt: number } | null = null;

function draw(time: number) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const change = leaving;
  if (!change) {
    for (const source of sources) drawSource(source, time, 1);
    return;
  }
  const p = Math.min(1, (performance.now() - change.startedAt) / change.transition.ms);
  const eased = p * p * (3 - 2 * p);
  if (change.transition.kind === "slide") {
    ctx.save();
    ctx.translate(-eased * canvas.width, 0);
    for (const source of change.sources) drawSource(source, time, 1);
    ctx.translate(canvas.width, 0);
    for (const source of sources) drawSource(source, time, 1);
    ctx.restore();
  } else {
    for (const source of change.sources) drawSource(source, time, 1);
    for (const source of sources) drawSource(source, time, eased);
  }
  if (p >= 1) leaving = null;
}

/** The scene being prepared, on its own small canvas: the same drawing, scaled down. */
function drawEdit(time: number, list: DrawnSource[]) {
  const scale = EDIT_WIDTH / canvas.width;
  const height = Math.max(1, Math.round(canvas.height * scale));
  if (editCanvas.height !== height) editCanvas.height = height;
  ctx = editCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, editCanvas.width, editCanvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  try {
    for (const source of list) drawSource(source, time, 1);
  } finally {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx = mainCtx;
  }
}

// ---- Encoding: one video and one audio encoder for every output at once.

type Sink = { base: number | null; videoConfig: boolean; audioConfig: boolean };
type FileSink = Sink & { output: Output; video: EncodedVideoPacketSource; audio: EncodedAudioPacketSource; queue: Promise<void> };

let videoEncoder: VideoEncoder | null = null;
let audioEncoder: AudioEncoder | null = null;
let videoConfig: VideoDecoderConfig | null = null;
let audioConfig: AudioDecoderConfig | null = null;
let file: FileSink | null = null;
let stream: Sink | null = null;
let lastKey = -Infinity;
let wantKey = false;
let audioStart: number | null = null;
let audioSamples = 0;
let dropped = 0;

let replaySeconds = 0;
type Kept = { kind: "video" | "audio"; data: Uint8Array<ArrayBuffer>; timestamp: number; duration: number; key: boolean };
let kept: Kept[] = [];
let encodedBytes = 0;

const encoding = () => !!file || !!stream || replaySeconds > 0;

/** What was encoded of the last few seconds: from a key frame on, so that a clip can start with it. */
function keep(item: Kept) {
  kept.push(item);
  const limit = item.timestamp - replaySeconds * 1e6;
  let cut = -1;
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i]!;
    if (k.timestamp > limit) break;
    if (k.kind === "video" && k.key) cut = i;
  }
  if (cut > 0) kept = kept.slice(cut);
}

/** The kept seconds as an MP4 of their own. */
async function saveClip(): Promise<Uint8Array<ArrayBuffer> | null> {
  const start = kept.find((k) => k.kind === "video" && k.key);
  if (!start || !videoConfig || !audioConfig) return null;
  const target = new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const video = new EncodedVideoPacketSource(isAv1() ? "av1" : "avc");
  const audio = new EncodedAudioPacketSource("aac");
  out.addVideoTrack(video, { frameRate: output.fps });
  out.addAudioTrack(audio);
  await out.start();
  const [videoMeta, audioMeta] = [{ decoderConfig: videoConfig }, { decoderConfig: audioConfig }];
  let firstVideo = true;
  let firstAudio = true;
  for (const item of kept.slice()) {
    if (item.timestamp < start.timestamp) continue;
    const packet = new EncodedPacket(item.data, item.key ? "key" : "delta", (item.timestamp - start.timestamp) / 1e6, item.duration / 1e6);
    if (item.kind === "video") {
      await video.add(packet, firstVideo ? videoMeta : undefined);
      firstVideo = false;
    } else {
      await audio.add(packet, firstAudio ? audioMeta : undefined);
      firstAudio = false;
    }
  }
  await out.finalize();
  return target.buffer ? new Uint8Array(target.buffer as ArrayBuffer) : null;
}
/** A copy of a decoder config's bytes (avcC, AudioSpecificConfig). */
function bytes(data: AllowSharedBufferSource | undefined): Uint8Array<ArrayBuffer> | undefined {
  if (!data) return undefined;
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  const view = data as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

/** The encoders make AV1, not H.264. */
const isAv1 = () => output.codec.startsWith("av01");

function startEncoders() {
  if (videoEncoder) return;
  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) videoConfig = meta.decoderConfig;
      takeVideo(chunk);
    },
    error: (e) => post({ type: "error", message: `Видео: ${e.message}` }),
  });
  videoEncoder.configure({
    codec: output.codec,
    width: output.width,
    height: output.height,
    bitrate: output.bitrate,
    framerate: output.fps,
    bitrateMode: output.bitrateMode,
    hardwareAcceleration: output.hardware,
    latencyMode: output.latency,
    ...(isAv1() ? {} : { avc: { format: "avc" as const } }),
  });
  audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) audioConfig = meta.decoderConfig;
      takeAudio(chunk);
    },
    error: (e) => post({ type: "error", message: `Звук: ${e.message}` }),
  });
  audioEncoder.configure({ codec: "mp4a.40.2", sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate: output.audioBitrate });
  audioStart = null;
  audioSamples = 0;
  wantKey = true;
}

async function stopEncoders() {
  if (encoding() || !videoEncoder) return;
  const [video, audio] = [videoEncoder, audioEncoder];
  videoEncoder = null;
  audioEncoder = null;
  videoConfig = null;
  audioConfig = null;
  await Promise.allSettled([video.flush(), audio?.flush()]);
  video.close();
  audio?.close();
}

function takeVideo(chunk: EncodedVideoChunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const key = chunk.type === "key";
  encodedBytes += data.byteLength;
  if (replaySeconds > 0) keep({ kind: "video", data: data.slice(), timestamp: chunk.timestamp, duration: chunk.duration ?? 1e6 / output.fps, key });
  for (const sink of [file, stream]) {
    if (!sink) continue;
    if (sink.base === null) {
      if (!key) continue;
      sink.base = chunk.timestamp;
    }
  }
  if (file && file.base !== null) {
    const sink = file;
    const meta = !sink.videoConfig && videoConfig ? { decoderConfig: videoConfig } : undefined;
    sink.videoConfig = sink.videoConfig || !!meta;
    const packet = new EncodedPacket(data, key ? "key" : "delta", (chunk.timestamp - sink.base!) / 1e6, (chunk.duration ?? 1e6 / output.fps) / 1e6);
    sink.queue = sink.queue.then(() => sink.video.add(packet, meta)).catch((e) => post({ type: "error", message: String(e) }));
  }
  if (stream && stream.base !== null) {
    // AV1 comes with no description: its av1C is made from the codec string and the first key frame.
    const description = isAv1() ? (key ? av1Config(output.codec, data) : undefined) : videoConfig?.description ? bytes(videoConfig.description) : undefined;
    const config = !stream.videoConfig ? description : undefined;
    if (config) stream.videoConfig = true;
    if (stream.videoConfig) post({ type: "packet", packet: { kind: "video", data, timestamp: chunk.timestamp - stream.base, key, config } }, [data.buffer]);
  }
}

function takeAudio(chunk: EncodedAudioChunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  if (replaySeconds > 0) keep({ kind: "audio", data: data.slice(), timestamp: chunk.timestamp, duration: chunk.duration ?? 0, key: true });
  if (file && file.base !== null && chunk.timestamp >= file.base) {
    const sink = file;
    const meta = !sink.audioConfig && audioConfig ? { decoderConfig: audioConfig } : undefined;
    sink.audioConfig = sink.audioConfig || !!meta;
    const packet = new EncodedPacket(data.slice(), "key", (chunk.timestamp - sink.base!) / 1e6, (chunk.duration ?? 0) / 1e6);
    sink.queue = sink.queue.then(() => sink.audio.add(packet, meta)).catch((e) => post({ type: "error", message: String(e) }));
  }
  if (stream && stream.base !== null && stream.videoConfig && chunk.timestamp >= stream.base) {
    const config = !stream.audioConfig && audioConfig?.description ? bytes(audioConfig.description) : undefined;
    if (config) stream.audioConfig = true;
    if (stream.audioConfig) post({ type: "packet", packet: { kind: "audio", data, timestamp: chunk.timestamp - stream.base, key: true, config } }, [data.buffer]);
  }
}

function encodeFrame(time: number) {
  if (!videoEncoder || videoEncoder.state !== "configured") return;
  if (videoEncoder.encodeQueueSize > 3) {
    dropped++;
    return;
  }
  const frame = new VideoFrame(canvas, { timestamp: Math.round(time), duration: Math.round(1e6 / output.fps) });
  const key = wantKey || time - lastKey >= output.keyEveryUs;
  if (key) {
    lastKey = time;
    wantKey = false;
  }
  videoEncoder.encode(frame, { keyFrame: key });
  frame.close();
}

// The mixed sound: every piece gets a time by the count of samples since encoding began, on the video's clock.
async function readAudio(readable: ReadableStream<AudioData>) {
  const reader = readable.getReader();
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
    if (done || !value) break;
    if (!audioEncoder || audioEncoder.state !== "configured" || value.sampleRate !== SAMPLE_RATE) {
      value.close();
      continue;
    }
    if (audioStart === null) audioStart = now();
    const frames = value.numberOfFrames;
    const planes = new Float32Array(frames * CHANNELS);
    for (let c = 0; c < CHANNELS; c++) {
      const plane = planes.subarray(c * frames, (c + 1) * frames);
      value.copyTo(plane, { planeIndex: Math.min(c, value.numberOfChannels - 1), format: "f32-planar" });
    }
    const timestamp = Math.round(audioStart + (audioSamples * 1e6) / SAMPLE_RATE);
    audioSamples += frames;
    value.close();
    const data = new AudioData({ format: "f32-planar", sampleRate: SAMPLE_RATE, numberOfFrames: frames, numberOfChannels: CHANNELS, timestamp, data: planes });
    audioEncoder.encode(data);
    data.close();
  }
}

async function startFile() {
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      // A copy: the muxer may reuse its buffer.
      const data = chunk.data.slice();
      post({ type: "file", data, position: chunk.position }, [data.buffer]);
    },
  });
  const target = new Output({ format: new Mp4OutputFormat({ fastStart: "fragmented" }), target: new StreamTarget(writable) });
  const video = new EncodedVideoPacketSource(isAv1() ? "av1" : "avc");
  const audio = new EncodedAudioPacketSource("aac");
  target.addVideoTrack(video, { frameRate: output.fps });
  target.addAudioTrack(audio);
  await target.start();
  file = { output: target, video, audio, base: null, videoConfig: false, audioConfig: false, queue: Promise.resolve() };
  startEncoders();
  wantKey = true;
}

async function stopFile() {
  const sink = file;
  if (!sink) return;
  file = null;
  await sink.queue;
  if (sink.videoConfig) await sink.output.finalize().catch((e) => post({ type: "error", message: String(e) }));
  else await sink.output.cancel();
  await stopEncoders();
  post({ type: "recorded" });
}

// ---- The clock.

let previewing = false;
let previewBusy = false;
let editBusy = false;
let lastPreview = 0;
let lastEdit = 0;
let next = performance.now();
let shown = 0;
let lastStats = performance.now();

let renderTotal = 0;

function tick() {
  const time = now();
  const before = performance.now();
  tickNumber++;
  draw(before);
  renderTotal += performance.now() - before;
  if (encoding()) encodeFrame(time);
  const wall = performance.now();
  if (previewing && !previewBusy && wall - lastPreview >= PREVIEW_EVERY_MS) {
    previewBusy = true;
    lastPreview = wall;
    void createImageBitmap(canvas, { resizeWidth: 960, resizeHeight: Math.round((960 * canvas.height) / canvas.width), resizeQuality: "low" })
      .then((bitmap) => post({ type: "preview", bitmap }, [bitmap]))
      .catch(() => (previewBusy = false));
  }
  if (previewing && editSources && !editBusy && wall - lastEdit >= PREVIEW_EVERY_MS) {
    editBusy = true;
    lastEdit = wall;
    drawEdit(before, editSources);
    void createImageBitmap(editCanvas)
      .then((bitmap) => post({ type: "preview", bitmap, edit: true }, [bitmap]))
      .catch(() => (editBusy = false));
  }
  shown++;
  if (wall - lastStats >= 1000) {
    const seconds = (wall - lastStats) / 1000;
    post({
      type: "stats",
      fps: Math.round(shown / seconds),
      dropped,
      queue: videoEncoder?.encodeQueueSize ?? 0,
      renderMs: Math.round((renderTotal / Math.max(1, shown)) * 10) / 10,
      kbps: Math.round((encodedBytes * 8) / 1000 / seconds),
    });
    shown = 0;
    renderTotal = 0;
    encodedBytes = 0;
    lastStats = wall;
  }
  // Steady frames: the next one at its time, not a whole period after this one ran.
  next += 1000 / output.fps;
  if (next < wall - 250) next = wall;
  setTimeout(tick, Math.max(0, next - performance.now()));
}
setTimeout(tick, 0);

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "output":
      if (encoding()) return;
      output = message;
      canvas.width = output.width;
      canvas.height = output.height;
      break;
    case "video":
      void readFrames(message.id, message.readable);
      break;
    case "image":
      images.get(message.id)?.close();
      images.set(message.id, message.bitmap);
      break;
    case "character":
      void addCharacter(message.id, message.code);
      break;
    case "level":
      message.port.onmessage = (e: MessageEvent<number>) => (level = e.data);
      break;
    case "audio":
      void readAudio(message.readable);
      break;
    case "remove":
      remove(message.id);
      break;
    case "layout":
      if (message.transition && message.transition.kind !== "cut" && message.transition.ms > 0) {
        leaving = { sources, transition: message.transition, startedAt: performance.now() };
      }
      sources = message.sources;
      break;
    case "preview":
      previewing = message.on;
      break;
    case "preview-done":
      if (message.edit) editBusy = false;
      else previewBusy = false;
      break;
    case "edit":
      editSources = message.sources;
      break;
    case "record":
      if (message.on && !file) void startFile().catch((e) => post({ type: "error", message: String(e) }));
      if (!message.on) void stopFile();
      break;
    case "stream":
      if (message.on && !stream) {
        stream = { base: null, videoConfig: false, audioConfig: false };
        startEncoders();
        wantKey = true;
      }
      if (!message.on && stream) {
        stream = null;
        void stopEncoders();
      }
      break;
    case "replay": {
      const was = encoding();
      replaySeconds = message.seconds;
      if (!replaySeconds) kept = [];
      if (encoding() && !was) {
        startEncoders();
        wantKey = true;
      } else if (!encoding() && was) {
        void stopEncoders();
      }
      break;
    }
    case "replay-save":
      void saveClip()
        .then((data) => post({ type: "clip", data }, data ? [data.buffer] : []))
        .catch((e) => post({ type: "error", message: String(e) }));
      break;
    case "snapshot":
      void canvas
        .convertToBlob({ type: "image/png" })
        .then((blob) => blob.arrayBuffer())
        .then((buffer) => post({ type: "snapshot", data: new Uint8Array(buffer) }, [buffer]));
      break;
  }
};
