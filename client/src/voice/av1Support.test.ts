import { afterEach, describe, expect, it, vi } from "vitest";
import { av1Support, av1Warning, screenToSend } from "./av1Support";
import { DEFAULT_SCREEN } from "./screen";

const av1 = { ...DEFAULT_SCREEN, codec: "av1" as const };

function browser({ codecs, info }: { codecs: string[]; info?: { supported: boolean; smooth: boolean; powerEfficient: boolean } | "throws" }) {
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: codecs.map((mimeType) => ({ mimeType })) }) });
  vi.stubGlobal("navigator", {
    mediaCapabilities: {
      encodingInfo: vi.fn(async () => {
        if (info === "throws") throw new Error("no");
        return info;
      }),
    },
  });
}

const card = { supported: true, smooth: true, powerEfficient: true };
const processor = { supported: true, smooth: false, powerEfficient: false };

afterEach(() => vi.unstubAllGlobals());

describe("can this PC send its screen in AV1", () => {
  it("not at all when WebRTC has no AV1 encoder", async () => {
    browser({ codecs: ["video/VP8", "video/VP9", "video/H264"] });
    expect(await av1Support({ resolution: "1080", fps: "60" } as const)).toEqual({ encode: false, hardware: false, smooth: false });
  });

  it("by the video card when the encoder is power efficient, otherwise by the processor", async () => {
    browser({ codecs: ["video/AV1"], info: card });
    expect(await av1Support({ resolution: "1080", fps: "60" } as const)).toEqual({ encode: true, hardware: true, smooth: true });
    browser({ codecs: ["video/AV1"], info: processor });
    expect(await av1Support({ resolution: "2160", fps: "60" } as const)).toEqual({ encode: true, hardware: false, smooth: false });
    browser({ codecs: ["video/AV1"], info: "throws" });
    expect(await av1Support({ resolution: "1080", fps: "60" } as const), "unknown: the processor, as the careful guess").toEqual({ encode: true, hardware: false, smooth: true });
  });
});

describe("what the person is told", () => {
  it("nothing when the video card encodes AV1", () => {
    expect(av1Warning({ encode: true, hardware: true, smooth: true })).toBeNull();
  });

  it("that the screen goes in VP9 when AV1 cannot be sent", () => {
    expect(av1Warning({ encode: false, hardware: false, smooth: false })).toBe("Этот ПК не кодирует AV1, демонстрация пойдёт в VP9");
  });

  it("that the processor will encode, and what to pick if it stutters", () => {
    expect(av1Warning({ encode: true, hardware: false, smooth: true })).toBe(
      "AV1 будет кодировать процессор, а не видеокарта, и картинка может подтормаживать. Если так, выбери «Авто» или H.264",
    );
  });
});

describe("the screen as it goes out", () => {
  it("«Авто»: AV1 where the video card encodes it, H.264 anywhere else, and no warning either way", async () => {
    browser({ codecs: ["video/AV1", "video/H264"], info: card });
    expect(await screenToSend(DEFAULT_SCREEN)).toEqual({ encoder: { codec: "av1", hardware: true }, warning: null });
    browser({ codecs: ["video/AV1", "video/H264"], info: processor });
    expect(await screenToSend(DEFAULT_SCREEN)).toEqual({ encoder: { codec: "h264", hardware: false }, warning: null });
    browser({ codecs: ["video/H264"] });
    expect(await screenToSend(DEFAULT_SCREEN)).toEqual({ encoder: { codec: "h264", hardware: false }, warning: null });
  });

  it("AV1 chosen: on the video card, or on the processor with a warning, or VP9 with a warning when there is none", async () => {
    browser({ codecs: ["video/AV1"], info: card });
    expect(await screenToSend(av1)).toEqual({ encoder: { codec: "av1", hardware: true }, warning: null });
    browser({ codecs: ["video/AV1"], info: processor });
    const slow = await screenToSend(av1);
    expect(slow.encoder).toEqual({ codec: "av1", hardware: false });
    expect(slow.warning).toContain("процессор");
    browser({ codecs: ["video/VP9"] });
    expect(await screenToSend(av1)).toEqual({ encoder: { codec: "vp9", hardware: false }, warning: "Этот ПК не кодирует AV1, демонстрация пойдёт в VP9" });
  });

  it("H.264 and VP9 chosen go as they are", async () => {
    browser({ codecs: ["video/AV1"], info: card });
    expect(await screenToSend({ ...DEFAULT_SCREEN, codec: "h264" })).toEqual({ encoder: { codec: "h264", hardware: false }, warning: null });
    expect(await screenToSend({ ...DEFAULT_SCREEN, codec: "vp9svc" })).toEqual({ encoder: { codec: "vp9", hardware: false }, warning: null });
  });
});
