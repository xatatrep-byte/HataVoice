// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { ACT_EVERY_MS, useActs } from "./useActs";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => null),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.invoke.mockClear();
});

describe("characters' acts", () => {
  it("ours go to the call at once, not faster than one a second", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { result } = renderHook(() => useActs("a:1", "voice", "me"));
    act(() => void expect(result.current.perform("wave")).toBe(true));
    expect(mocks.invoke).toHaveBeenCalledWith("chat_act", { address: "a:1", channel: "voice", act: "wave", to: null });
    expect(result.current.acts.map((a) => [a.user, a.act])).toEqual([["me", "wave"]]);
    act(() => void expect(result.current.perform("hug", "anna")).toBe(false));
    vi.advanceTimersByTime(ACT_EVERY_MS);
    act(() => void expect(result.current.perform("hug", "anna")).toBe(true));
    expect(mocks.invoke).toHaveBeenLastCalledWith("chat_act", { address: "a:1", channel: "voice", act: "hug", to: "anna" });
    act(() => void expect(result.current.perform("explode")).toBe(false));
  });

  it("the others' come from their channel only, and only known acts", async () => {
    const { result } = renderHook(() => useActs("a:1", "voice", "me"));
    await waitFor(() => expect(mocks.listeners.has("chat-act")).toBe(true));
    const hear = (payload: object) => act(() => mocks.listeners.get("chat-act")!({ payload }));
    hear({ address: "a:1", channel: "voice", user: "anna", act: "highfive", to: "me" });
    hear({ address: "a:1", channel: "other", user: "bob", act: "wave", to: null });
    hear({ address: "a:1", channel: "voice", user: "bob", act: "explode", to: null });
    expect(result.current.acts.map((a) => [a.user, a.act, a.to])).toEqual([["anna", "highfive", "me"]]);
  });
});
