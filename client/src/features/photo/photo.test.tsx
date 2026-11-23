// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PhotoWorkspace, outputOf } from "./PhotoEditor";

/** A drawing context that draws nothing (jsdom has none): the editor's logic is what is checked here. */
function fakeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {
    canvas,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4).fill(200), width: w, height: h }),
    measureText: (text: string) => ({ width: text.length * 10 }),
  };
  return new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : () => {}),
    set: (t, key, value) => ((t[key] = value), true),
  }) as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return fakeContext(this);
  } as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toBlob = function toBlob(done: BlobCallback) {
    done(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]));
  };
  HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,";
  (globalThis as { ImageData?: unknown }).ImageData ??= class {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  };
});
afterEach(cleanup);

const picture = () => Object.assign(document.createElement("canvas"), { width: 800, height: 600 });

function open() {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(<PhotoWorkspace picture={picture()} name="кот.jpg" onDone={onDone} onClose={onClose} />);
  const stage = document.querySelector(".photo-stage") as HTMLElement;
  return { onDone, onClose, stage };
}

const key = (code: string, extra: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(window, { code, key: code.replace(/^Key/, "").toLowerCase(), ...extra });
const drag = (stage: HTMLElement, from: [number, number], to: [number, number]) => {
  fireEvent.pointerDown(stage, { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(stage, { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2, pointerId: 1 });
  fireEvent.pointerMove(stage, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(stage, { clientX: to[0], clientY: to[1], pointerId: 1 });
};
const layers = () => within(screen.getByRole("list", { name: "Слои" })).getAllByRole("listitem").map((li) => li.textContent);

describe("the photo editor", () => {
  it("has the tools of a photo editor, each on its key", () => {
    open();
    for (const name of ["Перемещение", "Рамка и поворот", "Кисть", "Ластик", "Фигуры", "Текст", "Скрыть", "Пипетка", "Наклейки", "Рука"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    key("KeyU");
    expect(screen.getByRole("button", { name: "Фигуры" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Стрелка" })).toBeTruthy();
    key("KeyC");
    expect(screen.getByRole("button", { name: "16:9" })).toBeTruthy();
  });

  it("draws a shape as a layer of its own, which goes with Delete and comes back with Ctrl+Z", () => {
    const { stage } = open();
    key("KeyU");
    drag(stage, [200, 200], [400, 320]);
    fireEvent.click(screen.getByRole("tab", { name: "Слои" }));
    expect(layers()).toEqual(["Прямоугольник", "Фото"]);
    key("Delete", { key: "Delete" });
    expect(layers()).toEqual(["Фото"]);
    key("KeyZ", { ctrlKey: true });
    expect(layers()).toEqual(["Прямоугольник", "Фото"]);
  });

  it("brush strokes, a hidden part and a sticker are layers too, in the order they were made", () => {
    const { stage } = open();
    key("KeyB");
    drag(stage, [100, 100], [300, 200]);
    key("KeyJ");
    drag(stage, [300, 300], [380, 360]);
    fireEvent.click(screen.getByRole("tab", { name: "Наклейки" }));
    fireEvent.click(screen.getByRole("listitem", { name: "Наклейка 🔥" }));
    fireEvent.click(screen.getByRole("tab", { name: "Слои" }));
    expect(layers()).toEqual(["Наклейка 🔥", "Скрыто квадратами", "Кисть", "Фото"]);
  });

  it("a text opens to type in when the click is over, and an empty one is not kept", async () => {
    const { stage } = open();
    key("KeyT");
    fireEvent.pointerDown(stage, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    expect(screen.queryByRole("textbox", { name: "Текст на фото" }), "not on the press").toBeNull();
    fireEvent.pointerUp(stage, { clientX: 300, clientY: 300, pointerId: 1 });
    const box = screen.getByRole("textbox", { name: "Текст на фото" });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Привет" } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole("tab", { name: "Слои" }));
    expect(layers()).toEqual(["Текст «Привет»", "Фото"]);
    fireEvent.pointerDown(stage, { button: 0, clientX: 600, clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(stage, { clientX: 600, clientY: 500, pointerId: 1 });
    fireEvent.blur(screen.getByRole("textbox", { name: "Текст на фото" }));
    expect(layers()).toEqual(["Текст «Привет»", "Фото"]);
  });

  it("the colour is typed or picked from the palette, and is kept among the recent ones once used", () => {
    const { stage } = open();
    const code = screen.getByRole("textbox", { name: "Код цвета" }) as HTMLInputElement;
    fireEvent.change(code, { target: { value: "#12ab34" } });
    key("KeyB");
    drag(stage, [100, 100], [200, 200]);
    expect(within(screen.getByRole("list", { name: "Недавние цвета" })).getByRole("listitem", { name: "#12ab34" })).toBeTruthy();
  });

  it("corrections and filters change the photo and can be put back", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "Коррекция" }));
    const exposure = screen.getByRole("slider", { name: "Экспозиция" }) as HTMLInputElement;
    fireEvent.change(exposure, { target: { value: "40" } });
    fireEvent.pointerUp(exposure);
    expect(exposure.value).toBe("40");
    key("KeyZ", { ctrlKey: true });
    expect((screen.getByRole("slider", { name: "Экспозиция" }) as HTMLInputElement).value).toBe("0");
    fireEvent.click(screen.getByRole("tab", { name: "Фильтры" }));
    fireEvent.click(screen.getByRole("listitem", { name: /Винтаж/ }));
    expect(screen.getByRole("slider", { name: "Сила фильтра" })).toBeTruthy();
  });

  it("«Готово» gives the photo drawn whole, a JPEG for a JPEG and a PNG for what may be see-through", async () => {
    const { onDone } = open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    });
    expect(onDone).toHaveBeenCalledWith(expect.any(Uint8Array), "кот.jpg");
    expect(outputOf("скрин.png")).toEqual({ type: "image/png", name: "скрин.png" });
    expect(outputOf("фото.JPEG").type).toBe("image/jpeg");
  });
});
