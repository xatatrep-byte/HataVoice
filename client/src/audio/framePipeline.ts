import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { FrameMixer, pumpFrames, type FromFrameWorker, type ToFrameWorker } from "./frameMixer";
import type { VoiceFx } from "./voiceFx";

type FrameReader = { readable: ReadableStream<AudioData> };
type FrameProcessorMaker = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => FrameReader;
type FrameGenerator = MediaStreamTrack & { writable: WritableStream<AudioData> };
type FrameGeneratorMaker = new (init: { kind: "audio" }) => FrameGenerator;

type Breakout = { MediaStreamTrackProcessor?: FrameProcessorMaker; MediaStreamTrackGenerator?: FrameGeneratorMaker };

/**
 * The most mic frames (a hundredth of a second each) held before the call takes them; older ones are dropped. The
 * engine's own default held up to ten: on a busy phone (one hosting the server) the mic ran a little ahead of the call's
 * clock, the queue filled, and the voice stayed that far behind for good. A dropped hundredth is not heard; a tenth of
 * a second late is.
 */
export const MIC_QUEUE_FRAMES = 3;

/** How long a worker may take to say it runs before the frames stay on the page instead. */
const WORKER_PATIENCE_MS = 2000;

/** Whether this engine hands a track's sound out frame by frame and takes frames into a new track. */
export function framePipelineSupported(): boolean {
  const g = globalThis as Breakout;
  return typeof g.MediaStreamTrackProcessor === "function" && typeof g.MediaStreamTrackGenerator === "function" && typeof AudioData === "function";
}

/** A worker for the frames, once it says it runs; null where there is none or it stays silent. */
function startWorker(): Promise<Worker | null> {
  if (typeof Worker !== "function") return Promise.resolve(null);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./frameWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const give = (ok: boolean) => {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      if (!ok) worker.terminate();
      resolve(ok ? worker : null);
    };
    const timer = setTimeout(() => give(false), WORKER_PATIENCE_MS);
    worker.onmessage = (event: MessageEvent<FromFrameWorker>) => {
      if (event.data?.t === "ready") give(true);
    };
    worker.onerror = () => give(false);
  });
}

/**
 * The phone's microphone path: the mic's frames (a hundredth of a second each) go to the call as they come, with no Web
 * Audio on the way. On Android, Web Audio runs on the media path with its own big buffer, and a busy phone (its camera
 * on) made the buffer between the mic's clock and its own grow until the voice came a second late. Here nothing is held:
 * a frame is measured (voice activation), faded by the gate, given a board sound if one plays, and handed on (see
 * `FrameMixer`). Cleaning is the phone's own (echo canceller and noise suppressor of its call path); the voice changer
 * needs Web Audio and keeps it.
 *
 * The frames go through a worker of their own. On the page's thread every stall (the 3D stage, a long render, Android
 * holding back a page that is out of sight while a friend controls the phone) held the voice up and let it go in bursts,
 * and the friend's jitter buffer grew to take them: 0.23 was heard far behind. Where no worker starts, the page carries
 * them as before.
 */
export class FramePipeline implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "hatavoice-mic-frames";
  processedTrack?: MediaStreamTrack;

  /** The frames on this thread: where no worker runs, and for the tests. */
  private readonly mixer: FrameMixer;
  private gateOpen = false;
  private worker: Worker | null = null;
  private context?: AudioContext;
  private stop?: () => void;

  constructor(private readonly options: { onLevel: (db: number) => void }) {
    this.mixer = new FrameMixer((db) => this.options.onLevel(db));
  }

  async init({ track, audioContext }: AudioProcessorOptions): Promise<void> {
    const g = globalThis as Breakout;
    if (!g.MediaStreamTrackProcessor || !g.MediaStreamTrackGenerator) throw new Error("no frame-by-frame sound here");
    this.context = audioContext;
    const readable = new g.MediaStreamTrackProcessor({ track, maxBufferSize: MIC_QUEUE_FRAMES }).readable;
    const generator = new g.MediaStreamTrackGenerator({ kind: "audio" });
    this.processedTrack = generator;

    const worker = await startWorker();
    if (worker && this.processedTrack === generator) {
      try {
        const start: ToFrameWorker = { t: "start", readable, writable: generator.writable, gate: this.gateOpen };
        worker.postMessage(start, [readable as unknown as Transferable, generator.writable as unknown as Transferable]);
        worker.onmessage = (event: MessageEvent<FromFrameWorker>) => {
          if (event.data?.t === "level") this.options.onLevel(event.data.db);
        };
        this.worker = worker;
        this.stop = () => {
          worker.postMessage({ t: "stop" } satisfies ToFrameWorker);
          // The worker closes the streams; then it goes.
          setTimeout(() => worker.terminate(), 500);
        };
        return;
      } catch {
        // This WebView cannot hand the streams over: they stay here.
        worker.terminate();
      }
    } else {
      worker?.terminate();
    }
    this.stop = pumpFrames(readable, generator.writable, this.mixer);
  }

  /** One frame through this thread's mixer (see `FrameMixer.process`). */
  process(frame: AudioData): AudioData {
    return this.mixer.process(frame);
  }

  /** A sound for the call, past the gate, as the Web Audio pipeline plays it; we hear it too, a little quieter. */
  playIntoCall(samples: Float32Array, rate: number): boolean {
    if (!this.processedTrack) return false;
    if (this.worker) this.worker.postMessage({ t: "play", samples: samples.slice(), rate } satisfies ToFrameWorker);
    else this.mixer.play(samples, rate);
    const context = this.context;
    if (context) {
      const buffer = context.createBuffer(1, samples.length, rate);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      const own = context.createGain();
      own.gain.value = 0.5;
      source.connect(own).connect(context.destination);
      source.onended = () => {
        source.disconnect();
        own.disconnect();
      };
      source.start();
    }
    return true;
  }

  /** The voice changer is Web Audio's: this path is taken only while the voice goes out unchanged. */
  setFx(_fx: VoiceFx): void {}

  setGateOpen(open: boolean): void {
    this.gateOpen = open;
    this.mixer.setGateOpen(open);
    this.worker?.postMessage({ t: "gate", open } satisfies ToFrameWorker);
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(options);
  }

  async destroy(): Promise<void> {
    this.stop?.();
    this.stop = undefined;
    this.worker = null;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.mixer.clear();
  }
}
