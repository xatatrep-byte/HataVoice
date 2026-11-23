// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { channel, member, serverState } from "../../server/testState";
import { ChatView } from "./ChatView";
import { typingText } from "./Typing";

const people = [member("me00", "Петя"), member("a000", "Аня"), member("b000", "Боря"), member("c000", "Вася")];

async function open() {
  invoke.mockImplementation(async (command: string) => {
    if (command === "chat_view") return { channel: "general", items: [], last_seq: 0 };
    if (command === "chat_status") return "ready";
    return null;
  });
  render(<ChatView address="a:1" channel={channel("general", "Общий")} state={serverState({ members: people })} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const typing = (user: string, channelId = "general", address = "a:1") =>
  act(async () => {
    listeners.get("chat-typing")?.({ payload: { address, channel: channelId, user } });
    await vi.advanceTimersByTimeAsync(0);
  });

const line = () => document.querySelector(".chat-typing")?.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  listeners.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("typing", () => {
  it("says who types, in Russian", () => {
    expect(typingText(["Аня"])).toBe("Аня печатает…");
    expect(typingText(["Аня", "Боря"])).toBe("Аня и Боря печатают…");
    expect(typingText(["Аня", "Боря", "Вася"])).toBe("Несколько человек печатают…");
    expect(typingText([])).toBe("");
  });

  it("shows those typing in this channel and lets them go after six seconds or with their message", async () => {
    await open();
    await typing("a000");
    await typing("b000", "games");
    await typing("c000", "general", "b:2");
    expect(line()).toBe("Аня печатает…");
    await typing("b000");
    expect(line()).toBe("Аня и Боря печатают…");
    await act(async () => {
      listeners.get("chat-message")?.({ payload: { address: "a:1", channel: "general", id: "m", author: "b000", text: "", files: [], mentions_me: false, poll: false } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(line()).toBe("Аня печатает…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(line()).toBe("");
  });

  it("tells the others we type, at most every three seconds", async () => {
    await open();
    const field = screen.getByRole("textbox");
    const typed = () => invoke.mock.calls.filter(([name]) => name === "chat_typing").length;
    fireEvent.change(field, { target: { value: "п" } });
    fireEvent.change(field, { target: { value: "пр" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    fireEvent.change(field, { target: { value: "при" } });
    expect(typed()).toBe(1);
    expect(invoke).toHaveBeenCalledWith("chat_typing", { address: "a:1", channel: "general" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    fireEvent.change(field, { target: { value: "прив" } });
    expect(typed()).toBe(2);
  });
});
