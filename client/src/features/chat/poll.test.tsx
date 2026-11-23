// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import type { ItemView, PollView } from "../../chat/api";
import { channel, member, serverState } from "../../server/testState";
import { ChatView } from "./ChatView";
import { PollCard, votesLabel } from "./PollCard";
import { PollDialog } from "./PollDialog";

const people = new Map([member("me00", "Петя"), member("a000", "Аня"), member("b000", "Вася")].map((m) => [m.user_id, m]));

const pollItem = (poll: Partial<PollView> = {}, author = "a000"): ItemView => ({
  id: "p1",
  seq: 1,
  at: 1_800_000_000,
  author,
  text: "",
  reply: null,
  edited: false,
  deleted: false,
  reactions: [],
  poll: {
    question: "Во что играем?",
    options: [
      { text: "CS2", voters: ["a000", "me00"] },
      { text: "Танки", voters: ["b000"] },
      { text: "Дота", voters: [] },
    ],
    multi: false,
    closed: false,
    ...poll,
  },
  files: [],
  mentions_me: false,
});

function card(item: ItemView) {
  const onVote = vi.fn();
  const onClose = vi.fn();
  render(<PollCard item={item} me="me00" members={people} onVote={onVote} onClose={onClose} />);
  return { onVote, onClose };
}

const option = (text: string) => screen.getByRole("button", { name: new RegExp(text) });

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

describe("PollDialog", () => {
  it("asks a question and 2–10 options, and creates only when all are filled", async () => {
    const onCreate = vi.fn(async () => null);
    const onClose = vi.fn();
    render(<PollDialog open onClose={onClose} onCreate={onCreate} onError={() => {}} />);
    const create = screen.getByRole("button", { name: "Создать" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Убрать вариант 1" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Вопрос"), { target: { value: "Во что играем?" } });
    fireEvent.change(screen.getByLabelText("Вариант 1"), { target: { value: "CS2" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Вариант 2"), { target: { value: "Танки" } });
    expect(create.disabled).toBe(false);

    const add = screen.getByRole("button", { name: /Добавить вариант/ }) as HTMLButtonElement;
    for (let n = 0; n < 8; n++) fireEvent.click(add);
    expect(screen.getAllByLabelText(/^Вариант \d+$/)).toHaveLength(10);
    expect(add.disabled).toBe(true);
    expect(create.disabled, "the new options are empty").toBe(true);
    for (let n = 10; n > 2; n--) fireEvent.click(screen.getByRole("button", { name: `Убрать вариант ${n}` }));
    fireEvent.click(screen.getByRole("switch", { name: "Можно выбрать несколько" }));
    await act(async () => {
      fireEvent.click(create);
    });
    expect(onCreate).toHaveBeenCalledWith("Во что играем?", ["CS2", "Танки"], true);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("PollCard", () => {
  it("shows each option's share, its votes and who chose it", () => {
    card(pollItem());
    expect(option("CS2").textContent).toContain("67% · 2 голоса");
    expect(option("Танки").textContent).toContain("33% · 1 голос");
    expect(option("Дота").textContent).toContain("0% · 0 голосов");
    const voters = within(screen.getByLabelText("Выбрали «CS2»")).getAllByTitle(/./).map((v) => v.title);
    expect(voters).toEqual(["Аня", "Петя"]);
    expect(screen.getByText(/Голоса видны всем/)).toBeTruthy();
    expect(option("CS2").getAttribute("aria-pressed")).toBe("true");
  });

  it("a click votes; our own option clicked again takes the vote back", () => {
    const { onVote } = card(pollItem());
    fireEvent.click(option("Танки"));
    fireEvent.click(option("CS2"));
    expect(onVote.mock.calls).toEqual([[[1]], [[]]]);
  });

  it("with several allowed, a click adds or removes that option", () => {
    const { onVote } = card(pollItem({ multi: true }));
    fireEvent.click(option("Дота"));
    fireEvent.click(option("CS2"));
    expect(onVote.mock.calls).toEqual([[[0, 2]], [[]]]);
  });

  it("only the author ends it, and an ended poll takes no votes", () => {
    expect(card(pollItem()).onClose).toBeDefined();
    expect(screen.queryByRole("button", { name: "Завершить" })).toBeNull();
    cleanup();
    const { onClose } = card(pollItem({}, "me00"));
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    expect(onClose).toHaveBeenCalled();
    cleanup();
    const { onVote } = card(pollItem({ closed: true }, "me00"));
    expect(screen.queryByRole("button", { name: "Завершить" })).toBeNull();
    expect((option("CS2") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option("Танки"));
    expect(onVote).not.toHaveBeenCalled();
    expect(screen.getByText(/Голосование завершено/)).toBeTruthy();
  });

  it("counts votes the Russian way", () => {
    expect([0, 1, 2, 5, 11, 21, 22, 112].map(votesLabel)).toEqual([
      "0 голосов",
      "1 голос",
      "2 голоса",
      "5 голосов",
      "11 голосов",
      "21 голос",
      "22 голоса",
      "112 голосов",
    ]);
  });
});

describe("polls in the chat", () => {
  it("«Голосование» opens the dialog and a vote goes to the chat", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "chat_view") return { channel: "general", items: [pollItem()], last_seq: 1 };
      if (command === "chat_status") return "ready";
      return null;
    });
    render(<ChatView address="a:1" channel={channel("general", "Общий")} state={serverState({ members: [...people.values()] })} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(option("Танки"));
    expect(invoke).toHaveBeenCalledWith("chat_vote", { address: "a:1", poll: "p1", choice: [1] });
    fireEvent.click(screen.getByRole("button", { name: "Голосование" }));
    fireEvent.change(screen.getByLabelText("Вопрос"), { target: { value: "Когда?" } });
    fireEvent.change(screen.getByLabelText("Вариант 1"), { target: { value: "Сейчас" } });
    fireEvent.change(screen.getByLabelText("Вариант 2"), { target: { value: "Вечером" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    });
    expect(invoke).toHaveBeenCalledWith("chat_poll", { address: "a:1", channel: "general", question: "Когда?", options: ["Сейчас", "Вечером"], multi: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
