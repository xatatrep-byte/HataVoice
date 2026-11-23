// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import type { ItemView } from "../../chat/api";
import { channel, member, serverState } from "../../server/testState";
import { ChatView } from "./ChatView";
import { matches } from "./Search";

const item = (id: string, text: string, over: Partial<ItemView> = {}): ItemView => ({
  id,
  seq: Number(id.slice(1)),
  at: 1_800_000_000,
  author: "a000",
  text,
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
    if (command === "chat_view") return { channel: "general", items, last_seq: items.length };
    if (command === "chat_status") return "ready";
    return null;
  });
  render(<ChatView address="a:1" channel={channel("general", "Общий")} state={serverState({ members: [member("me00", "Петя"), member("a000", "Аня")] })} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  invoke.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("search", () => {
  it("matches text and file names, any case, ё as е", () => {
    const names = new Map([["a000", "Аня"]]);
    expect(matches(item("m1", "Ещё раз про ЁЛКУ"), "елку", names)).toBe(true);
    expect(matches(item("m2", "<@a000> привет"), "аня", names)).toBe(true);
    expect(matches(item("m3", "", { files: [{ blob: "x", size: 1, name: "Отчёт.pdf", mime: "application/octet-stream" }] }), "отчет", names)).toBe(true);
    expect(matches(item("m4", "", { deleted: true }), "", names)).toBe(false);
    expect(matches(item("m5", "другое"), "елку", names)).toBe(false);
  });

  it("Ctrl+F opens it, a result scrolls to its message, Esc closes it", async () => {
    await open([item("m1", "пойдём в танки"), item("m2", "лучше в CS2"), item("m3", "ТАНКИ так танки")]);
    fireEvent.keyDown(screen.getByRole("region", { name: "Чат «Общий»" }), { key: "f", ctrlKey: true });
    const box = screen.getByRole("searchbox", { name: "Поиск по чату" });
    fireEvent.change(box, { target: { value: "танки" } });
    const results = within(screen.getByRole("list", { name: "Найдено" })).getAllByRole("button");
    expect(results.map((r) => r.textContent?.includes("танки") || r.textContent?.includes("ТАНКИ"))).toEqual([true, true]);
    fireEvent.click(results[1]!);
    const found = document.querySelector('[data-id="m3"]')!;
    expect(found.scrollIntoView).toHaveBeenCalled();
    expect(found.classList.contains("found")).toBe(true);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("the magnifier opens it too, and says when nothing is found", async () => {
    await open([item("m1", "привет")]);
    fireEvent.click(screen.getByRole("button", { name: "Поиск" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск по чату" }), { target: { value: "пока" } });
    expect(screen.getByText("Ничего не нашлось")).toBeTruthy();
  });
});
