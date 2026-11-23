import { describe, expect, it, vi } from "vitest";
import { RemoteVoiceMeters } from "./remoteMeters";
import { SpeakingTracker } from "./speaking";

vi.stubGlobal(
  "MediaStream",
  class {
    constructor(readonly tracks: unknown[]) {}
  },
);

/** Analysers that report a constant amplitude per track, set through `amplitude`. */
function fakeContext() {
  const amplitude = new Map<unknown, number>();
  const disconnected: unknown[] = [];
  const context = {
    createMediaStreamSource: (stream: { tracks: unknown[] }) => {
      const source = {
        track: stream.tracks[0],
        connect: (analyser: { track?: unknown }) => {
          analyser.track = source.track;
          return analyser;
        },
        disconnect: () => disconnected.push(source.track),
      };
      return source;
    },
    createAnalyser: () => {
      const analyser = {
        fftSize: 2048,
        track: undefined as unknown,
        getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(amplitude.get(analyser.track) ?? 0),
      };
      return analyser;
    },
  };
  return { amplitude, disconnected, context: context as unknown as AudioContext };
}

const tracker = () => new SpeakingTracker({ thresholdDb: -55, holdMs: 300 });

describe("RemoteVoiceMeters", () => {
  it("measures each remote voice separately", () => {
    const { amplitude, context } = fakeContext();
    const meters = new RemoteVoiceMeters(context, tracker());
    const anya = {} as MediaStreamTrack;
    const petya = {} as MediaStreamTrack;
    meters.add("anya", anya);
    meters.add("petya", petya);
    amplitude.set(anya, 0.1); // -20 dBFS
    amplitude.set(petya, 0.0001); // -80 dBFS
    meters.sample(0);
    expect(meters.tracker.get("anya")?.speaking).toBe(true);
    expect(meters.tracker.get("petya")?.speaking).toBe(false);
  });

  it("lets go of a voice when its person leaves", () => {
    const { amplitude, disconnected, context } = fakeContext();
    const meters = new RemoteVoiceMeters(context, tracker());
    const anya = {} as MediaStreamTrack;
    meters.add("anya", anya);
    amplitude.set(anya, 0.1);
    meters.sample(0);
    meters.remove("anya");
    expect(disconnected).toEqual([anya]);
    expect(meters.tracker.get("anya")).toBeUndefined();
  });

  it("replaces the meter when a person's track is re-subscribed", () => {
    const { disconnected, context } = fakeContext();
    const meters = new RemoteVoiceMeters(context, tracker());
    const first = {} as MediaStreamTrack;
    meters.add("anya", first);
    meters.add("anya", {} as MediaStreamTrack);
    expect(disconnected).toEqual([first]);
  });
});
