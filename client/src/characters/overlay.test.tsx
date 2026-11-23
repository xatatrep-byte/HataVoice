// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_CHARACTER } from "./character";
import { actsFrom, clampSize, clampSpot, DEFAULT_SIZE, MAX_SIZE, spotsFor, useOverlayFeed, useOverlayHealth, type OverlayState } from "./overlay";
import { setStageWalks } from "./stageWalks";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => null),
  emitTo: vi.fn(async (..._args: unknown[]) => {}),
  heard: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: (...args: unknown[]) => mocks.emitTo(...args),
  listen: async (event: string, take: (event: { payload: unknown }) => void) => {
    mocks.heard.set(event, take);
    return () => mocks.heard.delete(event);
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.invoke.mockClear();
  mocks.emitTo.mockClear();
  mocks.heard.clear();
});

const anna = { id: "anna", name: "Аня", character: DEFAULT_CHARACTER, level: 0.4, speaking: true };

describe("the characters on the desktop", () => {
  it("are shown while on, told the call and their places ten times a second, and closed after", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    vi.advanceTimersByTime(10_000);
    const acts = [{ key: 1, user: "anna", act: "wave", to: null, startedAt: performance.now() - 500 }];
    const { rerender } = renderHook(({ on }) => useOverlayFeed(on, false, [anna], acts, { anna: [0.3, 0.9] }, 0.3), { initialProps: { on: true } });
    expect(mocks.invoke).toHaveBeenCalledWith("overlay_show", { show: true });
    vi.advanceTimersByTime(100);
    const [target, event, state] = mocks.emitTo.mock.calls[0] as [string, string, OverlayState];
    expect([target, event]).toEqual(["overlay", "overlay-state"]);
    expect(state.members).toEqual([anna]);
    expect(state.spots).toEqual({ anna: [0.3, 0.9] });
    expect(state.size).toBe(0.3);
    expect(state.acts[0]).toMatchObject({ key: 1, act: "wave", age: 600 });
    rerender({ on: false });
    expect(mocks.invoke).toHaveBeenLastCalledWith("overlay_show", { show: false });
    mocks.emitTo.mockClear();
    vi.advanceTimersByTime(500);
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });

  it("are told where each one walks on the call's stage, so the desktop walks the same", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    setStageWalks(new Map([["anna", [0.6, -0.2]]]));
    renderHook(() => useOverlayFeed(true, false, [anna], [], {}, 0.3));
    vi.advanceTimersByTime(100);
    const state = mocks.emitTo.mock.calls[0]![2] as OverlayState;
    expect(state.walks).toEqual({ anna: [0.6, -0.2] });
    setStageWalks(new Map());
  });

  it("hear where each one was put, how big they are, and when it is done", async () => {
    const onPlaced = vi.fn();
    const onSize = vi.fn();
    const onDone = vi.fn();
    renderHook(() => useOverlayFeed(true, true, [anna], [], {}, DEFAULT_SIZE, { onPlaced, onSize, onDone }));
    await vi.waitFor(() => expect(mocks.heard.size).toBe(5));
    mocks.heard.get("overlay-placed")!({ payload: { id: "anna", spot: [0.2, 0.95] } });
    expect(onPlaced).toHaveBeenLastCalledWith("anna", [0.2, 0.95]);
    mocks.heard.get("overlay-placed")!({ payload: { id: "anna", spot: [5, "x"] } });
    expect(onPlaced, "a place that is none forgets it").toHaveBeenLastCalledWith("anna", null);
    mocks.heard.get("overlay-size")!({ payload: { size: 9 } });
    expect(onSize).toHaveBeenLastCalledWith(MAX_SIZE);
    mocks.heard.get("overlay-done")!({ payload: {} });
    expect(onDone).toHaveBeenCalledOnce();
    // How smoothly the desktop window draws reaches the settings.
    mocks.heard.get("overlay-fps")!({ payload: { fps: 3, hidden: false } });
    expect(useOverlayHealth.getState()).toMatchObject({ fps: 3, hidden: false });
    mocks.heard.get("overlay-fps")!({ payload: { fps: "lots" } });
    expect(useOverlayHealth.getState().fps, "nothing odd is taken").toBe(3);
  });

  it("do what was chosen in a character's menu on the desktop, and nothing odd", async () => {
    const onAct = vi.fn();
    renderHook(() => useOverlayFeed(true, false, [anna], [], {}, DEFAULT_SIZE, { onPlaced: vi.fn(), onSize: vi.fn(), onDone: vi.fn(), onAct }));
    await vi.waitFor(() => expect(mocks.heard.has("overlay-act")).toBe(true));
    const act = mocks.heard.get("overlay-act")!;
    act({ payload: { act: "wave", to: null } });
    expect(onAct).toHaveBeenLastCalledWith("wave", null);
    act({ payload: { act: "hug", to: "anna" } });
    expect(onAct).toHaveBeenLastCalledWith("hug", "anna");
    for (const odd of [{ act: "Wave!", to: null }, { act: 5, to: null }, { act: "hug", to: 7 }, { act: "hug", to: "x".repeat(300) }, null]) act({ payload: odd ?? {} });
    expect(onAct).toHaveBeenCalledTimes(2);
  });

  it("stand where they were put, and those never put stand in a row from the bottom right", () => {
    const spots = spotsFor(["a", "b", "c"], { b: [0.1, 0.5] }, 0.3);
    expect(spots.b).toEqual([0.1, 0.5]);
    expect(spots.a![1]).toBe(1);
    expect(spots.a![0]).toBeGreaterThan(spots.c![0]);
  });

  it("keep the whole character on the screen", () => {
    expect(clampSpot([-1, 0], 0.3)).toEqual([0.02, 0.31]);
    expect(clampSpot([2, 2], 0.3)).toEqual([0.98, 1]);
    expect(clampSize("big")).toBe(DEFAULT_SIZE);
    expect(clampSize(0)).toBeGreaterThan(0);
  });

  it("take each act on their own clock", () => {
    expect(actsFrom([{ key: 3, user: "a", act: "hug", to: "b", age: 250 }], 1000)).toEqual([{ key: 3, user: "a", act: "hug", to: "b", startedAt: 750 }]);
  });
});

describe("how smoothly the desktop window draws", () => {
  it("takes only a well-formed word from it", async () => {
    const { readOverlayFps } = await import("./overlay");
    expect(readOverlayFps({ fps: 29.6, hidden: false })).toEqual({ fps: 30, hidden: false });
    expect(readOverlayFps({ fps: 2, hidden: true })).toEqual({ fps: 2, hidden: true });
    expect(readOverlayFps({ fps: "30", hidden: false })).toBeNull();
    expect(readOverlayFps({ fps: -1, hidden: false })).toBeNull();
    expect(readOverlayFps({ fps: Number.NaN, hidden: false })).toBeNull();
    expect(readOverlayFps(null)).toBeNull();
  });
});
