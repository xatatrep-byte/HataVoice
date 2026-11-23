// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { VideoWorkspace } from "./VideoEditor";

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return new Proxy({ canvas: this } as Record<string | symbol, unknown>, {
      get: (t, key) => (key in t ? t[key] : () => ({ width: 10 })),
      set: (t, key, value) => ((t[key] = value), true),
    });
  } as unknown as HTMLCanvasElement["getContext"];
  globalThis.fetch = vi.fn(async () => {
    throw new Error("no network in checks");
  }) as typeof fetch;
});
afterEach(cleanup);

function open() {
  render(<VideoWorkspace src="blob:clip" name="клип.mp4" size={1000} meta={{ duration: 12, width: 1920, height: 1080 }} onDone={vi.fn()} onClose={vi.fn()} />);
}
const key = (code: string, extra: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(window, { code, key: code.replace(/^Key/, "").toLowerCase(), ...extra });
const clips = () => screen.getAllByRole("button", { name: /^Клип \d+$/ });
const time = () => document.querySelector(".video-time")!.textContent;

describe("the video editor", () => {
  it("cuts with S, sets a clip's speed, and the cut video gets shorter", () => {
    open();
    expect(time()).toBe("0:00.0 / 0:12.0");
    key("ArrowRight", { key: "ArrowRight", shiftKey: true });
    for (let i = 0; i < 5; i++) key("ArrowRight", { key: "ArrowRight", shiftKey: true });
    key("KeyS");
    expect(clips()).toHaveLength(2);
    fireEvent.pointerDown(clips()[1]!, { button: 0, clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(clips()[1]!, { clientX: 50, pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "2×" }));
    expect(time()).toBe("0:06.0 / 0:09.0");
    key("KeyZ", { ctrlKey: true });
    expect(time()).toBe("0:06.0 / 0:12.0");
  });

  it("deletes the chosen clip, but never the last one", () => {
    open();
    for (let i = 0; i < 4; i++) key("ArrowRight", { key: "ArrowRight", shiftKey: true });
    key("KeyS");
    fireEvent.pointerDown(clips()[0]!, { button: 0, clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(clips()[0]!, { clientX: 50, pointerId: 1 });
    key("Delete", { key: "Delete" });
    expect(clips()).toHaveLength(1);
    expect(time()).toContain("/ 0:08.0");
    fireEvent.pointerDown(clips()[0]!, { button: 0, clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(clips()[0]!, { clientX: 50, pointerId: 1 });
    key("Delete", { key: "Delete" });
    expect(clips()).toHaveLength(1);
  });

  it("adds a title at the playhead, shown on its own track, with its text and look", () => {
    open();
    key("KeyT");
    const block = screen.getByRole("button", { name: "Текст «Текст»" });
    expect(block).toBeTruthy();
    const text = screen.getByRole("textbox", { name: "Текст титра" });
    fireEvent.change(text, { target: { value: "Подпишись!" } });
    fireEvent.blur(text);
    expect(screen.getByRole("button", { name: "Текст «Подпишись!»" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Цвет #facc15" }));
    expect(screen.getByRole("button", { name: "Цвет #facc15" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("changes the frame's shape and the colour, and has the blade", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "Кадр" }));
    fireEvent.click(screen.getByRole("button", { name: "9:16" }));
    expect(screen.getByText(/Итог: 406 × 720/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Цвет" }));
    fireEvent.click(screen.getByRole("button", { name: "Ч/Б" }));
    expect(screen.getByRole("button", { name: "Ч/Б" }).getAttribute("aria-pressed")).toBe("true");
    key("KeyC");
    expect(within(screen.getByRole("toolbar", { name: "Монтаж" })).getByRole("button", { name: "Лезвие" }).getAttribute("aria-pressed")).toBe("true");
  });
});
