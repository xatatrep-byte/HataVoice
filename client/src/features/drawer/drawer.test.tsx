// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { channel, member, serverState } from "../../server/testState";
import type { Body } from "../../server/session";
import { LEAVE_MS, PEEK_MS, useDrawer } from "./useDrawer";
import { ChatList } from "./ChatList";

afterEach(cleanup);

describe("the panel at the left", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("slides out once the mouse rests at the edge, not when it only passes by", () => {
    const { result } = renderHook(() => useDrawer());
    act(() => result.current.edgeEnter());
    act(() => vi.advanceTimersByTime(PEEK_MS - 50));
    act(() => result.current.edgeLeave());
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.open).toBe(false);

    act(() => result.current.edgeEnter());
    act(() => vi.advanceTimersByTime(PEEK_MS));
    expect(result.current).toMatchObject({ open: true, peek: true });
  });

  it("opened by the edge, goes when the mouse leaves it, and stays if the mouse comes back in time", () => {
    const { result } = renderHook(() => useDrawer());
    act(() => result.current.edgeEnter());
    act(() => vi.advanceTimersByTime(PEEK_MS));
    // The edge lies under the panel now: leaving the edge for the panel changes nothing.
    act(() => result.current.edgeLeave());
    act(() => result.current.leave());
    act(() => vi.advanceTimersByTime(LEAVE_MS - 100));
    act(() => result.current.enter());
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(result.current.open).toBe(true);
    act(() => result.current.leave());
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(result.current.open).toBe(false);
  });

  it("the mouse moving on away does not hold it open", () => {
    const { result } = renderHook(() => useDrawer());
    act(() => result.current.edgeEnter());
    act(() => vi.advanceTimersByTime(PEEK_MS));
    for (let i = 0; i < 5; i++) {
      act(() => result.current.leave());
      act(() => vi.advanceTimersByTime(LEAVE_MS / 4));
    }
    expect(result.current.open).toBe(false);
  });

  it("touched, it stays when the mouse leaves", () => {
    const { result } = renderHook(() => useDrawer());
    act(() => result.current.edgeEnter());
    act(() => vi.advanceTimersByTime(PEEK_MS));
    act(() => result.current.touch());
    act(() => result.current.leave());
    act(() => vi.advanceTimersByTime(LEAVE_MS * 3));
    expect(result.current).toMatchObject({ open: true, peek: false });
  });

  it("opened by a click it stays, on the tab asked for; a click on the button again closes it", () => {
    const { result } = renderHook(() => useDrawer());
    act(() => result.current.show("people"));
    expect(result.current).toMatchObject({ open: true, peek: false, tab: "people" });
    act(() => result.current.leave());
    act(() => vi.advanceTimersByTime(LEAVE_MS * 3));
    expect(result.current.open).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.open).toBe(false);
  });

  it("a click on the button while it only peeks keeps it open", () => {
    const { result } = renderHook(() => useDrawer());
    act(() => result.current.edgeEnter());
    act(() => vi.advanceTimersByTime(PEEK_MS));
    act(() => result.current.toggle());
    expect(result.current).toMatchObject({ open: true, peek: false });
  });
});

describe("the chats in the panel", () => {
  const manager = { user_id: "me00", is_owner: false, permissions: ["manage_channels" as const], rank: 1 };
  const mixed = [channel("general", "Общий"), channel("chat", "Болталка", { kind: "text" }), channel("games", "Игры"), channel("news", "Новости", { kind: "text" })];
  const list = (over: Partial<Parameters<typeof ChatList>[0]> = {}) => {
    const props = {
      state: serverState({ channels: mixed, members: [member("me00", "Я"), member("a000", "Аня")] }),
      callChannel: null,
      dms: [],
      unread: {},
      mentions: {},
      onOpen: vi.fn(),
      onPost: vi.fn(async (_body: Body) => {}),
      onWrite: vi.fn(),
      ...over,
    };
    render(<ChatList {...props} />);
    return props;
  };

  it("lists the house's chats, not its rooms, with what is unread and how often we are mentioned", () => {
    const props = list({ unread: { chat: 3, news: 250, games: 1 }, mentions: { chat: 2 } });
    const names = [...document.querySelectorAll(".drawer-row .row-name")].map((n) => n.textContent);
    expect(names).toEqual(["Болталка", "Новости"]);
    expect(screen.getByLabelText("Упоминаний: 2").textContent).toBe("@2");
    expect(screen.getByLabelText("Непрочитанных: 250").textContent).toBe("99+");
    fireEvent.click(screen.getByRole("button", { name: /Болталка/ }));
    expect(props.onOpen).toHaveBeenCalledWith("chat");
  });

  it("puts the chat of the room we are in first", () => {
    const props = list({ callChannel: mixed[0]!, unread: { general: 4 } });
    const room = screen.getByRole("region", { name: "Комната, где ты сейчас" });
    expect(room.textContent).toContain("Общий");
    expect(room.textContent).toContain("4");
    fireEvent.click(screen.getByRole("button", { name: /Общий/ }));
    expect(props.onOpen).toHaveBeenCalledWith("general");
  });

  it("a closed chat shows its lock", () => {
    list({ state: serverState({ channels: [{ ...channel("staff", "Админская"), kind: "text", closed: true }] }) });
    expect(screen.getByLabelText("Закрытый чат")).toBeTruthy();
  });

  it("lists direct messages by the other one's name, with unread, and opens them", () => {
    const props = list({ dms: [{ channel: "dm.a000.me00", peer: "a000", last: 7 }], unread: { "dm.a000.me00": 2 } });
    const row = screen.getByTitle("Личные сообщения: Аня");
    expect(row.textContent).toContain("2");
    fireEvent.click(row);
    expect(props.onOpen).toHaveBeenCalledWith("dm.a000.me00");
  });

  it("«Написать другу» leads to the people", () => {
    const props = list();
    fireEvent.click(screen.getByRole("button", { name: "Написать другу" }));
    expect(props.onWrite).toHaveBeenCalledTimes(1);
  });

  it("a channel manager adds a chat and moves chats among themselves", () => {
    const props = list({ state: serverState({ channels: mixed, me: manager }) });
    expect((screen.getByRole("button", { name: "Поднять «Болталка»" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Опустить «Болталка»" }));
    expect(props.onPost).toHaveBeenLastCalledWith({ type: "channel_order", ids: ["general", "news", "games", "chat"] });
    fireEvent.click(screen.getByRole("button", { name: "Новый чат" }));
    fireEvent.change(screen.getByPlaceholderText("Как назвать"), { target: { value: "Мемы" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(props.onPost).toHaveBeenLastCalledWith({ type: "channel_create", id: "memy", name: "Мемы", user_limit: 0, overrides: [], kind: "text" });
  });

  it("without the right there is nothing to edit, and no chats is said so", () => {
    list({ state: serverState({ channels: [channel("general", "Общий")] }) });
    expect(screen.queryByRole("button", { name: "Новый чат" })).toBeNull();
    expect(screen.getByText("Чатов пока нет")).toBeTruthy();
  });
});
