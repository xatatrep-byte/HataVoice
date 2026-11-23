import { describe, expect, it } from "vitest";
import { COLORS, hotkey, SIZES } from "./hotkeys";

const key = (key: string, over: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {}) => ({
  key,
  code: over.code ?? "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("the board's keys, as a teacher would want them", () => {
  it("a letter picks a tool, as in Excalidraw", () => {
    expect(hotkey(key("p"))).toEqual({ do: "tool", tool: "pen" });
    expect(hotkey(key("m"))).toEqual({ do: "tool", tool: "marker" });
    expect(hotkey(key("e"))).toEqual({ do: "tool", tool: "eraser" });
    expect(hotkey(key("l"))).toEqual({ do: "tool", tool: "line" });
    expect(hotkey(key("a"))).toEqual({ do: "tool", tool: "arrow" });
    expect(hotkey(key("r"))).toEqual({ do: "tool", tool: "rect" });
    expect(hotkey(key("o"))).toEqual({ do: "tool", tool: "ellipse" });
    expect(hotkey(key("t"))).toEqual({ do: "tool", tool: "text" });
    expect(hotkey(key("k"))).toEqual({ do: "tool", tool: "laser" });
  });

  it("works on a Russian layout too, by the key's place", () => {
    expect(hotkey(key("з", { code: "KeyP" }))).toEqual({ do: "tool", tool: "pen" });
    expect(hotkey(key("у", { code: "KeyE" }))).toEqual({ do: "tool", tool: "eraser" });
    expect(hotkey(key("я", { code: "KeyZ", ctrlKey: true }))).toEqual({ do: "undo" });
  });

  it("numbers pick colours, brackets the size; Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Ctrl+S, Delete, ?", () => {
    expect(hotkey(key("1"))).toEqual({ do: "color", color: COLORS[0]!.value });
    expect(hotkey(key("8"))).toEqual({ do: "color", color: COLORS[7]!.value });
    expect(hotkey(key("9"))).toBeNull();
    expect(hotkey(key("]"))).toEqual({ do: "size", step: 1 });
    expect(hotkey(key("["))).toEqual({ do: "size", step: -1 });
    expect(hotkey(key("z", { ctrlKey: true }))).toEqual({ do: "undo" });
    expect(hotkey(key("y", { ctrlKey: true }))).toEqual({ do: "redo" });
    expect(hotkey(key("Z", { ctrlKey: true, shiftKey: true }))).toEqual({ do: "redo" });
    expect(hotkey(key("s", { ctrlKey: true }))).toEqual({ do: "save" });
    expect(hotkey(key("Delete"))).toEqual({ do: "clear" });
    expect(hotkey(key("?", { shiftKey: true }))).toEqual({ do: "help" });
    expect(hotkey(key("Escape"))).toEqual({ do: "tool", tool: "pen" });
  });

  it("leaves the call's own keys alone: with Alt, or Ctrl and a letter it has no use for", () => {
    expect(hotkey(key("p", { altKey: true }))).toBeNull();
    expect(hotkey(key("m", { ctrlKey: true }))).toBeNull();
    expect(SIZES.length).toBeGreaterThan(3);
  });
});
