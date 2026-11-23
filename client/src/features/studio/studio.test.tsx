// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, _args?: unknown): Promise<unknown> => (command === "stream_key_has" ? false : null)),
  studio: {
    attachPreview: vi.fn(async () => {}),
    attachEditPreview: vi.fn(),
    goLive: vi.fn(),
    setStudioMode: vi.fn(),
    levels: () => ({ mic: 0.5, screen: 0 }),
    addScreen: vi.fn(),
    addCamera: vi.fn(),
    addCharacter: vi.fn(),
    addText: vi.fn(),
    addImage: vi.fn(),
    addClock: vi.fn(),
    addColor: vi.fn(),
    addScene: vi.fn(),
    duplicateScene: vi.fn(),
    switchScene: vi.fn(),
    removeScene: vi.fn(),
    renameScene: vi.fn(),
    setTransition: vi.fn(),
    setLook: vi.fn(),
    setMixer: vi.fn(),
    setReplay: vi.fn(async () => {}),
    saveReplay: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setSources: vi.fn(),
    fill: vi.fn(),
    setOutput: vi.fn(),
    setMic: vi.fn(),
    setVolume: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    snapshot: vi.fn(),
    setPacketSink: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (command: string, args: unknown) => mocks.invoke(command, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => {}) }));
vi.mock("../../studio/engine", async () => {
  const { create } = await import("zustand");
  const { DEFAULT_OUTPUT } = await import("../../studio/layout");
  const { DEFAULT_MIXER } = await import("../../studio/audio");
  const useStudio = create(() => ({
    scenes: [{ id: "a", name: "Сцена 1", sources: [] as unknown[] }, { id: "b", name: "Игра", sources: [] as unknown[] }],
    activeScene: "a",
    editScene: "a",
    studioMode: false,
    transition: { kind: "fade", ms: 400 },
    sources: [] as unknown[],
    output: DEFAULT_OUTPUT,
    recording: null as unknown,
    recorded: null as string | null,
    stats: { fps: 60, dropped: 0, queue: 0, renderMs: 2, kbps: 0 },
    micDevice: "",
    mixer: DEFAULT_MIXER,
    replaySeconds: 0,
    error: null,
  }));
  return { useStudio, studio: mocks.studio, stamp: () => "2026-10-29 22-00-00" };
});

import { useStudio } from "../../studio/engine";
import { DEFAULT_LOOK } from "../../studio/layout";
import { useStream } from "../../studio/stream";
import { StudioPage } from "./StudioPage";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const text = { id: "s1", kind: "text", name: "Текст", rect: { x: 0, y: 0, width: 960, height: 108 }, visible: true, look: DEFAULT_LOOK, text: { text: "Привет", size: 72, color: "#ffffff", outline: 0, bold: true } };
const screenSource = { id: "s2", kind: "screen", name: "Экран", rect: { x: 0, y: 0, width: 1920, height: 1080 }, visible: true, look: DEFAULT_LOOK };

describe("the studio page", () => {
  const addSource = (name: RegExp) => {
    fireEvent.click(screen.getByRole("button", { name: "Добавить источник" }));
    fireEvent.click(screen.getByRole("menuitem", { name }));
  };
  const openSettings = (tab: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Настройки записи и стрима" }));
    fireEvent.click(screen.getByRole("tab", { name: tab }));
  };

  it("adds sources from the «+» menu and lists them top first", () => {
    act(() => useStudio.setState({ sources: [] }));
    render(<StudioPage onClose={() => {}} />);
    expect(screen.getByText(/В этой сцене пока пусто/)).toBeTruthy();
    addSource(/Экран или окно/);
    addSource(/3D-персонаж/);
    addSource(/Часы/);
    expect(mocks.studio.addScreen).toHaveBeenCalled();
    expect(mocks.studio.addCharacter).toHaveBeenCalled();
    expect(mocks.studio.addClock).toHaveBeenCalled();
    // The menu closes after a pick.
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => useStudio.setState({ sources: [screenSource, text] as never }));
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("Привет");
    expect(items[1]).toContain("Экран");
  });

  it("edits a chosen text in its properties, hides, locks and removes sources", () => {
    act(() => useStudio.setState({ sources: [screenSource, text] as never }));
    render(<StudioPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Привет/ }));
    fireEvent.click(screen.getByRole("button", { name: "Свойства и фильтры" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Текст надписи" }), { target: { value: "Стрим!" } });
    expect(mocks.studio.update).toHaveBeenCalledWith("s1", { text: { text: "Стрим!", size: 72, color: "#ffffff", outline: 0, bold: true } });
    fireEvent.click(screen.getAllByRole("button", { name: "Скрыть" })[0]!);
    expect(mocks.studio.update).toHaveBeenCalledWith("s1", { visible: false });
    fireEvent.click(screen.getAllByRole("button", { name: "Заблокировать на месте" })[1]!);
    expect(mocks.studio.update).toHaveBeenCalledWith("s2", { locked: true });
    fireEvent.click(screen.getByRole("button", { name: /^Экран$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Убрать" }));
    expect(mocks.studio.remove).toHaveBeenCalledWith("s2");
  });

  it("offers a camera's crop, filters and green screen", () => {
    act(() => useStudio.setState({ sources: [{ ...screenSource, kind: "camera", name: "Камера" }] as never }));
    render(<StudioPage onClose={() => {}} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: /^Камера$/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Убрать фон одного цвета" }));
    expect(mocks.studio.setLook).toHaveBeenCalledWith("s2", { chroma: { color: "#00b140", similarity: 0.13, smooth: 0.08 } });
  });

  it("switches scenes by a click or a digit, and makes new ones", () => {
    render(<StudioPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /Игра/ }));
    expect(mocks.studio.switchScene).toHaveBeenCalledWith("b");
    fireEvent.keyDown(window, { key: "1" });
    expect(mocks.studio.switchScene).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Новая сцена" }));
    expect(mocks.studio.addScene).toHaveBeenCalled();
  });

  it("prepares a scene on the preview in studio mode and puts it on the air at «Перевести»", () => {
    render(<StudioPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Студийный режим/ }));
    expect(mocks.studio.setStudioMode).toHaveBeenCalledWith(true);
    act(() => useStudio.setState({ studioMode: true, editScene: "b" }));
    expect(screen.getByRole("tab", { name: /Игра/, selected: true })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Сцена 1/ }).textContent).toContain("в эфире");
    expect(screen.getByText(/Предпросмотр/).textContent).toContain("Игра");
    expect(screen.getByText(/Программа/).textContent).toContain("Сцена 1");
    expect(mocks.studio.attachEditPreview).toHaveBeenLastCalledWith(expect.any(HTMLCanvasElement));
    fireEvent.click(screen.getByRole("button", { name: /Перевести/ }));
    expect(mocks.studio.goLive).toHaveBeenCalled();
    act(() => useStudio.setState({ activeScene: "b" }));
    expect((screen.getByRole("button", { name: /Перевести/ }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useStudio.setState({ studioMode: false, activeScene: "a", editScene: "a" }));
  });

  it("nudges the chosen source with the arrows, leaves a locked one, and removes with Delete", () => {
    act(() => useStudio.setState({ sources: [text] as never }));
    render(<StudioPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Привет/ }));
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(mocks.studio.update).toHaveBeenCalledWith("s1", { rect: { ...text.rect, x: 10 } });
    act(() => useStudio.setState({ sources: [{ ...text, locked: true }] as never }));
    mocks.studio.update.mockClear();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(mocks.studio.update).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Delete" });
    expect(mocks.studio.remove).toHaveBeenCalledWith("s1");
  });

  it("records, and shows the time and the size while it does", () => {
    act(() => useStudio.setState({ sources: [], recording: null }));
    const { rerender } = render(<StudioPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Начать запись/ }));
    expect(mocks.studio.startRecording).toHaveBeenCalled();
    act(() => useStudio.setState({ recording: { startedAt: Date.now() - 65_000, bytes: 52 << 20, path: "C:\\x.mp4" } }));
    rerender(<StudioPage onClose={() => {}} />);
    expect(screen.getByRole("status").textContent).toMatch(/0:01:0[56] · 52 МБ/);
    fireEvent.click(screen.getByRole("button", { name: /Остановить запись/ }));
    expect(mocks.studio.stopRecording).toHaveBeenCalled();
  });

  it("says where the files go, and changes the folder only through Windows' dialog", async () => {
    let folder = { path: "C:\\Users\\u\\Videos\\ХатаВойс", chosen: false };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "studio_folder") return folder;
      if (command === "studio_pick_folder") {
        folder = { path: "D:\\Записи", chosen: true };
        return folder;
      }
      if (command === "studio_folder_reset") {
        folder = { path: "C:\\Users\\u\\Videos\\ХатаВойс", chosen: false };
        return folder;
      }
      return null;
    });
    act(() => useStudio.setState({ recording: null, recorded: "D:\\Записи\\2026-11-08 15-00-00.mp4" }));
    render(<StudioPage onClose={() => {}} />);
    openSettings("Запись");
    expect(await screen.findByText("C:\\Users\\u\\Videos\\ХатаВойс")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "По умолчанию" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Изменить/ }));
    expect(await screen.findByText("D:\\Записи")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("studio_pick_folder", undefined);
    fireEvent.click(screen.getByRole("button", { name: /Открыть папку/ }));
    expect(mocks.invoke).toHaveBeenCalledWith("studio_open_folder", undefined);
    // The last file, by its name, and where it is.
    expect(screen.getByText("2026-11-08 15-00-00.mp4")).toBeTruthy();
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    fireEvent.click(screen.getByRole("button", { name: /Показать в папке/ }));
    expect(revealItemInDir).toHaveBeenCalledWith("D:\\Записи\\2026-11-08 15-00-00.mp4");
    fireEvent.click(screen.getByRole("button", { name: "По умолчанию" }));
    expect(await screen.findByText("C:\\Users\\u\\Videos\\ХатаВойс")).toBeTruthy();
    mocks.invoke.mockImplementation(async (command: string) => (command === "stream_key_has" ? false : null));
    act(() => useStudio.setState({ recorded: null }));
  });

  it("saves the last seconds when a replay is kept", () => {
    act(() => useStudio.setState({ recording: null, replaySeconds: 0 }));
    const { rerender } = render(<StudioPage onClose={() => {}} />);
    expect((screen.getByRole("button", { name: /Сохранить повтор/ }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useStudio.setState({ replaySeconds: 60 }));
    rerender(<StudioPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Сохранить повтор \(60 с\)/ }));
    expect(mocks.studio.saveReplay).toHaveBeenCalled();
  });

  it("opens the stream settings when there is nowhere to stream to", async () => {
    act(() => {
      useStudio.setState({ recording: null, replaySeconds: 0 });
      useStream.setState({ destinations: useStream.getState().destinations.map((d) => ({ ...d, on: false })), saved: {}, states: {}, error: null });
    });
    render(<StudioPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Начать стрим/ }));
    expect(await screen.findByRole("dialog", { name: "Настройки записи и стрима" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Стрим", selected: true })).toBeTruthy();
    expect(screen.getAllByText(/ключ/).length).toBeGreaterThan(0);
    act(() => useStream.setState({ error: null }));
  });

  it("says when the stream sends more than a chosen place takes, and fixes it with a press", () => {
    act(() => {
      useStudio.setState({ recording: null });
      useStream.setState({ destinations: useStream.getState().destinations.map((d) => ({ ...d, on: d.service === "twitch" || d.service === "youtube" })), states: {}, error: null });
    });
    render(<StudioPage onClose={() => {}} />);
    openSettings("Стрим");
    expect(screen.getByRole("alert").textContent).toMatch(/Twitch принимает до 6000 кбит\/с, а сейчас 9300/);
    fireEvent.click(screen.getByRole("button", { name: "Поставить 6000" }));
    expect(mocks.studio.setOutput).toHaveBeenCalledWith(expect.objectContaining({ kbps: 6000 }));
  });

  it("keeps a stream key only in Rust, and streams to all the places that are on", async () => {
    act(() => {
      useStudio.setState({ recording: null, replaySeconds: 0 });
      useStream.setState({ destinations: useStream.getState().destinations.map((d) => ({ ...d, on: d.service === "twitch" || d.service === "custom" })), saved: {}, states: {}, error: null });
    });
    render(<StudioPage onClose={() => {}} />);
    openSettings("Стрим");
    const [twitchKey] = screen.getAllByLabelText("Ключ трансляции");
    fireEvent.change(twitchKey!, { target: { value: "live_123_abc" } });
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => (command === "stream_key_has" ? (args as { service: string }).service === "twitch" || (args as { service: string }).service === "custom" : null));
    fireEvent.click(screen.getAllByRole("button", { name: "Сохранить" })[0]!);
    await waitFor(() => expect(screen.getAllByText(/Ключ сохранён/).length).toBe(2));
    expect(mocks.invoke).toHaveBeenCalledWith("stream_key_set", { service: "twitch", key: "live_123_abc" });
    expect(screen.queryByLabelText("Ключ трансляции")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("rtmp://…"), { target: { value: "rtmp://own/app" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Начать стрим/ })[0]!);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("stream_start", expect.objectContaining({
        destinations: [
          { service: "twitch", url: "rtmps://live.twitch.tv:443/app" },
          { service: "custom", url: "rtmp://own/app" },
        ],
        audioKbps: 160,
      })),
    );
  });
});
