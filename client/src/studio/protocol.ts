import type { Rect, SourceKind, SourceLook, TextStyle, Transition } from "./layout";

/** A source as the compositor draws it. */
export type DrawnSource = { id: string; kind: SourceKind; rect: Rect; visible: boolean; look: SourceLook; text?: TextStyle; color?: string };

export type EncoderOptions = {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec: string;
  bitrateMode: "constant" | "variable";
  keyEveryUs: number;
  hardware: "no-preference" | "prefer-hardware" | "prefer-software";
  latency: "quality" | "realtime";
  audioBitrate: number;
};

/** What the studio window tells its compositor. */
export type ToWorker =
  | ({ type: "output" } & EncoderOptions)
  | { type: "video"; id: string; readable: ReadableStream<VideoFrame> }
  | { type: "image"; id: string; bitmap: ImageBitmap }
  | { type: "character"; id: string; code: string }
  | { type: "level"; port: MessagePort }
  | { type: "audio"; readable: ReadableStream<AudioData> }
  | { type: "remove"; id: string }
  | { type: "layout"; sources: DrawnSource[]; transition?: Transition }
  | { type: "preview"; on: boolean }
  /** Studio mode: the scene being prepared, drawn apart from the one on the air; null when there is none. */
  | { type: "edit"; sources: DrawnSource[] | null }
  | { type: "preview-done"; edit?: boolean }
  | { type: "record"; on: boolean }
  | { type: "stream"; on: boolean }
  /** Keep this many seconds of what was encoded, ready to save; 0 turns it off. */
  | { type: "replay"; seconds: number }
  | { type: "replay-save" }
  | { type: "snapshot" };

/** An encoded frame or piece of sound for the stream: times in µs from the stream's start. */
export type StreamPacket = { kind: "video" | "audio"; data: Uint8Array<ArrayBuffer>; timestamp: number; key: boolean; config?: Uint8Array<ArrayBuffer> };

export type WorkerStats = { fps: number; dropped: number; queue: number; renderMs: number; kbps: number };

/** What the compositor tells the window. */
export type FromWorker =
  | { type: "preview"; bitmap: ImageBitmap; edit?: boolean }
  | { type: "file"; data: Uint8Array<ArrayBuffer>; position: number }
  | { type: "recorded" }
  | { type: "packet"; packet: StreamPacket }
  | { type: "snapshot"; data: Uint8Array<ArrayBuffer> }
  | { type: "clip"; data: Uint8Array<ArrayBuffer> | null }
  | ({ type: "stats" } & WorkerStats)
  | { type: "error"; message: string };
