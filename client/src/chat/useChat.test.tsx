// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
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

import type { ChannelChat, ItemView } from "./api";
import { useChat } from "./useChat";

const item = (over: Partial<ItemView> = {}): ItemView => ({
  id: "m1",
  seq: 1,
  at: 1_800_000_000,
  author: "u1",
  text: "привет",
  reply: null,
  edited: false,
  deleted: false,
  reactions: [],
  poll: null,
  files: [],
  mentions_me: false,
  ...over,
});

const view = (channel: string, items: ItemView[]): ChannelChat => ({ channel, items, last_seq: items[items.length - 1]?.seq ?? 0 });

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const emit = (name: string, payload: unknown) =>
  act(async () => {
    listeners.get(name)?.({ payload });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  invoke.mockReset();
  listeners.clear();
});

describe("useChat", () => {
  it("reads the view, then again only when its own channel changed", async () => {
    let reads = 0;
    invoke.mockImplementation(async (command: string, args: { channel?: string }) => {
      if (command === "chat_view") return view(args.channel ?? "", [item({ text: `чтение ${++reads}` })]);
      if (command === "chat_status") return "ready";
      return null;
    });
    const { result } = renderHook(() => useChat("a:1", "general"));
    await settle();
    expect(result.current.chat?.items[0].text).toBe("чтение 1");
    expect(result.current.status).toBe("ready");

    await emit("chat-changed", { address: "b:2", channels: ["general"] });
    await emit("chat-changed", { address: "a:1", channels: ["games"] });
    expect(reads).toBe(1);
    await emit("chat-changed", { address: "a:1", channels: ["games", "general"] });
    expect(reads).toBe(2);
    expect(result.current.chat?.items[0].text).toBe("чтение 2");

    await emit("chat-status", { address: "b:2", status: "failed" });
    expect(result.current.status).toBe("ready");
    await emit("chat-status", { address: "a:1", status: "waiting" });
    expect(result.current.status).toBe("waiting");
  });

  it("has nothing without a server or a channel", async () => {
    const { result } = renderHook(() => useChat(null, null));
    await settle();
    expect(result.current.chat).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(await result.current.send("x")).toBe("Чат этого сервера ещё не открыт");
  });

  it("sends with the right arguments and hands errors back as text", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "chat_view") return view("general", []);
      if (command === "chat_status") return "ready";
      if (command === "chat_edit") throw "Менять можно только свои сообщения";
      if (command === "chat_vote") throw new Error("Голосование уже завершено");
      return null;
    });
    const { result } = renderHook(() => useChat("a:1", "general"));
    await settle();
    expect(await result.current.send("привет", "m0")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("chat_send", { address: "a:1", channel: "general", text: "привет", reply: "m0", files: [] });
    expect(await result.current.send("ещё")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("chat_send", { address: "a:1", channel: "general", text: "ещё", reply: null, files: [] });
    expect(await result.current.edit("m1", "правка")).toBe("Менять можно только свои сообщения");
    expect(await result.current.vote("p1", [0])).toBe("Голосование уже завершено");
    expect(await result.current.react("m1", "👍", true)).toBeNull();
    expect(invoke).toHaveBeenCalledWith("chat_react", { address: "a:1", id: "m1", emoji: "👍", on: true });
    expect(await result.current.poll("Идём?", ["да", "нет"], true)).toBeNull();
    expect(invoke).toHaveBeenCalledWith("chat_poll", {
      address: "a:1",
      channel: "general",
      question: "Идём?",
      options: ["да", "нет"],
      multi: true,
    });
    expect(await result.current.remove("m1")).toBeNull();
    expect(await result.current.closePoll("p1")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("chat_poll_close", { address: "a:1", poll: "p1" });
  });

  it("drops a view that comes back after the channel was switched", async () => {
    let finish: ((chat: ChannelChat) => void) | null = null;
    invoke.mockImplementation((command: string, args: { channel?: string }) => {
      if (command === "chat_status") return Promise.resolve("ready");
      if (args.channel === "slow") return new Promise((resolve) => (finish = resolve));
      return Promise.resolve(view(args.channel ?? "", [item({ text: args.channel })]));
    });
    const { result, rerender } = renderHook(({ channel }) => useChat("a:1", channel), { initialProps: { channel: "slow" } });
    await settle();
    rerender({ channel: "fast" });
    await settle();
    await act(async () => {
      finish?.(view("slow", [item({ text: "slow" })]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.chat?.channel).toBe("fast");
  });
});
