// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const invoke = vi.fn();
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

import { useServers } from "../../state/servers";
import { useToasts } from "../../ui/toasts";
import { serverState } from "../../server/testState";
import { useServerState } from "./useServerState";

const emit = (address: string, event: Record<string, unknown>) =>
  act(async () => {
    listeners.get("server-event")?.({ payload: { address, event } });
    await vi.advanceTimersByTimeAsync(0);
  });

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  listeners.clear();
  useToasts.setState({ toasts: [] });
  useServers.setState({ servers: [{ address: "a:1", name: "a:1", color: "blue" }], selected: "a:1" });
});
afterEach(() => vi.useRealTimers());

describe("useServerState", () => {
  it("loads the state, then refreshes on events for this server only", async () => {
    let loads = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === "server_open") return { address: "a:1", server_key: "SK", name: "Хата" };
      if (command === "server_state") return serverState({ server_time: ++loads });
      return null;
    });
    const { result } = renderHook(() => useServerState("a:1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state?.profile.name).toBe("Хата");
    expect(loads).toBe(1);
    expect(useServers.getState().servers[0]).toMatchObject({ serverKey: "SK", name: "Хата" });

    await emit("b:1", { type: "roster" });
    expect(loads).toBe(1);
    await emit("a:1", { type: "presence" });
    expect(loads).toBe(2);
    expect(result.current.state?.server_time).toBe(2);
  });

  it("shows one offline notice and recovers", async () => {
    const opens = vi
      .fn()
      .mockRejectedValueOnce("Сервер недоступен: connection refused")
      .mockRejectedValueOnce("Сервер недоступен: connection refused")
      .mockResolvedValue({ address: "a:1", server_key: "SK", name: "Хата" });
    invoke.mockImplementation(async (command: string) => {
      if (command === "server_open") return opens();
      if (command === "server_state") return serverState();
      return null;
    });
    const { result } = renderHook(() => useServerState("a:1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.offline).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.offline).toBe(true);
    expect(useToasts.getState().toasts).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.offline).toBe(false);
    expect(result.current.state?.profile.name).toBe("Хата");
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("stops and explains when the server refuses us", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "server_open") throw "Ты не участник этого сервера. Попроси ссылку у владельца";
      return null;
    });
    const { result } = renderHook(() => useServerState("a:1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.error).toBe("Ты не участник этого сервера. Попроси ссылку у владельца");
    expect(result.current.offline).toBe(false);
    expect(invoke.mock.calls.filter(([command]) => command === "server_open")).toHaveLength(1);
  });

  it("forgets the old state once the server refuses us (kicked or banned)", async () => {
    let banned = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "server_open") return { address: "a:1", server_key: "SK", name: "Хата" };
      if (command === "server_state") {
        if (banned) throw "Ты забанен на этом сервере";
        return serverState();
      }
      return null;
    });
    const { result } = renderHook(() => useServerState("a:1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).not.toBeNull();
    banned = true;
    await emit("a:1", { type: "stream_refused" });
    expect(result.current.state).toBeNull();
    expect(result.current.error).toBe("Ты забанен на этом сервере");
  });

  it("does nothing without a server", async () => {
    const { result } = renderHook(() => useServerState(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });
});
