import { describe, expect, it, vi } from "vitest";
import { applyOutputDevice } from "./audioContext";

describe("applyOutputDevice", () => {
  it("plays on the chosen speakers, with the system default as an empty id", async () => {
    const setSinkId = vi.fn(async (_id: string) => {});
    const context = { setSinkId } as unknown as AudioContext;
    await applyOutputDevice(context, "headphones");
    await applyOutputDevice(context, "default");
    expect(setSinkId.mock.calls).toEqual([["headphones"], [""]]);
  });

  it("does nothing where the engine cannot switch speakers", async () => {
    await expect(applyOutputDevice({} as AudioContext, "headphones")).resolves.toBeUndefined();
  });
});
