// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn(async () => null) }));

import { BoardSync, type BoardKeys } from "../../board/sync";
import { BoardView } from "./BoardView";

afterEach(cleanup);

const keys: BoardKeys = { own: () => null, of: () => null };
const people = [{ id: "anna", name: "Аня" }];
const nameOf = (id: string) => ({ teacher: "Учитель", anna: "Аня" })[id] ?? id;

function view(me: string, setup: (teacher: BoardSync) => void = () => {}) {
  const teacher = new BoardSync("teacher", keys, async () => {});
  teacher.open();
  setup(teacher);
  const sync = me === "teacher" ? teacher : new BoardSync(me, keys, async () => {});
  if (me !== "teacher") sync.board = teacher.board;
  const result = render(<BoardView controls={{ board: sync.board, sync, me }} people={people} nameOf={nameOf} />);
  return { ...result, sync, teacher, again: () => result.rerender(<BoardView controls={{ board: sync.board, sync, me }} people={people} nameOf={nameOf} />) };
}

describe("the drawing board's view", () => {
  it("the teacher has the tools, each with its key, and chooses who draws", () => {
    const { sync, again } = view("teacher");
    expect(screen.getByRole("toolbar", { name: "Инструменты доски" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ластик" }).getAttribute("title")).toBe("Ластик (E)");
    fireEvent.click(screen.getByRole("button", { name: /Кто рисует/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Аня" }));
    expect(sync.board.allowed).toEqual(["anna"]);
    again();
    expect(screen.getByText(/рисуют: Учитель, Аня/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Все в звонке" }));
    expect(sync.board.everyone).toBe(true);
  });

  it("keys pick tools, colours and take a stroke back", () => {
    const { sync } = view("teacher", (t) => void t.startPath("pen", "#111111", 3, [1, 1, 5, 5]));
    act(() => void fireEvent.keyDown(window, { key: "e", code: "KeyE" }));
    expect(screen.getByRole("button", { name: "Ластик" }).getAttribute("aria-pressed")).toBe("true");
    act(() => void fireEvent.keyDown(window, { key: "3", code: "Digit3" }));
    expect(screen.getByRole("button", { name: "Синий" }).getAttribute("aria-pressed")).toBe("true");
    act(() => void fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true }));
    expect(sync.board.strokes).toEqual([]);
    act(() => void fireEvent.keyDown(window, { key: "?", code: "Slash", shiftKey: true }));
    expect(screen.getByRole("dialog", { name: "Горячие клавиши доски" })).toBeTruthy();
  });

  it("a pupil not allowed sees the board and who draws, with no tools", () => {
    view("anna");
    expect(screen.queryByRole("toolbar", { name: "Инструменты доски" })).toBeNull();
    expect(screen.getByText(/попроси ведущего/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Кто рисует/ })).toBeNull();
  });

  it("only the teacher clears it, after asking", () => {
    const { sync } = view("teacher", (t) => void t.startPath("pen", "#111111", 3, [1, 1]));
    act(() => void fireEvent.keyDown(window, { key: "Delete", code: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    expect(sync.board.strokes).toEqual([]);
  });
});
