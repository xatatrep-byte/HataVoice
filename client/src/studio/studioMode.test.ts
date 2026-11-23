import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn(async () => null) }));

import { studio, useStudio } from "./engine";
import { DEFAULT_LOOK, type StudioSource } from "./layout";

const logo: StudioSource = { id: "s1", kind: "text", name: "Текст", rect: { x: 0, y: 0, width: 400, height: 100 }, visible: true, look: DEFAULT_LOOK };
const back: StudioSource = { id: "s2", kind: "color", name: "Цвет", rect: { x: 0, y: 0, width: 1920, height: 1080 }, visible: true, look: DEFAULT_LOOK };

beforeEach(() => {
  useStudio.setState({
    scenes: [
      { id: "a", name: "Начало", sources: [logo] },
      { id: "b", name: "Игра", sources: [back] },
    ],
    activeScene: "a",
    editScene: "a",
    studioMode: false,
    sources: [logo],
  });
});

describe("studio mode", () => {
  it("without it, a scene picked goes straight on the air", () => {
    studio.switchScene("b");
    expect(useStudio.getState()).toMatchObject({ activeScene: "b", editScene: "b", sources: [back] });
  });

  it("with it, a scene picked goes on the preview and on the air only at «Перевести»", () => {
    studio.setStudioMode(true);
    studio.switchScene("b");
    expect(useStudio.getState()).toMatchObject({ activeScene: "a", editScene: "b", sources: [back] });
    studio.goLive();
    expect(useStudio.getState()).toMatchObject({ activeScene: "b", editScene: "b" });
  });

  it("edits the scene on the preview, not the one on the air", () => {
    studio.setStudioMode(true);
    studio.switchScene("b");
    studio.update("s2", { visible: false });
    const { scenes } = useStudio.getState();
    expect(scenes.find((s) => s.id === "b")!.sources[0]!.visible).toBe(false);
    expect(scenes.find((s) => s.id === "a")!.sources).toEqual([logo]);
  });

  it("turned off, the preview is the air again", () => {
    studio.setStudioMode(true);
    studio.switchScene("b");
    studio.setStudioMode(false);
    expect(useStudio.getState()).toMatchObject({ studioMode: false, activeScene: "a", editScene: "a", sources: [logo] });
  });

  it("removing the scene on the air puts another one on, and the preview keeps its own", () => {
    useStudio.setState({ scenes: [...useStudio.getState().scenes, { id: "c", name: "Конец", sources: [] }] });
    studio.setStudioMode(true);
    studio.switchScene("c");
    studio.removeScene("a");
    expect(useStudio.getState()).toMatchObject({ activeScene: "b", editScene: "c", sources: [] });
  });
});
