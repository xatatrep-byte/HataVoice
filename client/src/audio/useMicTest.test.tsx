// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useMicTest } from "./useMicTest";

vi.mock("./audioContext", () => ({ getAudioContext: () => ({}) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useMicTest", () => {
  it("releases a microphone that opens after the test was closed", async () => {
    const stop = vi.fn();
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => (grant = resolve)));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const { unmount } = renderHook(() => useMicTest("default"));
    unmount();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
  });
});
