// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Android's side as the page sees it: what the page sent, and a way to answer. */
function fakeNative() {
  const listeners: ((event: MessageEvent) => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  (globalThis as { HataNative?: unknown }).HataNative = {
    postMessage: (m: string) => sent.push(JSON.parse(m) as Record<string, unknown>),
    addEventListener: (_: string, f: (event: MessageEvent) => void) => listeners.push(f),
    removeEventListener: () => {},
  };
  const answer = (word: object) => listeners.forEach((f) => f({ data: JSON.stringify(word) } as MessageEvent));
  return { sent, answer };
}

afterEach(() => {
  delete (globalThis as { HataNative?: unknown }).HataNative;
  document.documentElement.removeAttribute("data-pip");
  vi.resetModules();
});

describe("what Android is told and tells back", () => {
  it("tells of the call, the camera and a server hosted here, and allows the small window only during a call", async () => {
    const { sent } = fakeNative();
    const { useAndroid } = await import("./useAndroid");
    const options = { inCall: false, camera: false, hosting: true, pip: true, route: "auto" as const, online: true, onLeave: vi.fn() };
    const { rerender } = renderHook((o: typeof options) => useAndroid(o), { initialProps: options });
    expect(sent).toContainEqual({ op: "call", on: false, camera: false });
    expect(sent).toContainEqual({ op: "server", on: true });
    expect(sent).toContainEqual({ op: "online", on: true });
    expect(sent).toContainEqual({ op: "pip", allowed: false });
    rerender({ ...options, inCall: true, camera: true });
    expect(sent).toContainEqual({ op: "call", on: true, camera: true });
    expect(sent).toContainEqual({ op: "pip", allowed: true });
    expect(sent).toContainEqual({ op: "route", to: "auto" });
    rerender({ ...options, inCall: true, pip: false });
    expect(sent[sent.length - 1]).toEqual({ op: "pip", allowed: false });
  });

  it("shows only the stage in the small window, and leaves the call from the notification", async () => {
    const { answer } = fakeNative();
    const { useAndroid } = await import("./useAndroid");
    const onLeave = vi.fn();
    const { result } = renderHook(() => useAndroid({ inCall: true, camera: false, hosting: false, pip: true, route: "speaker", online: false, onLeave }));
    act(() => answer({ ev: "pip", on: true }));
    expect(result.current.inPip).toBe(true);
    expect(document.documentElement.hasAttribute("data-pip")).toBe(true);
    act(() => answer({ ev: "pip", on: false }));
    expect(document.documentElement.hasAttribute("data-pip")).toBe(false);
    act(() => answer({ ev: "leave" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("does nothing outside the Android app", async () => {
    const { useAndroid } = await import("./useAndroid");
    const { result } = renderHook(() => useAndroid({ inCall: true, camera: true, hosting: false, pip: true, route: "auto", online: false, onLeave: vi.fn() }));
    expect(result.current.inPip).toBe(false);
  });
});
