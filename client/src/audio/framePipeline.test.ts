import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pumpFrames, FrameMixer } from "./frameMixer";
import { FramePipeline } from "./framePipeline";

/** Just what the pipeline uses of WebCodecs' AudioData: planar float samples, copied out plane by plane. */
class FakeAudioData {
  readonly format = "f32-planar";
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly timestamp: number;
  readonly data: Float32Array;
  closed = false;
  constructor(init: { sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: Float32Array }) {
    this.sampleRate = init.sampleRate;
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
  copyTo(dest: Float32Array, options: { planeIndex: number }) {
    dest.set(this.data.subarray(options.planeIndex * this.numberOfFrames, (options.planeIndex + 1) * this.numberOfFrames));
  }
  close() {
    this.closed = true;
  }
}

const original = (globalThis as { AudioData?: unknown }).AudioData;
beforeAll(() => {
  (globalThis as { AudioData?: unknown }).AudioData = FakeAudioData;
});
afterAll(() => {
  (globalThis as { AudioData?: unknown }).AudioData = original;
});

/** A tenth-of-a-hundredth frame at 48 kHz: 480 samples of `value` on each channel. */
const frame = (value: number, channels = 1, at = 0) =>
  new FakeAudioData({ sampleRate: 48_000, numberOfFrames: 480, numberOfChannels: channels, timestamp: at, data: new Float32Array(480 * channels).fill(value) }) as unknown as AudioData;

const samples = (data: AudioData) => (data as unknown as FakeAudioData).data;

describe("the phone's voice, frame by frame", () => {
  it("sends silence while the gate is closed", () => {
    const pipeline = new FramePipeline({ onLevel: () => {} });
    const out = pipeline.process(frame(0.5));
    expect(Math.max(...samples(out).map(Math.abs))).toBe(0);
  });

  it("fades in over one frame when the gate opens, then hands frames on as they came", () => {
    const pipeline = new FramePipeline({ onLevel: () => {} });
    pipeline.setGateOpen(true);
    const first = samples(pipeline.process(frame(0.5)));
    expect(first[0]).toBeCloseTo(0.5 / 480, 6);
    expect(first[479]).toBeCloseTo(0.5, 6);
    for (let i = 1; i < 480; i++) expect(first[i]!).toBeGreaterThanOrEqual(first[i - 1]!);
    const next = frame(0.5);
    expect(pipeline.process(next), "the very same frame").toBe(next);
    pipeline.setGateOpen(false);
    const closing = samples(pipeline.process(frame(0.5)));
    expect(closing[0]).toBeGreaterThan(0.49);
    expect(closing[479]).toBe(0);
  });

  it("measures the level for voice activation every 20 ms, closed gate or not", () => {
    const onLevel = vi.fn();
    const pipeline = new FramePipeline({ onLevel });
    pipeline.process(frame(0.1));
    expect(onLevel).not.toHaveBeenCalled();
    pipeline.process(frame(0.1));
    expect(onLevel).toHaveBeenCalledTimes(1);
    expect(onLevel.mock.calls[0]![0]).toBeCloseTo(-20, 3);
  });

  it("fades every channel the same way", () => {
    const pipeline = new FramePipeline({ onLevel: () => {} });
    pipeline.setGateOpen(true);
    const both = samples(pipeline.process(frame(0.4, 2)));
    expect(both[479]).toBeCloseTo(0.4, 6);
    expect(both[480 + 479]).toBeCloseTo(0.4, 6);
    expect(both[0]).toBeCloseTo(both[480]!, 6);
  });

  it("plays a board sound into the call past the gate, then lets frames through again", () => {
    const pipeline = new FramePipeline({ onLevel: () => {} });
    (pipeline as unknown as { processedTrack: object }).processedTrack = {};
    expect(pipeline.playIntoCall(new Float32Array(600).fill(0.25), 48_000)).toBe(true);
    const one = samples(pipeline.process(frame(0.5)));
    expect(one[0], "the gate is closed, the sound is heard").toBeCloseTo(0.25, 6);
    const two = samples(pipeline.process(frame(0.5)));
    expect(two[119]).toBeCloseTo(0.25, 6);
    expect(two[120], "the sound is over").toBe(0);
    pipeline.setGateOpen(true);
    pipeline.process(frame(0.5));
    const free = frame(0.5);
    expect(pipeline.process(free)).toBe(free);
  });

  it("carries frames from the mic to the call through the mixer", async () => {
    const mixer = new FrameMixer(() => {});
    mixer.setGateOpen(true);
    const inputs = [frame(0.5), frame(0.5), frame(0.5)];
    const readable = new ReadableStream<AudioData>({
      start(controller) {
        for (const f of inputs) controller.enqueue(f);
        controller.close();
      },
    });
    const out: AudioData[] = [];
    const written = new Promise<void>((resolve) => {
      const writable = new WritableStream<AudioData>({
        write(chunk) {
          out.push(chunk);
          if (out.length === inputs.length) resolve();
        },
      });
      pumpFrames(readable, writable, mixer);
    });
    await written;
    expect(out).toHaveLength(3);
    expect(out[1], "an open gate hands frames on as they came").toBe(inputs[1]);
  });

  it("hands the streams to a worker of their own, and keeps them on the page when no worker answers", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { p: g.MediaStreamTrackProcessor, gen: g.MediaStreamTrackGenerator, w: g.Worker };
    const posted: { word: { t: string }; transfer?: unknown[] }[] = [];
    let answers = true;
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        setTimeout(() => answers && this.onmessage?.({ data: { t: "ready" } }), 0);
      }
      postMessage(word: { t: string }, transfer?: unknown[]) {
        posted.push({ word, transfer });
      }
      terminate() {}
    }
    g.MediaStreamTrackProcessor = class {
      readable = new ReadableStream();
    };
    g.MediaStreamTrackGenerator = class {
      writable = new WritableStream();
      stop() {}
    };
    g.Worker = FakeWorker;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pipeline = new FramePipeline({ onLevel: () => {} });
      pipeline.setGateOpen(true);
      const started = pipeline.init({ track: {} as MediaStreamTrack, kind: "audio" } as never);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(posted[0]?.word).toMatchObject({ t: "start", gate: true });
      expect(posted[0]?.transfer, "the streams themselves go over").toHaveLength(2);
      pipeline.setGateOpen(false);
      expect(posted[1]?.word).toEqual({ t: "gate", open: false });

      answers = false;
      posted.length = 0;
      const quiet = new FramePipeline({ onLevel: () => {} });
      const waiting = quiet.init({ track: {} as MediaStreamTrack, kind: "audio" } as never);
      await vi.advanceTimersByTimeAsync(2500);
      await waiting;
      expect(posted, "nothing was handed to a silent worker").toHaveLength(0);
      expect(quiet.processedTrack).toBeDefined();
    } finally {
      vi.useRealTimers();
      g.MediaStreamTrackProcessor = saved.p;
      g.MediaStreamTrackGenerator = saved.gen;
      g.Worker = saved.w;
    }
  });

  it("is not taken where it cannot run", async () => {
    const pipeline = new FramePipeline({ onLevel: () => {} });
    await expect(pipeline.init({ track: {} as MediaStreamTrack, kind: "audio" } as never)).rejects.toThrow();
  });
});
