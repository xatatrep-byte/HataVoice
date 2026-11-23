// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "./settings";

const fake = vi.hoisted(() => ({
  pipelines: [] as {
    options: { noiseSuppression: boolean; onLevel: (db: number) => void };
    gate: boolean[];
    destroyed: boolean;
    processedTrack: object;
  }[],
  connections: [] as [unknown, unknown][],
  destination: { name: "speakers" },
  sinks: [] as string[],
}));

vi.mock("./micPipeline", () => ({
  MicPipeline: class {
    gate: boolean[] = [];
    destroyed = false;
    processedTrack = { name: "processed" };
    constructor(readonly options: { noiseSuppression: boolean; onLevel: (db: number) => void }) {
      fake.pipelines.push(this);
    }
    async init() {}
    setGateOpen(open: boolean) {
      this.gate.push(open);
    }
    async destroy() {
      this.destroyed = true;
    }
  },
}));

vi.mock("./audioContext", () => ({
  getAudioContext: () => ({
    destination: fake.destination,
    resume: async () => {},
    createMediaStreamSource: (stream: { tracks: unknown[] }) => ({
      track: stream.tracks[0],
      connect(target: unknown) {
        fake.connections.push([this.track, target]);
        return target;
      },
      disconnect() {},
    }),
  }),
  applyOutputDevice: async (_context: unknown, deviceId: string) => {
    fake.sinks.push(deviceId);
  },
}));

import { useMicLoopback } from "./useMicLoopback";

const micTrack = { stop: vi.fn() };

beforeEach(() => {
  fake.pipelines.length = 0;
  fake.connections.length = 0;
  fake.sinks.length = 0;
  micTrack.stop.mockClear();
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(readonly tracks: unknown[]) {}
    },
  );
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [micTrack], getAudioTracks: () => [micTrack] })) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settings = (over: Partial<AudioSettings> = {}): AudioSettings => ({ ...DEFAULT_AUDIO_SETTINGS, ...over });

describe("useMicLoopback", () => {
  it("plays your voice back through the call's processing on the chosen speakers", async () => {
    renderHook(() => useMicLoopback(true, settings({ outputDeviceId: "headphones" })));
    await waitFor(() => expect(fake.connections).toEqual([[fake.pipelines[0]?.processedTrack, fake.destination]]));
    expect(fake.pipelines[0].options.noiseSuppression).toBe(true);
    expect(fake.sinks).toEqual(["headphones"]);
  });

  it("hears the voice without the echo canceller, which took the voice played back for an echo and cut it", async () => {
    // Friends heard the owner much better than the test did: the canceller hears all the page plays, the test's voice too.
    renderHook(() => useMicLoopback(true, settings({ echoCancellation: true })));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    const asked = (navigator.mediaDevices.getUserMedia as unknown as { mock: { calls: [MediaStreamConstraints][] } }).mock.calls[0]![0];
    expect((asked.audio as MediaTrackConstraints).echoCancellation).toBe(false);
  });

  it("does nothing while turned off", async () => {
    renderHook(() => useMicLoopback(false, settings()));
    await Promise.resolve();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("lets go of the mic and the processing when turned off", async () => {
    const { rerender } = renderHook(({ on }) => useMicLoopback(on, settings()), { initialProps: { on: true } });
    await waitFor(() => expect(fake.connections.length).toBe(1));
    rerender({ on: false });
    await waitFor(() => expect(micTrack.stop).toHaveBeenCalled());
    expect(fake.pipelines[0].destroyed).toBe(true);
  });

  it("lets you hear voice activation cut in and out, as others would", async () => {
    renderHook(() => useMicLoopback(true, settings({ mode: "voice", vadThresholdDb: -50 })));
    await waitFor(() => expect(fake.pipelines.length).toBe(1));
    const pipeline = fake.pipelines[0];
    pipeline.options.onLevel(-30);
    expect(pipeline.gate[pipeline.gate.length - 1]).toBe(true);
  });

  it("keeps the gate open in push-to-talk mode", async () => {
    renderHook(() => useMicLoopback(true, settings({ mode: "ptt" })));
    await waitFor(() => expect(fake.pipelines.length).toBe(1));
    expect(fake.pipelines[0].gate).toEqual([true]);
  });
});
