// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScreenPicker, sourceLine, type PickerSource } from "./ScreenPicker";
import type { ScreenSettings } from "../../voice/screen";

afterEach(cleanup);

const settings: ScreenSettings = { resolution: "1080", fps: "60", codec: "auto", audio: true };
const source = (over: Partial<PickerSource>): PickerSource => ({ kind: "window", id: 1, title: "Окно", app: null, width: 1920, height: 1080, primary: false, thumb: "data:image/png;base64,AA", icon: null, ...over });
const list = [
  source({ id: 11, title: "Minecraft 1.21", app: "javaw" }),
  source({ id: 12, title: "Видео — Браузер", app: "chrome" }),
  source({ kind: "monitor", id: 21, title: "Экран 1", width: 2560, height: 1440, primary: false }),
  source({ kind: "monitor", id: 22, title: "Экран 2", primary: true }),
];

async function open(props: Partial<Parameters<typeof ScreenPicker>[0]> = {}) {
  const onPick = vi.fn();
  const onChange = vi.fn();
  const onClose = vi.fn();
  const load = vi.fn(async () => list);
  render(<ScreenPicker open settings={settings} onChange={onChange} onPick={onPick} onClose={onClose} load={load} {...props} />);
  await act(async () => {});
  return { onPick, onChange, onClose, load };
}

describe("our own screen picker", () => {
  it("shows the windows first, the first one picked, and shows the one chosen", async () => {
    const { onPick } = await open();
    expect(screen.getByRole("tab", { name: /Окна/ }).textContent).toContain("2");
    expect(screen.getByRole("tab", { name: /Экраны/ }).textContent).toContain("2");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Minecraft 1.21", "Видео — Браузер"]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(options[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "window", id: 12, title: "Видео — Браузер" });
  });

  it("on the screens' tab the main screen is picked and the sound is the computer's", async () => {
    const { onPick } = await open();
    expect(screen.getByRole("switch", { name: "Звук этого окна" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Экраны/ }));
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("Экран 2");
    expect(screen.getByRole("switch", { name: "Звук компьютера" })).toBeTruthy();
    fireEvent.doubleClick(screen.getByRole("option", { name: /Экран 1/ }));
    expect(onPick).toHaveBeenCalledWith({ kind: "monitor", id: 21, title: "Экран 1" });
  });

  it("has the quality and the sound below, without a second sound switch", async () => {
    const { onChange } = await open();
    fireEvent.click(screen.getByRole("button", { name: /1080p · 60 к\/с/ }));
    const panel = screen.getByRole("dialog", { name: "Качество демонстрации" });
    fireEvent.click(screen.getByRole("button", { name: "1440p" }));
    expect(onChange).toHaveBeenCalledWith({ resolution: "1440" });
    expect(panel.textContent).not.toContain("Со звуком компьютера");
    fireEvent.click(screen.getByRole("switch", { name: "Звук этого окна" }));
    expect(onChange).toHaveBeenCalledWith({ audio: false });
  });

  it("says when there is nothing to show, and goes to the screens when no window is open", async () => {
    await open({ load: async () => list.filter((s) => s.kind === "monitor") });
    expect(screen.getByRole("tab", { name: /Экраны/ }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    await open({ load: async () => [] });
    expect(screen.getByText(/Открытых окон нет/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Показать" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes on Escape and on «Отмена»", async () => {
    const { onClose } = await open();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("names a screen by its number, size and whether it is the main one", () => {
    expect(sourceLine(list[3]!)).toBe("Экран 2 · 1920 × 1080 · основной");
    expect(sourceLine(list[0]!)).toBe("Minecraft 1.21");
  });
});
