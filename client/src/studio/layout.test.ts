import { describe, expect, it } from "vitest";
import { avcCodec, DEFAULT_LOOK, DEFAULT_OUTPUT, dragTo, fit, grabAt, parseOutput, placeNew, reorder, suggestedKbps, toFrame, videoBitrate, withSource, type StudioSource } from "./layout";

const frame = { width: 1920, height: 1080 };
const source = (id: string, rect: StudioSource["rect"], visible = true): StudioSource => ({ id, kind: "image", name: id, rect, visible, look: DEFAULT_LOOK });

describe("studio layout", () => {
  it("puts a screen over the whole frame and a camera in the corner", () => {
    expect(placeNew("screen", frame)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(placeNew("screen", frame, 4 / 3)).toEqual({ x: 240, y: 0, width: 1440, height: 1080 });
    const camera = placeNew("camera", frame);
    expect(camera.x + camera.width).toBeLessThan(1920);
    expect(camera.y + camera.height).toBeLessThan(1080);
    expect(camera.width).toBe(480);
  });

  it("takes the topmost visible source, by its corner to stretch it", () => {
    const sources = [source("back", { x: 0, y: 0, width: 1920, height: 1080 }), source("logo", { x: 100, y: 100, width: 200, height: 100 }), source("hidden", { x: 0, y: 0, width: 1920, height: 1080 }, false)];
    expect(grabAt(sources, { x: 150, y: 150 })).toMatchObject({ id: "logo", mode: "move" });
    expect(grabAt(sources, { x: 295, y: 195 })).toMatchObject({ id: "logo", mode: "resize" });
    expect(grabAt(sources, { x: 1000, y: 900 })).toMatchObject({ id: "back", mode: "move" });
    expect(grabAt([sources[2]!], { x: 10, y: 10 })).toBeNull();
  });

  it("moves, and stretches keeping the shape", () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    expect(dragTo({ id: "a", mode: "move", start: { x: 150, y: 150 }, rect }, { x: 250, y: 120 })).toEqual({ x: 200, y: 70, width: 200, height: 100 });
    expect(dragTo({ id: "a", mode: "resize", start: { x: 300, y: 200 }, rect }, { x: 500, y: 210 })).toEqual({ x: 100, y: 100, width: 400, height: 200 });
    expect(dragTo({ id: "a", mode: "resize", start: { x: 300, y: 200 }, rect }, { x: -500, y: -500 }).width).toBe(32);
  });

  it("maps the preview to the frame, fits and reorders", () => {
    expect(toFrame({ x: 480, y: 270 }, { width: 960, height: 540 }, frame)).toEqual({ x: 960, y: 540 });
    expect(fit(1, { x: 0, y: 0, width: 200, height: 100 })).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    const sources = [source("a", frame as never), source("b", frame as never), source("c", frame as never)];
    expect(reorder(sources, "a", true).map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(reorder(sources, "c", true).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(reorder(sources, "b", false).map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("puts a new screen at the back and anything else on top", () => {
    const text = source("text", frame as never);
    const screen = { ...source("screen", frame as never), kind: "screen" as const };
    const logo = source("logo", frame as never);
    expect(withSource(withSource([text], screen), logo).map((s) => s.id)).toEqual(["screen", "text", "logo"]);
  });

  it("suggests a bitrate by the frame, and takes the one chosen", () => {
    expect(suggestedKbps(1920, 1080, 60)).toBe(9300);
    expect(suggestedKbps(1280, 720, 30, "light")).toBe(1500);
    expect(suggestedKbps(3840, 2160, 60, "best")).toBe(59700);
    expect(videoBitrate({ ...DEFAULT_OUTPUT, kbps: 6000 })).toBe(6_000_000);
  });

  it("chooses the H.264 profile as asked and the level by the frame", () => {
    const at = (width: number, height: number, fps: number, profile = DEFAULT_OUTPUT.profile) => avcCodec({ ...DEFAULT_OUTPUT, width, height, fps, profile });
    expect(at(1280, 720, 60)).toBe("avc1.640028");
    expect(at(1920, 1080, 30)).toBe("avc1.640028");
    expect(at(1920, 1080, 60)).toBe("avc1.64002a");
    expect(at(1080, 1920, 60)).toBe("avc1.64002a");
    expect(at(2560, 1440, 60)).toBe("avc1.640033");
    expect(at(3840, 2160, 60)).toBe("avc1.640034");
    expect(at(1920, 1080, 60, "main")).toBe("avc1.4d002a");
    expect(at(1280, 720, 30, "baseline")).toBe("avc1.42e028");
  });

  it("reads saved settings carefully: sizes stay even, and nothing odd gets through", () => {
    expect(parseOutput(null)).toEqual(DEFAULT_OUTPUT);
    expect(parseOutput({ width: 1081, height: 1921, fps: 500, kbps: 5, rate: "turbo", profile: "ultra" })).toMatchObject({ width: 1080, height: 1920, fps: 60, kbps: 500, rate: "cbr", profile: "high" });
  });

  it("puts a clock in a corner and a color behind everything", () => {
    expect(placeNew("color", frame)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    const color = { ...source("color", frame as never), kind: "color" as const };
    expect(withSource([source("a", frame as never)], color).map((s) => s.id)).toEqual(["color", "a"]);
    expect(placeNew("clock", frame).x).toBeGreaterThan(960);
  });
});
