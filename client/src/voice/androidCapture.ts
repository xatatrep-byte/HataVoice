/**
 * The phone's screen as a call's tracks: Android (`ScreenCapture.kt`) sends each new picture as an I420 frame and other
 * apps' sound as float packets; here they become a video and an audio track that go out encrypted with the call's keys,
 * like a PC's screen. A packet starts with four little-endian u32: kind (1 picture, 2 sound), then the picture's width,
 * height and 0, or the sound's frames, rate and channels.
 */
import type { AndroidBridge } from "../platform/android";

export const PACKET_HEADER = 16;
export const KIND_PICTURE = 1;
export const KIND_SOUND = 2;
/** A still picture goes again after this long, ms, so a friend who opens it later sees it at once. */
export const REPEAT_MS = 500;

export type PicturePacket = { kind: typeof KIND_PICTURE; width: number; height: number; data: Uint8Array<ArrayBuffer> };
export type SoundPacket = { kind: typeof KIND_SOUND; frames: number; rate: number; channels: number; data: Float32Array<ArrayBuffer> };

/** What a packet from Android holds, if it is whole and sane. */
export function readPacket(buffer: ArrayBuffer): PicturePacket | SoundPacket | null {
  if (buffer.byteLength < PACKET_HEADER) return null;
  const head = new DataView(buffer, 0, PACKET_HEADER);
  const kind = head.getUint32(0, true);
  if (kind === KIND_PICTURE) {
    const width = head.getUint32(4, true);
    const height = head.getUint32(8, true);
    if (width < 2 || height < 2 || width > 8192 || height > 8192 || width % 2 || height % 2) return null;
    const bytes = (width * height * 3) / 2;
    if (buffer.byteLength !== PACKET_HEADER + bytes) return null;
    return { kind, width, height, data: new Uint8Array(buffer, PACKET_HEADER, bytes) };
  }
  if (kind === KIND_SOUND) {
    const frames = head.getUint32(4, true);
    const rate = head.getUint32(8, true);
    const channels = head.getUint32(12, true);
    if (frames === 0 || frames > 48_000 || rate < 8000 || rate > 192_000 || channels < 1 || channels > 2) return null;
    if (buffer.byteLength !== PACKET_HEADER + frames * channels * 4) return null;
    return { kind, frames, rate, channels, data: new Float32Array(buffer.slice(PACKET_HEADER)) };
  }
  return null;
}

/** The frame's layout for `VideoFrame`: three planes one after another. */
export function i420Layout(width: number, height: number) {
  const y = width * height;
  const c = (width / 2) * (height / 2);
  return [
    { offset: 0, stride: width },
    { offset: y, stride: width / 2 },
    { offset: y + c, stride: width / 2 },
  ];
}

type Generator<T> = MediaStreamTrack & { writable: WritableStream<T> };
type GeneratorMaker = new <T>(init: { kind: "video" | "audio" }) => Generator<T>;

function generatorMaker(): GeneratorMaker | null {
  const Maker = (globalThis as { MediaStreamTrackGenerator?: GeneratorMaker }).MediaStreamTrackGenerator;
  return typeof Maker === "function" ? Maker : null;
}

/** Whether this WebView can make tracks of Android's frames. */
export function androidCaptureSupported(): boolean {
  return typeof VideoFrame === "function";
}

/**
 * The tracks of the phone's screen while Android sends it. Where WebView has track generators, frames go straight in;
 * an older one draws them on a canvas and plays the sound through Web Audio instead.
 */
export class AndroidScreen {
  readonly video: MediaStreamTrack;
  readonly audio: MediaStreamTrack | null;
  private readonly offBytes: () => void;
  private videoWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private audioWriter: WritableStreamDefaultWriter<AudioData> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sound: { context: AudioContext; out: MediaStreamAudioDestinationNode; at: number } | null = null;
  private last: VideoFrame | null = null;
  private lastAt = 0;
  private nextSound = 0;
  private readonly repeat: ReturnType<typeof setInterval>;
  readonly counts = { pictures: 0, late: 0, sounds: 0 };

  constructor(bridge: AndroidBridge, withSound: boolean) {
    const Maker = generatorMaker();
    if (Maker) {
      const video = new Maker<VideoFrame>({ kind: "video" });
      this.video = video;
      this.videoWriter = video.writable.getWriter();
      if (withSound && typeof AudioData === "function") {
        const audio = new Maker<AudioData>({ kind: "audio" });
        this.audio = audio;
        this.audioWriter = audio.writable.getWriter();
      } else this.audio = null;
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      this.canvas = canvas;
      this.video = canvas.captureStream(0).getVideoTracks()[0]!;
      if (withSound) {
        const context = new AudioContext({ sampleRate: 48_000 });
        const out = context.createMediaStreamDestination();
        this.sound = { context, out, at: 0 };
        this.audio = out.stream.getAudioTracks()[0] ?? null;
      } else this.audio = null;
    }
    this.offBytes = bridge.onBytes(this.onBytes);
    this.repeat = setInterval(this.again, REPEAT_MS);
  }

  private readonly onBytes = (buffer: ArrayBuffer) => {
    const packet = readPacket(buffer);
    if (!packet) return;
    if (packet.kind === KIND_PICTURE) this.picture(packet);
    else this.soundPacket(packet);
  };

  private picture(packet: PicturePacket) {
    const writer = this.videoWriter;
    if (writer && writer.desiredSize !== null && writer.desiredSize <= 0) {
      this.counts.late++;
      return;
    }
    const frame = new VideoFrame(packet.data, {
      format: "I420",
      codedWidth: packet.width,
      codedHeight: packet.height,
      timestamp: Math.round(performance.now() * 1000),
      layout: i420Layout(packet.width, packet.height),
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    });
    this.counts.pictures++;
    this.show(frame);
  }

  private show(frame: VideoFrame) {
    this.last?.close();
    this.last = frame.clone();
    this.lastAt = performance.now();
    if (this.videoWriter) {
      void this.videoWriter.write(frame).catch(() => frame.close());
      return;
    }
    const canvas = this.canvas!;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    canvas.getContext("2d")?.drawImage(frame, 0, 0);
    frame.close();
    (this.video as MediaStreamTrack & { requestFrame?: () => void }).requestFrame?.();
  }

  private readonly again = () => {
    if (!this.last || performance.now() - this.lastAt < REPEAT_MS) return;
    this.show(new VideoFrame(this.last, { timestamp: Math.round(performance.now() * 1000) }));
  };

  private soundPacket(packet: SoundPacket) {
    this.counts.sounds++;
    if (this.audioWriter) {
      const now = Math.round(performance.now() * 1000);
      if (Math.abs(now - this.nextSound) > 200_000) this.nextSound = now;
      const data = new AudioData({ format: "f32", sampleRate: packet.rate, numberOfFrames: packet.frames, numberOfChannels: packet.channels, timestamp: this.nextSound, data: packet.data });
      this.nextSound += Math.round((packet.frames * 1_000_000) / packet.rate);
      void this.audioWriter.write(data).catch(() => data.close());
      return;
    }
    const sound = this.sound;
    if (!sound) return;
    const { context } = sound;
    const buffer = context.createBuffer(packet.channels, packet.frames, packet.rate);
    for (let ch = 0; ch < packet.channels; ch++) {
      const channel = buffer.getChannelData(ch);
      for (let i = 0; i < packet.frames; i++) channel[i] = packet.data[i * packet.channels + ch]!;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(sound.out);
    // A little ahead of now, so packets that come unevenly still play one after another.
    const start = Math.max(sound.at, context.currentTime + 0.06);
    source.start(start);
    sound.at = start + buffer.duration;
  }

  stop() {
    clearInterval(this.repeat);
    this.offBytes();
    this.last?.close();
    this.last = null;
    void this.videoWriter?.close().catch(() => {});
    void this.audioWriter?.close().catch(() => {});
    void this.sound?.context.close().catch(() => {});
    this.video.stop();
    this.audio?.stop();
  }
}
