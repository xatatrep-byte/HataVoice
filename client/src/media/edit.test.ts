import { describe, expect, it } from "vitest";
import { kindOf } from "./edit";
import { recorderType } from "./video/render";

describe("what the editors open", () => {
  it("knows by the name what can be changed here", () => {
    expect(kindOf("Фото.JPG")).toBe("photo");
    expect(kindOf("клип.mp4")).toBe("video");
    expect(kindOf("отчёт.pdf")).toBeNull();
  });

  it("a video is written as MP4 where the engine can, else WebM", () => {
    expect(recorderType((t) => t.startsWith("video/mp4"))).toEqual({ type: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" });
    expect(recorderType((t) => t.startsWith("video/webm"))).toEqual({ type: "video/webm;codecs=vp9,opus", ext: "webm" });
    expect(recorderType(() => false)).toBeNull();
  });
});
