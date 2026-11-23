// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

import type { GroupStatus, HistoryNote, ItemView } from "../../chat/api";
import { unreadCounts } from "../../chat/unread";
import type { ChannelView, ServerStateView } from "../../server/session";
import { channel, member, serverState } from "../../server/testState";
import { ChatView } from "./ChatView";

const T = 1_800_000_000;
const item = (id: string, over: Partial<ItemView> = {}): ItemView => ({
  id,
  seq: Number(id.replace(/\D/g, "")) || 1,
  at: T,
  author: "a000",
  text: id,
  reply: null,
  edited: false,
  deleted: false,
  reactions: [],
  poll: null,
  files: [],
  mentions_me: false,
  ...over,
});

const people = [member("me00", "Петя"), member("a000", "Аня", { color: "pink" }), member("b000", "Вася")];

function open(
  items: ItemView[],
  options: { status?: GroupStatus; state?: Partial<ServerStateView>; channel?: ChannelView; history?: HistoryNote } = {},
) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "chat_view") return { channel: "general", items, last_seq: items[items.length - 1]?.seq ?? 0, history: options.history };
    if (command === "chat_status") return options.status ?? "ready";
    return null;
  });
  render(
    <ChatView
      address="a:1"
      channel={options.channel ?? channel("general", "Общий")}
      state={serverState({ members: people, ...options.state })}
    />,
  );
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const messages = () => screen.getAllByRole("listitem").filter((li) => li.classList.contains("msg"));
const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const sent = (command: string) => invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

beforeEach(() => {
  invoke.mockReset();
  listeners.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe("ChatView", () => {
  it("puts one header over an author's messages close in time", async () => {
    await open([
      item("m1", { at: T }),
      item("m2", { at: T + 60 }),
      item("m3", { at: T + 400 }),
      item("m4", { at: T + 410, author: "b000" }),
      item("m5", { at: T + 420, author: "b000", reply: { id: "m1", author: "a000", text: "m1" } }),
    ]);
    expect(messages().map((li) => li.querySelector(".msg-author")?.textContent ?? null)).toEqual(["Аня", null, "Аня", "Вася", "Вася"]);
  });

  it("a reply quotes the message, an edit and a deletion say so", async () => {
    await open([
      item("m1", { text: "кто в танки?", edited: true }),
      item("m2", { author: "me00", text: "я", reply: { id: "m1", author: "a000", text: "кто в танки?" } }),
      item("m3", { deleted: true, text: "" }),
      item("m4", { reply: { id: "m3", author: "a000", text: "" } }),
    ]);
    const [first, second, third, fourth] = messages();
    expect(first!.querySelector(".msg-text")!.textContent, "the mark stays on the text's line").toBe("кто в танки? (изменено)");
    expect(within(second!).getByText("кто в танки?").closest(".msg-quote")!.textContent).toContain("Аня");
    expect(third!.textContent).toContain("Сообщение удалено");
    expect(within(third!).queryByRole("button", { name: "Ответить" })).toBeNull();
    expect(fourth!.querySelector(".msg-quote")!.textContent).toContain("Сообщение удалено");
  });

  it("shows reactions with a count and who put them, and toggles ours", async () => {
    await open([item("m1", { reactions: [{ emoji: "👍", users: ["a000", "me00"] }, { emoji: "🔥", users: ["b000"] }] })]);
    const thumbs = screen.getByRole("button", { name: "👍 2" });
    expect(thumbs.title).toBe("Аня, Петя");
    expect(thumbs.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(thumbs);
    fireEvent.click(screen.getByRole("button", { name: "🔥 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Реакция" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Реакции" })).getByRole("button", { name: "😂" }));
    expect(sent("chat_react")).toEqual([
      { address: "a:1", id: "m1", emoji: "👍", on: false },
      { address: "a:1", id: "m1", emoji: "🔥", on: true },
      { address: "a:1", id: "m1", emoji: "😂", on: true },
    ]);
  });

  it("offers editing only on our own messages, deleting also to channel managers", async () => {
    await open([item("m1", { author: "me00" }), item("m2")]);
    const [mine, theirs] = messages();
    expect(within(mine!).getByRole("button", { name: "Изменить" })).toBeTruthy();
    expect(within(mine!).getByRole("button", { name: "Удалить" })).toBeTruthy();
    expect(within(theirs!).getByRole("button", { name: "Ответить" })).toBeTruthy();
    expect(within(theirs!).queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(within(theirs!).queryByRole("button", { name: "Удалить" })).toBeNull();
    cleanup();
    await open([item("m2")], { state: { me: { user_id: "me00", is_owner: false, permissions: ["manage_channels"], rank: 1 } } });
    fireEvent.click(within(messages()[0]!).getByRole("button", { name: "Удалить" }));
    expect(sent("chat_delete")).toEqual([{ address: "a:1", id: "m2" }]);
  });

  it("Enter sends, Shift+Enter does not, Esc drops the reply", async () => {
    await open([item("m1")]);
    fireEvent.change(field(), { target: { value: "привет" } });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(sent("chat_send")).toEqual([]);
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(sent("chat_send")).toEqual([{ address: "a:1", channel: "general", text: "привет", reply: null, files: [] }]);
    expect(field().value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    expect(screen.getByText("Ответ: Аня")).toBeTruthy();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByText("Ответ: Аня")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    fireEvent.change(field(), { target: { value: "да" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(sent("chat_send")[1]).toEqual({ address: "a:1", channel: "general", text: "да", reply: "m1", files: [] });
  });

  it("↑ in an empty field edits our last message", async () => {
    await open([item("m1", { author: "me00", text: "превет" }), item("m2"), item("m3", { author: "me00", poll: { question: "?", options: [], multi: false, closed: false } })]);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(field().value).toBe("превет");
    expect(screen.getByText("Изменение сообщения")).toBeTruthy();
    fireEvent.change(field(), { target: { value: "привет" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(sent("chat_edit")).toEqual([{ address: "a:1", id: "m1", text: "привет" }]);
    expect(sent("chat_send")).toEqual([]);
  });

  it("keeps the field off until the chat has its keys, and says why", async () => {
    await open([], { status: "joining" });
    expect(field().disabled).toBe(true);
    expect(field().placeholder).toBe("Подключаю шифрование чата…");
    await act(async () => {
      listeners.get("chat-status")?.({ payload: { address: "a:1", status: "waiting" } });
    });
    expect(field().placeholder).toBe("Ждём кого-нибудь из участников: он добавит тебя в шифрование");
    await act(async () => {
      listeners.get("chat-status")?.({ payload: { address: "a:1", status: "ready" } });
    });
    expect(field().disabled).toBe(false);
  });

  it("says the chat is encrypted above the first message, and marks the channel read", async () => {
    await open([item("m1", { seq: 4 }), item("m2", { seq: 9 })]);
    expect(screen.getByText("Сообщения зашифрованы, сервер их не видит")).toBeTruthy();
    expect(unreadCounts("a:1", { general: [4, 9, 12] })).toEqual({ general: 1 });
  });

  it("tells a newcomer who passed them the history, or why there is none", async () => {
    await open([item("m1", { seq: 4 })], { history: { state: "passed", from: "a000", before: 9 } });
    expect(screen.getByText("Сообщения до твоего входа передал(а) Аня")).toBeTruthy();
    cleanup();
    await open([], { history: { state: "off", from: "a000", before: 9 } });
    expect(screen.getByText("Владелец не передаёт новичкам историю")).toBeTruthy();
    cleanup();
    await open([], { history: { state: "failed", from: "a000", before: 9 } });
    expect(screen.getByText("История до твоего входа не загрузилась")).toBeTruthy();
    cleanup();
    await open([item("m1")]);
    expect(screen.queryByText(/до твоего входа/)).toBeNull();
  });

  it("a closed channel has its own chat, with a lock: its keys are only theirs", async () => {
    await open([item("m1")], { channel: channel("staff", "Админская", { closed: true }) });
    expect(screen.getByLabelText("Закрытый чат: его ключи только у тех, кто его видит")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(sent("chat_view")).toEqual([{ address: "a:1", channel: "staff" }]);
  });

  it("direct messages are named after the other one", async () => {
    const { dmChannel } = await import("./dm");
    await open([item("m1")], { channel: dmChannel("dm.aaa.bbb", "Борис") });
    expect(screen.getByRole("banner").textContent).toContain("Борис");
    expect(screen.getByLabelText("Личные сообщения: ключи только у вас двоих")).toBeTruthy();
    expect(sent("chat_view")).toEqual([{ address: "a:1", channel: "dm.aaa.bbb" }]);
  });
});
