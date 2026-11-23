import { describe, expect, it } from "vitest";
import {
  clipAt,
  fadeAt,
  frameLayout,
  moveClip,
  newVideoDoc,
  outputSize,
  removeClip,
  setSpeed,
  splitAt,
  timelineLength,
  titlesAt,
  trimClip,
  videoFilter,
  type VideoDoc,
} from "./timeline";

const doc = (): VideoDoc => newVideoDoc(60, 1920, 1080);

describe("the video's timeline", () => {
  it("starts as one clip, the whole video", () => {
    const d = doc();
    expect(d.clips).toHaveLength(1);
    expect(timelineLength(d)).toBe(60);
    expect(clipAt(d, 12.5)).toMatchObject({ index: 0, source: 12.5, from: 0 });
  });

  it("cuts a clip in two where the playhead is, and a cut piece can go", () => {
    let d = splitAt(doc(), 20);
    expect(d.clips.map((c) => [c.start, c.end])).toEqual([
      [0, 20],
      [20, 60],
    ]);
    d = splitAt(d, 45);
    expect(d.clips.map((c) => [c.start, c.end])).toEqual([
      [0, 20],
      [20, 45],
      [45, 60],
    ]);
    expect(splitAt(d, 20.01), "too close to a cut").toBe(d);
    d = removeClip(d, d.clips[1]!.id);
    expect(timelineLength(d)).toBe(35);
    expect(clipAt(d, 25)).toMatchObject({ index: 1, source: 50, from: 20 });
  });

  it("clips change places, and are trimmed within their video", () => {
    let d = splitAt(doc(), 20);
    const [first, second] = d.clips;
    d = moveClip(d, second!.id, 0);
    expect(d.clips.map((c) => c.id)).toEqual([second!.id, first!.id]);
    d = trimClip(d, first!.id, "start", 5);
    d = trimClip(d, first!.id, "end", 100);
    expect(d.clips[1], "as far as the video goes").toMatchObject({ start: 5, end: 60 });
    d = trimClip(d, first!.id, "start", 19.99);
    expect(d.clips[1]!.end - d.clips[1]!.start).toBeGreaterThanOrEqual(0.1);
  });

  it("a faster clip takes less of the timeline", () => {
    let d = splitAt(doc(), 20);
    d = setSpeed(d, d.clips[0]!.id, 2);
    expect(timelineLength(d)).toBe(50);
    expect(clipAt(d, 5)).toMatchObject({ index: 0, source: 10 });
    expect(clipAt(d, 12)).toMatchObject({ index: 1, source: 22, from: 10 });
    expect(setSpeed(d, d.clips[0]!.id, 99).clips[0]!.speed).toBe(4);
  });

  it("titles show between their times", () => {
    const d: VideoDoc = { ...doc(), titles: [{ id: "t", text: "Привет", at: 2, until: 5, x: 0.5, y: 0.8, size: 0.08, color: "#ffffff", font: "Manrope", bold: true, background: false, outline: true }] };
    expect(titlesAt(d, 1).length).toBe(0);
    expect(titlesAt(d, 3).map((t) => t.text)).toEqual(["Привет"]);
  });

  it("the frame is as asked: its shape, turned, at most the size asked, in even pixels", () => {
    expect(outputSize(doc(), 720)).toEqual({ width: 1280, height: 720 });
    expect(outputSize({ ...doc(), aspect: "9:16" }, 1080)).toEqual({ width: 608, height: 1080 });
    expect(outputSize({ ...doc(), turn: 1 }, 1080)).toEqual({ width: 608, height: 1080 });
    expect(outputSize(newVideoDoc(5, 640, 360), 1080), "never bigger than the video").toEqual({ width: 640, height: 360 });
    // Filling a square from a wide video: it is scaled to the height and cut at the sides.
    const fill = frameLayout({ ...doc(), aspect: "1:1" }, 1080, 1080);
    expect(fill.scale).toBeCloseTo(1);
    const fit = frameLayout({ ...doc(), aspect: "1:1", fit: "fit" }, 1080, 1080);
    expect(fit.scale).toBeCloseTo(1080 / 1920);
  });

  it("fades from and to black at the ends, and the colour as a filter", () => {
    const d = { ...doc(), fadeIn: 2, fadeOut: 1 };
    expect(fadeAt(d, 0)).toBe(0);
    expect(fadeAt(d, 1)).toBeCloseTo(0.5);
    expect(fadeAt(d, 30)).toBe(1);
    expect(fadeAt(d, 59.5)).toBeCloseTo(0.5);
    expect(videoFilter({ brightness: 0, contrast: 0, saturation: 0, hue: 0 }, "none")).toBe("none");
    expect(videoFilter({ brightness: 20, contrast: 0, saturation: -100, hue: 0 }, "none")).toBe("brightness(1.2) saturate(0)");
    expect(videoFilter({ brightness: 0, contrast: 0, saturation: 0, hue: 0 }, "bw")).toContain("grayscale(1)");
  });
});
