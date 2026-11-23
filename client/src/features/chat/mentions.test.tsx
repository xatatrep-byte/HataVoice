// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import type { ItemView } from "../../chat/api";
import { markRead, mentionCounts } from "../../chat/unread";
import { channel, member, serverState } from "../../server/testState";
import { ChatList } from "../drawer/ChatList";
import { ChatView } from "./ChatView";
import { MessageText } from "./MessageText";

const people = [member("me00", "Петя"), member("a000", "Аня"), member("a001", "Андрей"), member("b000", "Вася")];
const names = new Map(people.map((m) => [m.user_id, m.nickname]));

const item = (over: Partial<ItemView> = {}): ItemView => ({
  id: "m1",
  seq: 1,
  at: 1_800_000_000,
  author: "a000",
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

async function open(items: ItemView[]) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "chat_view") return { channel: "general", items, last_seq: 1 };
    if (command === "chat_status") return "ready";
    return null;
  });
  render(<ChatView address="a:1" channel={channel("general", "Общий")} state={serverState({ members: people })} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(field(), { target: { value: text, selectionStart: text.length } });

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

describe("mentions", () => {
  it("@ and letters list the people, Enter puts one in, and it goes as <@id>", async () => {
    await open([]);
    type("@Ан");
    const list = screen.getByRole("listbox", { name: "Упомянуть" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Аня", "Андрей"]);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("@Андрей ");
    expect(screen.queryByRole("listbox", { name: "Упомянуть" })).toBeNull();
    type("@Андрей привет, @Петя");
    expect(screen.queryByRole("listbox", { name: "Упомянуть" }), "not ourselves").toBeNull();
    type("@Андрей привет");
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    const sent = invoke.mock.calls.find(([name]) => name === "chat_send")![1];
    expect(sent.text).toBe("<@a001> привет");
  });

  it("Esc closes the list without dropping the text", async () => {
    await open([]);
    type("@В");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Упомянуть" })).toBeNull();
    expect(field().value).toBe("@В");
  });

  it("shows <@id> as @Ник, someone unknown as @кто-то, and us marked", () => {
    const { container } = render(<MessageText text="<@a000> и <@me00>, и <@zzzz>" names={names} me="me00" />);
    expect(container.textContent).toBe("@Аня и @Петя, и @кто-то");
    expect(container.querySelector(".mention.me")!.textContent).toBe("@Петя");
  });

  it("a message that mentions us stands out, and editing it shows names, not ids", async () => {
    await open([item({ mentions_me: true, text: "<@me00> глянь" }), item({ id: "m2", seq: 2, author: "me00", text: "<@a000> ок" })]);
    const rows = screen.getAllByRole("listitem").filter((li) => li.classList.contains("msg"));
    expect(rows[0]!.classList.contains("mentioned")).toBe(true);
    expect(rows[1]!.classList.contains("mentioned")).toBe(false);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(field().value).toBe("@Аня ок");
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(invoke.mock.calls.find(([name]) => name === "chat_edit"), "nothing changed").toBeUndefined();
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    type("@Аня ок!");
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(invoke.mock.calls.find(([name]) => name === "chat_edit")![1]).toEqual({ address: "a:1", id: "m2", text: "<@a000> ок!" });
  });

  it("a channel shows how many times we are mentioned", () => {
    render(
      <ChatList
        state={serverState({ channels: [channel("chat", "Болталка", { kind: "text" })] })}
        callChannel={null}
        dms={[]}
        unread={{ chat: 5 }}
        mentions={{ chat: 2 }}
        onOpen={() => {}}
        onPost={async () => {}}
        onWrite={() => {}}
      />,
    );
    expect(screen.getByLabelText("Упоминаний: 2").textContent).toBe("@2");
  });

  it("counts mentions after the read mark", () => {
    expect(mentionCounts("a:1", { general: [3, 8], games: [] })).toEqual({ general: 2 });
    markRead("a:1", "general", 5);
    expect(mentionCounts("a:1", { general: [3, 8] })).toEqual({ general: 1 });
  });
});
