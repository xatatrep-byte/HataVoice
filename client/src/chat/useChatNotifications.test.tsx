// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const sent = vi.hoisted(() => [] as { title: string; body: string }[]);
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: (text: { title: string; body: string }) => void sent.push(text),
}));

import type { ChatMessage } from "./api";
import { channel, member, serverState } from "../server/testState";
import { useChatNotifications } from "./useChatNotifications";

const state = serverState({
  members: [member("me00", "Петя"), member("a000", "Аня")],
  channels: [channel("general", "Общий"), channel("chat", "Болталка", { kind: "text" })],
});

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  address: "a:1",
  channel: "chat",
  id: "m1",
  author: "a000",
  text: "привет",
  files: [],
  mentions_me: false,
  poll: false,
  ...over,
});

const emit = (payload: ChatMessage) =>
  act(async () => {
    listeners.get("chat-message")?.({ payload });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  sent.length = 0;
  listeners.clear();
});

describe("useChatNotifications", () => {
  it("shows a message of a text channel in «Все», named from the server's state", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderHook(() => useChatNotifications({ mode: "all", showText: true, state, open: null }));
    await emit(message());
    expect(sent).toEqual([{ title: "Аня · #Болталка", body: "привет" }]);
  });

  it("keeps quiet in «Упоминания» unless we are mentioned, and about the chat open in front", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { rerender } = renderHook((props: { open: { address: string; channel: string } | null }) =>
      useChatNotifications({ mode: "mentions", showText: false, state, open: props.open }), { initialProps: { open: null as { address: string; channel: string } | null } });
    await emit(message());
    expect(sent).toEqual([]);
    await emit(message({ id: "m2", mentions_me: true }));
    expect(sent).toEqual([{ title: "Аня · #Болталка", body: "Новое сообщение" }]);
    // Later than the throttle's two seconds, so only the open chat keeps it quiet.
    const later = Date.now() + 5000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    focus.mockReturnValue(true);
    rerender({ open: { address: "a:1", channel: "chat" } });
    await emit(message({ id: "m3", channel: "chat", mentions_me: true }));
    expect(sent).toHaveLength(1);
    rerender({ open: { address: "a:1", channel: "general" } });
    await emit(message({ id: "m4", channel: "chat", mentions_me: true }));
    expect(sent, "another channel is open").toHaveLength(2);
  });
});
