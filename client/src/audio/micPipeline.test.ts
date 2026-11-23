import { afterEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";

const rnnoise = vi.hoisted(() => ({ nodes: [] as Record<string, unknown>[] }));
vi.mock("@sapphi-red/web-noise-suppressor", () => ({
  loadRnnoise: vi.fn(async () => new ArrayBuffer(0)),
  RnnoiseWorkletNode: class {
    channelCount = 2;
    channelCountMode = "max";
    channelInterpretation = "speakers";
    targets: unknown[] = [];
    constructor() {
      rnnoise.nodes.push(this as unknown as Record<string, unknown>);
    }
    connect(next: unknown) {
      this.targets.push(next);
      return next;
    }
    disconnect() {}
    destroy() {}
  },
}));

import { MicPipeline } from "./micPipeline";
import { NO_FX } from "./voiceFx";

type FakeNode = {
  kind: string;
  channelCount: number;
  channelCountMode: string;
  channelInterpretation: string;
  targets: FakeNode[];
  gain?: { value: number };
};

/** A Web Audio stand-in that records nodes, their channel settings and connections. */
function fakeContext() {
  const nodes: FakeNode[] = [];
  const node = (kind: string, extra: object = {}): FakeNode => {
    const n = {
      kind,
      channelCount: 2,
      channelCountMode: "max",
      channelInterpretation: "speakers",
      targets: [] as FakeNode[],
      connect: (next: FakeNode) => {
        n.targets.push(next);
        return next;
      },
      disconnect: () => {},
      ...extra,
    };
    nodes.push(n);
    return n;
  };
  const gainParam = () => {
    const param = {
      value: 1,
      cancelScheduledValues: () => {},
      setValueAtTime: () => {},
      linearRampToValueAtTime: (value: number) => {
        param.value = value;
      },
    };
    return param;
  };
  const context = {
    sampleRate: 48_000,
    currentTime: 0,
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => node("source"),
    createAnalyser: () => node("analyser", { fftSize: 0, getFloatTimeDomainData: () => {} }),
    createGain: () => node("gain", { gain: gainParam() }),
    createBiquadFilter: () => node("biquad", { type: "", frequency: { value: 0 }, Q: { value: 0 } }),
    createDynamicsCompressor: () => node("compressor", { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }),
    createMediaStreamDestination: () =>
      node("destination", { stream: { getAudioTracks: () => [{ stop: () => {} }] } }),
  };
  const of = (kind: string) => nodes.filter((n) => n.kind === kind);
  return { nodes, of, context: context as unknown as AudioContext };
}

vi.stubGlobal(
  "MediaStream",
  class {
    constructor(readonly tracks: unknown[]) {}
  },
);

const pipelines: MicPipeline[] = [];
afterEach(async () => {
  await Promise.all(pipelines.splice(0).map((p) => p.destroy()));
  rnnoise.nodes.length = 0;
});

async function started({ open, noiseSuppression = false }: { open?: boolean; noiseSuppression?: boolean } = {}) {
  const fake = fakeContext();
  const pipeline = new MicPipeline({ noiseSuppression, onLevel: () => {} });
  pipelines.push(pipeline);
  if (open !== undefined) pipeline.setGateOpen(open);
  await pipeline.init({ kind: Track.Kind.Audio, track: {} as MediaStreamTrack, audioContext: fake.context });
  const destination = fake.of("destination")[0];
  const gate = fake.nodes.find((n) => n.targets.includes(destination));
  return { ...fake, destination, gate };
}

const isMono = (n: { channelCount: unknown; channelCountMode: unknown }) =>
  n.channelCount === 1 && n.channelCountMode === "explicit";

describe("MicPipeline gate", () => {
  it("starts closed, so nothing is sent before voice activation decides", async () => {
    expect((await started()).gate?.gain?.value).toBe(0);
  });

  it("starts open when opened before the track is attached (push-to-talk)", async () => {
    expect((await started({ open: true })).gate?.gain?.value).toBe(1);
  });
});

describe("MicPipeline voice changer", () => {
  it("sends the voice unchanged when the voice changer will not load, rather than not at all", async () => {
    const fake = fakeContext();
    const failure = Object.assign(new Error("Unable to load a worklet's module."), { name: "AbortError" });
    (fake.context.audioWorklet as { addModule: () => Promise<void> }).addModule = async () => {
      throw failure;
    };
    const pipeline = new MicPipeline({ noiseSuppression: false, onLevel: () => {}, fx: NO_FX });
    pipelines.push(pipeline);
    await pipeline.init({ kind: Track.Kind.Audio, track: {} as MediaStreamTrack, audioContext: fake.context });
    expect(pipeline.processedTrack).toBeDefined();
    expect(pipeline.fxError).toBe(failure);
    const destination = fake.of("destination")[0];
    expect(fake.nodes.some((n) => n.targets.includes(destination)), "the voice reaches the track").toBe(true);
  });
});

describe("MicPipeline voice quality", () => {
  it("cuts the rumble below the voice before anything else hears it", async () => {
    const { of } = await started();
    const downmix = of("source")[0].targets[0];
    const [cut] = downmix.targets;
    expect(cut).toMatchObject({ kind: "biquad", type: "highpass", frequency: { value: 75 } });
    expect(isMono(cut)).toBe(true);
  });

  it("holds shouts down just before the gate, and leaves a normal voice alone", async () => {
    const { of, gate } = await started();
    const limiter = of("compressor")[0];
    expect(limiter).toMatchObject({ threshold: { value: -3 }, ratio: { value: 20 } });
    expect(limiter.targets).toContain(gate);
  });
});

describe("MicPipeline channels", () => {
  it("mixes a stereo mic down to one channel right after the source", async () => {
    const { of } = await started();
    const [first] = of("source")[0].targets;
    expect(isMono(first)).toBe(true);
    expect(first.channelInterpretation).toBe("speakers");
  });

  it("feeds noise suppression a single channel, so no channel is left unprocessed", async () => {
    const { of } = await started({ noiseSuppression: true });
    const [downmix] = of("source")[0].targets;
    // Mono, cleared of rumble, then noise suppression.
    const [cut] = downmix.targets;
    expect(cut.kind).toBe("biquad");
    expect(cut.targets).toEqual([rnnoise.nodes[0]]);
    expect(isMono(rnnoise.nodes[0] as FakeNode)).toBe(true);
  });

  it("sends a mono track, so LiveKit never publishes it as stereo", async () => {
    expect(isMono((await started({ noiseSuppression: true })).destination)).toBe(true);
  });
});
