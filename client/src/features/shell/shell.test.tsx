// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { CommandPalette, findCommands, type Command } from "./CommandPalette";
import { useUpdate } from "./useUpdate";
import { useToasts } from "../../ui/toasts";

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (command: string, args?: unknown) => invoke(command, args) }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
  useToasts.setState({ toasts: [] });
});

const command = (title: string, kind = "Комната", words?: string): Command => ({ id: title, title, kind, words, run: vi.fn() });

describe("the palette", () => {
  const all = [command("Кухня"), command("Гостиная"), command("Шумодав", "Настройки", "микрофон звук"), command("Кухонный чат", "Чат")];

  it("shows everything until something is typed", () => {
    expect(findCommands(all, "  ")).toEqual(all);
  });

  it("finds by a few letters, by kind and by other words, what begins with them first", () => {
    expect(findCommands(all, "кух").map((c) => c.title)).toEqual(["Кухня", "Кухонный чат"]);
    expect(findCommands(all, "настройки").map((c) => c.title)).toEqual(["Шумодав"]);
    expect(findCommands(all, "микрофон").map((c) => c.title)).toEqual(["Шумодав"]);
    expect(findCommands(all, "кух чат").map((c) => c.title)).toEqual(["Кухонный чат"]);
    expect(findCommands(all, "балкон")).toEqual([]);
  });

  it("walks by arrows, runs by Enter, closes by Esc", () => {
    const onClose = vi.fn();
    render(<CommandPalette open commands={all} onClose={onClose} />);
    const field = screen.getByRole("textbox", { name: "Что найти" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(all[1]!.run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("says so when nothing is found", () => {
    render(<CommandPalette open commands={all} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Что найти" }), { target: { value: "балкон" } });
    expect(screen.getByText("Ничего не нашлось")).toBeTruthy();
  });
});

describe("an update from the server", () => {
  it("is asked for only with a server that answers", async () => {
    invoke.mockResolvedValue({ version: "9.9.9", size: 100 });
    const { result, rerender } = renderHook(({ on }) => useUpdate("a:1", on), { initialProps: { on: false } });
    expect(invoke).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.offer).toEqual({ version: "9.9.9", size: 100 }));
    expect(invoke).toHaveBeenCalledWith("update_check", { address: "a:1" });
  });

  it("no offer is no button", async () => {
    invoke.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdate("a:1", true));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(result.current.offer).toBeNull();
  });

  it("says why when the installer is refused, and can be tried again", async () => {
    invoke.mockImplementation(async (name) => {
      if (name === "update_install") throw "Подпись установщика не сходится: файл подменён или испорчен";
      return { version: "9.9.9", size: 100 };
    });
    const { result } = renderHook(() => useUpdate("a:1", true));
    await waitFor(() => expect(result.current.offer).not.toBeNull());
    result.current.install();
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.text)).toContain("Подпись установщика не сходится: файл подменён или испорчен"));
    expect(result.current.installing).toBe(false);
  });
});
