/**
 * Our own capture of a window or a screen (screen_capture.rs), as a video track the call can publish: Rust shrinks
 * each frame to NV12 on the video card, writes it into a slot of a WebView2 shared buffer and names the slot in a web
 * message; here the slot becomes a VideoFrame of a `MediaStreamTrackGenerator`. A slot is read only when its `seq` is
 * the same even number before and after the copy (Rust makes it odd while it writes), so a frame overtaken by the next
 * one is dropped, never torn. Windows sends a frame only when the picture changes: a still one is sent again now and
 * then, or a friend who opens it later would see nothing until it moves.
 */

/** A window or a screen picked in our own picker (`capture_sources`). */
export type OwnSource = { kind: "window" | "monitor"; id: number; title: string };

/** What Rust tells the page with the buffer. */
export type CaptureBufferInfo = { hv: "capture"; slotSize: number; slots: number };
/** A frame's slot, as Rust names it. */
export type FrameMessage = { hv: "frame"; slot: number; seq: number };

export const SLOT_HEADER = 16;
/** A still picture is sent again after this long, ms. */
export const REPEAT_MS = 500;

type SharedBufferEvent = Event & { additionalData?: unknown; getBuffer: () => ArrayBuffer };
type HostMessage = Event & { data?: unknown };
export type HostView = {
  addEventListener(type: "sharedbufferreceived" | "message", listener: (event: Event) => void): void;
  removeEventListener(type: "sharedbufferreceived" | "message", listener: (event: Event) => void): void;
};

/** WebView2's bridge to the host, where there is one (the Windows app). */
export function hostView(): HostView | null {
  return (globalThis as { chrome?: { webview?: HostView } }).chrome?.webview ?? null;
}

type VideoFrameLike = { close(): void };
export type FrameInit = {
  format: "NV12";
  codedWidth: number;
  codedHeight: number;
  timestamp: number;
  layout: { offset: number; stride: number }[];
  colorSpace: { primaries: "bt709"; transfer: "bt709"; matrix: "bt709"; fullRange: false };
};
type FrameMaker = (data: Uint8Array, init: FrameInit) => VideoFrameLike;

const makeFrame: FrameMaker = (data, init) => new VideoFrame(data, init);

/** The frame in `slot` if it is whole and still the one named; null when it was written over meanwhile. */
export function readSlot(buffer: ArrayBuffer, info: Pick<CaptureBufferInfo, "slotSize" | "slots">, message: FrameMessage, timestamp: number, make: FrameMaker = makeFrame): VideoFrameLike | null {
  if (!Number.isInteger(message.slot) || message.slot < 0 || message.slot >= info.slots || message.seq % 2 !== 0) return null;
  const at = message.slot * info.slotSize;
  if (at + info.slotSize > buffer.byteLength) return null;
  const head = new Uint32Array(buffer, at, 4);
  if (head[0] !== message.seq) return null;
  const width = head[1]!;
  const height = head[2]!;
  const stride = head[3]!;
  const bytes = (stride * height * 3) / 2;
  if (width === 0 || height === 0 || width % 2 || height % 2 || stride < width || SLOT_HEADER + bytes > info.slotSize) return null;
  const frame = make(new Uint8Array(buffer, at + SLOT_HEADER, bytes), {
    format: "NV12",
    codedWidth: width,
    codedHeight: height,
    timestamp,
    layout: [
      { offset: 0, stride },
      { offset: stride * height, stride },
    ],
    colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
  });
  if (head[0] !== message.seq) {
    frame.close();
    return null;
  }
  return frame;
}

type Generator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };

/** Whether this window can take our own capture's frames: the Windows app's WebView2 with a track generator. */
export function ownCaptureSupported(): boolean {
  return hostView() !== null && typeof (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator === "function" && typeof VideoFrame === "function";
}

/** The frames of our own capture as a video track; `stop` lets go of the buffer and ends the track. */
export class OwnCaptureTrack {
  readonly track: MediaStreamTrack;
  private readonly writer: WritableStreamDefaultWriter<VideoFrame>;
  private buffer: ArrayBuffer | null = null;
  private info: CaptureBufferInfo | null = null;
  /** The last frame sent, kept to send again while the picture stands still. */
  private last: VideoFrame | null = null;
  private lastAt = 0;
  private readonly repeat: ReturnType<typeof setInterval>;
  readonly counts = { shown: 0, torn: 0, late: 0, repeated: 0 };

  constructor(private readonly view: HostView) {
    const Maker = (globalThis as unknown as { MediaStreamTrackGenerator: new (init: { kind: "video" }) => Generator }).MediaStreamTrackGenerator;
    const generator = new Maker({ kind: "video" });
    this.track = generator;
    this.writer = generator.writable.getWriter();
    view.addEventListener("sharedbufferreceived", this.onBuffer);
    view.addEventListener("message", this.onMessage);
    this.repeat = setInterval(this.again, REPEAT_MS);
  }

  private readonly onBuffer = (event: Event) => {
    const e = event as SharedBufferEvent;
    const extra = e.additionalData as Partial<CaptureBufferInfo> | undefined;
    if (extra?.hv !== "capture") return;
    this.buffer = e.getBuffer();
    this.info = extra as CaptureBufferInfo;
  };

  private send(frame: VideoFrame) {
    this.last?.close();
    this.last = frame.clone();
    this.lastAt = performance.now();
    void this.writer.write(frame).catch(() => frame.close());
  }

  private readonly onMessage = (event: Event) => {
    const data = (event as HostMessage).data as Partial<FrameMessage> | undefined;
    if (data?.hv !== "frame" || !this.buffer || !this.info) return;
    // The encoder is behind: this frame waits for nobody, the next one will do.
    if (this.writer.desiredSize !== null && this.writer.desiredSize <= 0) {
      this.counts.late++;
      return;
    }
    const frame = readSlot(this.buffer, this.info, data as FrameMessage, Math.round(performance.now() * 1000));
    if (!frame) {
      this.counts.torn++;
      return;
    }
    this.counts.shown++;
    this.send(frame as VideoFrame);
  };

  private readonly again = () => {
    if (!this.last || performance.now() - this.lastAt < REPEAT_MS) return;
    const frame = new VideoFrame(this.last, { timestamp: Math.round(performance.now() * 1000) });
    this.counts.repeated++;
    this.send(frame);
  };

  stop() {
    clearInterval(this.repeat);
    this.view.removeEventListener("sharedbufferreceived", this.onBuffer);
    this.view.removeEventListener("message", this.onMessage);
    this.buffer = null;
    this.last?.close();
    this.last = null;
    void this.writer.close().catch(() => {});
    this.track.stop();
  }
}

/** What Rust tells the page with the sound's buffer. */
/** Rust's capture lanes (`screen_audio::Lane`): a shared screen's sound, and music played together. */
export type AudioLane = "audio" | "music";
export type AudioBufferInfo = { hv: AudioLane; slotSize: number; slots: number; rate: number; channels: number };
export type AudioMessage = { hv: AudioLane; slot: number; seq: number };
export const AUDIO_HEADER = 16;

type AudioDataLike = { close(): void };
export type AudioInit = { format: "f32"; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: Float32Array<ArrayBuffer> };
type AudioMaker = (init: AudioInit) => AudioDataLike;
const makeAudio: AudioMaker = (init) => new AudioData(init);

/** The packet in `slot` (interleaved float frames) if it is whole and still the one named. */
export function readAudioSlot(
  buffer: ArrayBuffer,
  info: Pick<AudioBufferInfo, "slotSize" | "slots" | "rate" | "channels">,
  message: AudioMessage,
  timestamp: number,
  make: AudioMaker = makeAudio,
  gain = 1,
): AudioDataLike | null {
  if (!Number.isInteger(message.slot) || message.slot < 0 || message.slot >= info.slots || message.seq % 2 !== 0) return null;
  const at = message.slot * info.slotSize;
  if (at + info.slotSize > buffer.byteLength) return null;
  const head = new Uint32Array(buffer, at, 2);
  if (head[0] !== message.seq) return null;
  const frames = head[1]!;
  if (frames === 0 || AUDIO_HEADER + frames * info.channels * 4 > info.slotSize) return null;
  // A copy: the slot is written again while the data travels on.
  const data = new Float32Array(buffer.slice(at + AUDIO_HEADER, at + AUDIO_HEADER + frames * info.channels * 4));
  if (head[0] !== message.seq) return null;
  // Louder or quieter (the music's «Громкость для всех»), never past full scale.
  if (gain !== 1) for (let i = 0; i < data.length; i++) data[i] = Math.max(-1, Math.min(1, data[i]! * gain));
  return make({ format: "f32", sampleRate: info.rate, numberOfFrames: frames, numberOfChannels: info.channels, timestamp, data });
}

type AudioGenerator = MediaStreamTrack & { writable: WritableStream<AudioData> };

/** The sound of our own capture as an audio track, its time counted in samples from the first packet. */
export class OwnAudioTrack {
  readonly track: MediaStreamTrack;
  private readonly writer: WritableStreamDefaultWriter<AudioData>;
  private buffer: ArrayBuffer | null = null;
  private info: AudioBufferInfo | null = null;
  /** Microseconds of the next packet; a gap longer than a moment starts the count again from the clock. */
  private next = 0;
  readonly counts = { packets: 0, torn: 0 };
  /** How loud the sound goes out: 1 as it is. */
  gain = 1;

  constructor(
    private readonly view: HostView,
    private readonly lane: AudioLane = "audio",
  ) {
    const Maker = (globalThis as unknown as { MediaStreamTrackGenerator: new (init: { kind: "audio" }) => AudioGenerator }).MediaStreamTrackGenerator;
    const generator = new Maker({ kind: "audio" });
    this.track = generator;
    this.writer = generator.writable.getWriter();
    view.addEventListener("sharedbufferreceived", this.onBuffer);
    view.addEventListener("message", this.onMessage);
  }

  private readonly onBuffer = (event: Event) => {
    const e = event as SharedBufferEvent;
    const extra = e.additionalData as Partial<AudioBufferInfo> | undefined;
    if (extra?.hv !== this.lane) return;
    this.buffer = e.getBuffer();
    this.info = extra as AudioBufferInfo;
  };

  private readonly onMessage = (event: Event) => {
    const data = (event as HostMessage).data as Partial<AudioMessage> | undefined;
    if (data?.hv !== this.lane || !this.buffer || !this.info) return;
    const now = Math.round(performance.now() * 1000);
    if (Math.abs(now - this.next) > 200_000) this.next = now;
    const packet = readAudioSlot(this.buffer, this.info, data as AudioMessage, this.next, makeAudio, this.gain);
    if (!packet) {
      this.counts.torn++;
      return;
    }
    this.counts.packets++;
    const frames = (packet as unknown as { numberOfFrames?: number }).numberOfFrames ?? 0;
    this.next += Math.round((frames * 1_000_000) / this.info.rate);
    void this.writer.write(packet as AudioData).catch(() => packet.close());
  };

  stop() {
    this.view.removeEventListener("sharedbufferreceived", this.onBuffer);
    this.view.removeEventListener("message", this.onMessage);
    this.buffer = null;
    void this.writer.close().catch(() => {});
    this.track.stop();
  }
}
