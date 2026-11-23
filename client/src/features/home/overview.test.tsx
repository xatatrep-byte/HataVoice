// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Body, ServerStateView } from "../../server/session";
import type { SavedServer } from "../../state/servers";
import { channel, member, serverState } from "../../server/testState";
import { NO_CALL, type CallSecurity } from "../../voice/callSecurity";
import type { ParticipantView } from "../../voice/participants";
import { Overview } from "./Overview";
import { HouseMenu } from "../shell/TopBar";

afterEach(cleanup);

const three = [channel("general", "Общий"), channel("games", "Игры"), channel("media", "Кино")];
const manager = { user_id: "me00", is_owner: false, permissions: ["manage_channels" as const], rank: 1 };

const secure: CallSecurity = { state: "secure", code: "12345 67890 00042 99999 01234 55555", members: ["me00", "a000"], error: null };

const onAir = (over: Partial<ParticipantView>): ParticipantView => ({
  identity: "a000",
  name: "Аня",
  speaking: false,
  muted: false,
  isLocal: false,
  quality: "good",
  level: 0,
  deafened: false,
  color: "blue",
  encrypted: true,
  ...over,
});

function renderPanel(
  state: ServerStateView,
  onPost = vi.fn(async (_body: Body) => {}),
  call: {
    activeChannelId?: string;
    participants?: ParticipantView[];
    security?: CallSecurity;
    onJoin?: (id: string) => void;
    unread?: Record<string, number>;
    onInvite?: () => void;
    onPeople?: () => void;
  } = {},
) {
  render(
    <Overview
      server={{ name: "Хата", address: "127.0.0.1:7350" }}
      state={state}
      offline={false}
      activeChannelId={call.activeChannelId ?? null}
      participants={call.participants ?? []}
      security={call.security ?? NO_CALL}
      onJoin={call.onJoin ?? (() => {})}
      unread={call.unread}
      onPost={onPost}
      onInvite={call.onInvite}
      onPeople={call.onPeople}
    />,
  );
  return onPost;
}

describe("the whole house", () => {
  it("never shows you in a channel you are not in, even if the server list is behind", () => {
    renderPanel(
      serverState({
        members: [member("me00", "Петя"), member("o000", "Аня")],
        channels: [channel("general", "Общий", { people: ["me00", "o000"] })],
      }),
    );
    expect(screen.queryByText("Петя")).toBeNull();
    expect(screen.getByText("Аня")).toBeTruthy();
  });

  it("channel list shows limits and who is playing what", () => {
    renderPanel(
      serverState({
        members: [member("me00", "Петя"), member("a000", "Аня", { activity: "CS2" }), member("b000", "Вася"), member("c000", "Гоша")],
        channels: [channel("general", "Общий"), channel("games", "Игры", { user_limit: 8, people: ["a000", "b000", "c000"] })],
      }),
    );
    expect(screen.getByText("3/8")).toBeTruthy();
    expect(screen.getByText("играет в CS2")).toBeTruthy();
  });

  it("a channel you may not join is locked", () => {
    renderPanel(serverState({ channels: [channel("staff", "Админская", { access: { view: true, connect: false, speak: false } })] }));
    const button = screen.getByRole("button", { name: /Админская/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Нет права заходить в эту комнату");
  });

  it("lets a channel manager move a channel down and up", () => {
    const onPost = renderPanel(serverState({ channels: three, me: manager }));
    fireEvent.click(screen.getByRole("button", { name: "Опустить «Общий»" }));
    expect(onPost).toHaveBeenLastCalledWith({ type: "channel_order", ids: ["games", "general", "media"] });
    fireEvent.click(screen.getByRole("button", { name: "Поднять «Кино»" }));
    expect(onPost).toHaveBeenLastCalledWith({ type: "channel_order", ids: ["general", "media", "games"] });
  });

  it("renaming keeps the channel's limit and role rules", () => {
    const rule = { role: "everyone", view: "deny" as const, connect: "inherit" as const, speak: "inherit" as const };
    const onPost = renderPanel(
      serverState({ channels: [channel("general", "Общий", { user_limit: 5, overrides: [rule] })], me: manager }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Переименовать «Общий»" }));
    fireEvent.change(screen.getByPlaceholderText("Как назвать"), { target: { value: "Болталка" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onPost).toHaveBeenLastCalledWith({
      type: "channel_update",
      id: "general",
      name: "Болталка",
      user_limit: 5,
      overrides: [rule],
      kind: "voice",
    });
  });

  it("can't move the first channel up or the last one down", () => {
    renderPanel(serverState({ channels: three, me: manager }));
    expect((screen.getByRole("button", { name: "Поднять «Общий»" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Опустить «Кино»" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows no channel editing without the right", () => {
    renderPanel(serverState({ channels: three }));
    expect(screen.queryByRole("button", { name: "Опустить «Общий»" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить комнату" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Новая комната" })).toBeNull();
  });

  it("a channel hidden from you shows only to channel managers, marked, so they can fix it", () => {
    const hidden = channel("staff", "Админская", { access: { view: false, connect: false, speak: false } });
    renderPanel(serverState({ channels: [channel("general", "Общий"), hidden], me: manager }));
    const button = screen.getByTitle("Скрыта правами. Ты видишь её, потому что управляешь комнатами") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  describe("text channels", () => {
    const mixed = [channel("general", "Общий"), channel("chat", "Болталка", { kind: "text" }), channel("games", "Игры"), channel("news", "Новости", { kind: "text" })];

    it("are not on the home page: it holds the rooms, and a room joins", () => {
      const onJoin = vi.fn();
      renderPanel(serverState({ channels: mixed }), undefined, { onJoin });
      expect([...document.querySelectorAll(".room-grid .room-name")].map((n) => n.textContent)).toEqual(["Общий", "Игры"]);
      expect(screen.queryByText("Болталка")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Игры/ }));
      expect(onJoin).toHaveBeenCalledWith("games");
    });

    it("a room shows what is unread in its chat", () => {
      renderPanel(serverState({ channels: mixed }), undefined, { unread: { games: 1 } });
      expect(screen.getByLabelText("Непрочитанных: 1").closest("button")!.textContent).toContain("Игры");
    });

    it("a new room may be a chat too", () => {
      const onPost = renderPanel(serverState({ channels: mixed, me: manager }));
      fireEvent.click(screen.getByRole("button", { name: "Добавить комнату" }));
      expect(screen.getByRole("button", { name: "Комната" }).getAttribute("aria-pressed")).toBe("true");
      fireEvent.change(screen.getByPlaceholderText("Как назвать"), { target: { value: "Танки" } });
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      expect(onPost).toHaveBeenLastCalledWith({ type: "channel_create", id: "tanki", name: "Танки", user_limit: 0, overrides: [], kind: "voice" });
    });

    it("rooms move among rooms only", () => {
      const onPost = renderPanel(serverState({ channels: mixed, me: manager }));
      fireEvent.click(screen.getByRole("button", { name: "Опустить «Общий»" }));
      expect(onPost).toHaveBeenLastCalledWith({ type: "channel_order", ids: ["games", "chat", "general", "news"] });
    });
  });

  describe("in a call", () => {
    const state = () => serverState({ members: [member("me00", "Петя"), member("a000", "Аня"), member("x000", "Гость")] });
    const me = onAir({ identity: "me00", name: "Петя", isLocal: true });
    const guest = onAir({ identity: "x000", name: "Гость", encrypted: false });
    const call = (security: CallSecurity, participants: ParticipantView[]) => ({ activeChannelId: "general", participants, security });

    it("marks a person outside the call group", () => {
      renderPanel(state(), undefined, call(secure, [me, onAir({}), guest]));
      const marks = screen.getAllByText("не в шифровании");
      expect(marks).toHaveLength(1);
      expect(marks[0]!.closest("li")!.textContent).toContain("Гость");
      expect(marks[0]!.getAttribute("title")).toBe("Не слышно: нет ключей этого звонка");
    });

    it("marks nobody until the call is secure, nor you", () => {
      const pending: CallSecurity = { ...NO_CALL, state: "pending" };
      renderPanel(state(), undefined, call(pending, [onAir({ identity: "me00", isLocal: true, encrypted: false }), guest]));
      expect(screen.queryByText("не в шифровании")).toBeNull();
      cleanup();
      renderPanel(state(), undefined, call(secure, [onAir({ identity: "me00", name: "Петя", isLocal: true, encrypted: false })]));
      expect(screen.queryByText("не в шифровании")).toBeNull();
    });
  });

  it("who else is home is one line, those who play first, and it opens the people", () => {
    const onPeople = vi.fn();
    render(
      <Overview
        server={{ name: "Хата", address: "a:1" }}
        state={serverState({
          members: [member("me00", "Я"), member("a000", "Аня"), member("b000", "Вася", { activity: "CS2" }), member("c000", "Гоша"), member("d000", "Дина"), member("e000", "Ева")],
          channels: [channel("general", "Общий", { people: ["c000"] })],
        })}
        offline={false}
        activeChannelId={null}
        participants={[]}
        security={NO_CALL}
        onJoin={() => {}}
        onPost={async () => {}}
        onPeople={onPeople}
      />,
    );
    const around = screen.getByRole("region", { name: "На сервере" });
    expect([...around.querySelectorAll(".around-name")].map((n) => n.textContent)).toEqual(["Вася", "Аня"]);
    expect(around.textContent).toContain("и ещё 2");
    fireEvent.click(within(around).getByRole("button"));
    expect(onPeople).toHaveBeenCalledTimes(1);
  });

  it("«Позвать друга» is there only for those who may invite", () => {
    const onInvite = vi.fn();
    renderPanel(serverState({ channels: three }), undefined, { onInvite });
    fireEvent.click(screen.getByRole("button", { name: /Позвать друга/ }));
    expect(onInvite).toHaveBeenCalledTimes(1);
    cleanup();
    renderPanel(serverState({ channels: three }));
    expect(screen.queryByRole("button", { name: /Позвать друга/ })).toBeNull();
  });

  it("a room with people stands out, and a crowded one takes two places", () => {
    renderPanel(
      serverState({
        members: [member("me00", "Я"), member("a000", "Аня"), member("b000", "Вася"), member("c000", "Гоша"), member("d000", "Дина")],
        channels: [channel("empty", "Пустая"), channel("two", "Двое", { people: ["a000"] }), channel("many", "Много", { people: ["a000", "b000", "c000", "d000"] })],
      }),
    );
    const roomOf = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) }).closest(".room-card")!;
    expect(roomOf("Пустая").classList.contains("busy")).toBe(false);
    expect(roomOf("Двое").classList.contains("busy")).toBe(true);
    expect(roomOf("Двое").classList.contains("crowd")).toBe(false);
    expect(roomOf("Много").classList.contains("crowd")).toBe(true);
  });

  describe("the house menu", () => {
    const servers: SavedServer[] = [
      { address: "a:1", name: "Хата", color: "blue" },
      { address: "b:2", name: "Работа", color: "green" },
      { address: "c:3", name: "Тихий", color: "pink" },
    ];

    it("lists every house, marks those with news and counts mentions, and switches", () => {
      const onSelect = vi.fn();
      render(
        <HouseMenu
          server={{ name: "Хата", address: "a:1", color: "blue" }}
          servers={servers}
          serversUnread={{ "a:1": { messages: 4, mentions: 1 }, "b:2": { messages: 2, mentions: 0 }, "c:3": { messages: 7, mentions: 3 } }}
          onSelect={onSelect}
          onAdd={() => {}}
        />,
      );
      expect(screen.getByTitle("На других серверах есть новое")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Меню сервера" }));
      const item = (name: RegExp) => screen.getByRole("menuitem", { name });
      expect(item(/Хата/).querySelector(".server-news, .panel-menu-count"), "the open server has no mark").toBeNull();
      expect(item(/Работа/).querySelector(".server-news")).not.toBeNull();
      expect(item(/Тихий/).querySelector(".panel-menu-count")!.getAttribute("aria-label")).toBe("Упоминаний: 3");
      fireEvent.click(item(/Работа/));
      expect(onSelect).toHaveBeenCalledWith("b:2");
    });

    it("holds what used to be pages and buttons of the house: invite, people, settings", () => {
      const onInvite = vi.fn();
      const onPeople = vi.fn();
      const onSettings = vi.fn();
      render(<HouseMenu server={{ name: "Хата", address: "a:1" }} servers={servers} serversUnread={{}} onSelect={() => {}} onAdd={() => {}} onInvite={onInvite} onPeople={onPeople} onSettings={onSettings} />);
      for (const [name, fn] of [["Позвать друга", onInvite], ["Участники сервера", onPeople], ["Настройки сервера", onSettings]] as const) {
        fireEvent.click(screen.getByRole("button", { name: "Меню сервера" }));
        fireEvent.click(screen.getByRole("menuitem", { name }));
        expect(fn).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu"), "the menu closes").toBeNull();
      }
    });
  });
});
