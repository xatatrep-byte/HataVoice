import { readRms, rmsToDb } from "../audio/levels";
import type { SpeakingTracker } from "./speaking";

type Meter = { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; buffer: Float32Array<ArrayBuffer> };

/** Measures each remote voice in our audio context and feeds the levels to a SpeakingTracker. */
export class RemoteVoiceMeters {
  private readonly meters = new Map<string, Meter>();

  constructor(
    private readonly context: AudioContext,
    readonly tracker: SpeakingTracker,
  ) {}

  /** Starts measuring `track` as the voice of participant `id` (replacing an older one). */
  add(id: string, track: MediaStreamTrack): void {
    this.remove(id);
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    const analyser = this.context.createAnalyser();
    // ~43 ms at 48 kHz: one look covers most of the time between UI ticks.
    analyser.fftSize = 2048;
    source.connect(analyser);
    this.meters.set(id, { source, analyser, buffer: new Float32Array(analyser.fftSize) });
  }

  remove(id: string): void {
    this.meters.get(id)?.source.disconnect();
    this.meters.delete(id);
    this.tracker.remove(id);
  }

  clear(): void {
    for (const id of [...this.meters.keys()]) this.remove(id);
    this.tracker.clear();
  }

  sample(nowMs: number): void {
    for (const [id, meter] of this.meters) this.tracker.feed(id, rmsToDb(readRms(meter.analyser, meter.buffer)), nowMs);
  }
}
