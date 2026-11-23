import { LEVEL_INTERVAL_MS, rmsToDb } from "./levels";

/** A sound for the call, mixed into the frames as they pass: its samples, how far it has played, its own rate. */
type Playing = { samples: Float32Array; at: number; rate: number };

/** What the page tells the thread that carries the mic's frames. */
export type ToFrameWorker =
  | { t: "start"; readable: ReadableStream<AudioData>; writable: WritableStream<AudioData>; gate: boolean }
  | { t: "gate"; open: boolean }
  | { t: "play"; samples: Float32Array; rate: number }
  | { t: "stop" };

/** What that thread tells the page: that it runs, and the mic's level for voice activation. */
export type FromFrameWorker = { t: "ready" } | { t: "level"; db: number };

/**
 * One frame of the phone's mic at a time (a hundredth of a second): measured for voice activation, faded by the gate, given
 * a board sound if one plays. Pure, so that the page and a worker run the very same thing.
 */
export class FrameMixer {
  // Closed until voice activation or push-to-talk opens it: nothing leaks by default.
  private gateOpen = false;
  /** The gain the last frame ended on: a change fades over the next frame (no clicks). */
  private gain = 0;
  private squares = 0;
  private counted = 0;
  private playing: Playing[] = [];

  constructor(private readonly onLevel: (db: number) => void) {}

  setGateOpen(open: boolean): void {
    this.gateOpen = open;
  }

  play(samples: Float32Array, rate: number): void {
    this.playing.push({ samples, at: 0, rate });
  }

  clear(): void {
    this.playing = [];
  }

  /**
   * One frame: its level measured, the gate's gain put on it (faded across the frame when it changes), a board sound
   * mixed in past the gate. A frame that needs none of it goes on as it came.
   */
  process(frame: AudioData): AudioData {
    const frames = frame.numberOfFrames;
    const channels = frame.numberOfChannels;
    const rate = frame.sampleRate;
    const first = new Float32Array(frames);
    frame.copyTo(first, { planeIndex: 0, format: "f32-planar" });
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += first[i]! * first[i]!;
    this.squares += sum;
    this.counted += frames;
    if (this.counted >= (rate * LEVEL_INTERVAL_MS) / 1000) {
      this.onLevel(rmsToDb(Math.sqrt(this.squares / this.counted)));
      this.squares = 0;
      this.counted = 0;
    }

    const target = this.gateOpen ? 1 : 0;
    if (target === 1 && this.gain === 1 && this.playing.length === 0) return frame;

    const board = this.mixBoard(frames, rate);
    const data = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) {
      let plane = first;
      if (c > 0) {
        plane = new Float32Array(frames);
        frame.copyTo(plane, { planeIndex: c, format: "f32-planar" });
      }
      for (let i = 0; i < frames; i++) {
        const gain = this.gain + ((target - this.gain) * (i + 1)) / frames;
        data[c * frames + i] = plane[i]! * gain + (board ? board[i]! : 0);
      }
    }
    this.gain = target;
    const made = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: frames, numberOfChannels: channels, timestamp: frame.timestamp, data });
    frame.close();
    return made;
  }

  /** The board sounds' samples for the next frame at `rate`, or null when none plays. */
  private mixBoard(frames: number, rate: number): Float32Array | null {
    if (this.playing.length === 0) return null;
    const out = new Float32Array(frames);
    for (const sound of this.playing) {
      const step = sound.rate / rate;
      for (let i = 0; i < frames; i++) {
        const at = Math.floor(sound.at);
        if (at >= sound.samples.length) break;
        out[i]! += sound.samples[at]!;
        sound.at += step;
      }
    }
    this.playing = this.playing.filter((s) => s.at < s.samples.length);
    return out;
  }
}

/** Carries frames from the mic to the call through `mixer` until stopped; returns the stop. */
export function pumpFrames(readable: ReadableStream<AudioData>, writable: WritableStream<AudioData>, mixer: FrameMixer): () => void {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  let running = true;
  void (async () => {
    while (running) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value) break;
      const out = mixer.process(value);
      try {
        await writer.write(out);
      } catch {
        out.close();
        break;
      }
    }
  })();
  return () => {
    running = false;
    void reader.cancel().catch(() => {});
    void writer.close().catch(() => {});
  };
}
