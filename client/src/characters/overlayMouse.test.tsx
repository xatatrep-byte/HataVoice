// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { DEFAULT_CHARACTER } from "./character";
import { OverlayApp } from "./OverlayApp";

const mocks = vi.hoisted(() => ({
  cursor: null as [number, number] | null | "fail",
  game: false,
  invoke: vi.fn(),
  heard: new Map<string, (event: { payload: unknown }) => void>(),
}));
mocks.invoke.mockImplementation(async (command: string) => {
  if (command === "overlay_cursor") {
    if (mocks.cursor === "fail") throw new Error("no window");
    return mocks.cursor;
  }
  if (command === "fullscreen_app") return mocks.game;
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: async () => {},
  listen: async (event: string, take: (event: { payload: unknown }) => void) => {
    mocks.heard.set(event, take);
    return () => mocks.heard.delete(event);
  },
}));
// The scene: Аня stands in the left 100 pixels of the screen.
vi.mock("./CharacterCanvas", () => ({
  CharacterCanvas: ({ probe }: { probe: MutableRefObject<((x: number, y: number) => string | null) | null> }) => {
    probe.current = (x) => (x < 100 ? "anna" : null);
    return null;
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.invoke.mockClear();
  mocks.heard.clear();
  mocks.cursor = null;
  mocks.game = false;
});

const anna = { id: "anna", name: "Аня", character: DEFAULT_CHARACTER, level: 0, speaking: false };

/** The mouse as the window was last told to take it or let it through. */
const taken = () => {
  const calls = mocks.invoke.mock.calls.filter(([command]) => command === "overlay_arrange");
  return calls.length ? (calls[calls.length - 1]![1] as { on: boolean }).on : false;
};

async function shown() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  render(<OverlayApp />);
  await act(async () => {
    await vi.waitFor(() => expect(mocks.heard.has("overlay-state")).toBe(true));
    mocks.heard.get("overlay-state")!({ payload: { members: [anna], acts: [], arranging: false, spots: {}, size: 0.3 } });
  });
}

const tick = () => act(async () => {
  await vi.advanceTimersByTimeAsync(60);
});

describe("the characters' window on the desktop", () => {
  it("takes the mouse only while a character is under it, wherever that one is", async () => {
    await shown();
    mocks.cursor = [500, 300];
    await tick();
    expect(taken()).toBe(false);
    mocks.cursor = [50, 300];
    await tick();
    expect(taken(), "over Аня").toBe(true);
    mocks.cursor = [600, 300];
    await tick();
    expect(taken(), "off her again").toBe(false);
    mocks.cursor = null;
    await tick();
    expect(taken(), "over the taskbar").toBe(false);
  });

  it("never holds the desktop when it cannot tell where the mouse is, nor over a game", async () => {
    await shown();
    mocks.cursor = [50, 300];
    await tick();
    expect(taken()).toBe(true);
    mocks.cursor = "fail";
    await tick();
    expect(taken(), "no answer").toBe(false);
    mocks.game = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    mocks.cursor = [50, 300];
    await tick();
    expect(taken(), "a game fills the screen").toBe(false);
  });
});
