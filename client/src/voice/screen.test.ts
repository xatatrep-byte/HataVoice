import { describe, expect, it } from "vitest";
import { VideoPreset } from "livekit-client";
import {
  DEFAULT_SCREEN,
  drivenQuality,
  onWifi,
  phoneScreenPublishOptions,
  PHONE_SCREEN_HINT,
  PHONE_SCREEN_MAX_BITRATE,
  screenCaptureOptions,
  screenPreset,
  screenPublishOptions,
  screenQualityLabel,
  SCREEN_FPS,
  SCREEN_RESOLUTIONS,
  SCREEN_SMOOTH_MS,
} from "./screen";

const av1Card = { codec: "av1", hardware: true } as const;
const h264 = { codec: "h264", hardware: false } as const;

describe("the screen while someone drives this PC", () => {
  const games = DEFAULT_SCREEN;

  it("is the screen's own pixels at 60 fps when the video card encodes", () => {
    expect(drivenQuality(games, { width: 1920, height: 1080 }, true)).toEqual({ width: 1920, height: 1080, fps: 60, bitrate: 24_883_200 });
    expect(drivenQuality(games, { width: 2560, height: 1440 }, true)).toEqual({ width: 2560, height: 1440, fps: 60, bitrate: 44_236_800 });
    expect(drivenQuality({ ...games, resolution: "1440", fps: "30" }, { width: 1920, height: 1200 }, true).fps, "text gets the frames too").toBe(60);
  });

  it("stops at 1440p, with 4K only when 4K is chosen, and keeps the shape of the screen", () => {
    expect(drivenQuality(games, { width: 3840, height: 2160 }, true)).toMatchObject({ width: 2560, height: 1440 });
    expect(drivenQuality(games, { width: 3440, height: 1440 }, true)).toMatchObject({ width: 2560, height: 1072 });
    expect(drivenQuality({ ...games, resolution: "2160" }, { width: 3840, height: 2160 }, true)).toEqual({ width: 3840, height: 2160, fps: 60, bitrate: 50_000_000 });
  });

  it("keeps the size on the processor and only adds bitrate", () => {
    expect(drivenQuality(games, { width: 2560, height: 1440 }, false)).toEqual({ width: 1920, height: 1080, fps: 60, bitrate: 18_000_000 });
  });

  it("uses the preset's size when the capture does not tell the screen's", () => {
    expect(drivenQuality(games, null, true)).toMatchObject({ width: 1920, height: 1080, fps: 60 });
  });
});

describe("screen sharing presets", () => {
  it("by default it is smooth: 1080p at 60, 12 Mbit/s, keeps the frame rate", () => {
    const capture = screenCaptureOptions(DEFAULT_SCREEN);
    expect(DEFAULT_SCREEN.codec).toBe("auto");
    expect(capture.resolution).toEqual({ width: 1920, height: 1080, frameRate: 60 });
    expect(capture.contentHint).toBe("motion");
    expect(capture.systemAudio).toBe("include");
    expect(capture.selfBrowserSurface).toBe("exclude");
    const publish = screenPublishOptions(DEFAULT_SCREEN, av1Card);
    // The encoder's cap above the capture's 60: it would drop frames that come a little early.
    expect(publish.screenShareEncoding).toEqual({ maxBitrate: 12_000_000, maxFramerate: 90, priority: "high" });
    expect(publish.degradationPreference).toBe("maintain-framerate");
    expect(publish.backupCodec).toBe(false);
  });

  it("30 fps and fewer is text and slides: sharp, keeps the resolution, with fewer bits", () => {
    const settings = { ...DEFAULT_SCREEN, resolution: "1440", fps: "30" } as const;
    expect(screenCaptureOptions(settings)).toMatchObject({ resolution: { width: 2560, height: 1440, frameRate: 30 }, contentHint: "detail" });
    expect(screenPublishOptions(settings, av1Card)).toMatchObject({
      screenShareEncoding: { maxBitrate: 10_800_000, maxFramerate: 45 },
      degradationPreference: "maintain-resolution",
    });
    expect(screenPreset({ resolution: "720", fps: "15" })).toEqual({ width: 1280, height: 720, fps: 15, bitrate: 2_400_000, hint: "detail" });
  });

  it("the size and the rate are picked apart: any of 720p–4K with any of 15, 30, 60", () => {
    for (const resolution of SCREEN_RESOLUTIONS) {
      for (const fps of SCREEN_FPS) {
        const preset = screenPreset({ resolution, fps });
        expect(preset.height).toBe(Number(resolution));
        expect(preset.fps).toBe(Number(fps));
      }
    }
    expect(screenQualityLabel({ resolution: "2160", fps: "30" })).toBe("4K · 30");
  });

  it("4K at 60 goes up to 25 Mbit/s", () => {
    const settings = { ...DEFAULT_SCREEN, resolution: "2160" } as const;
    expect(screenCaptureOptions(settings).resolution).toEqual({ width: 3840, height: 2160, frameRate: 60 });
    expect(screenPublishOptions(settings, av1Card).screenShareEncoding?.maxBitrate).toBe(25_000_000);
  });

  it("the computer's sound goes untouched, in stereo", () => {
    expect(screenCaptureOptions(DEFAULT_SCREEN).audio).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(screenPublishOptions(DEFAULT_SCREEN, h264)).toMatchObject({ audioPreset: { maxBitrate: 128_000 }, forceStereo: true, dtx: false });
    expect(screenCaptureOptions({ ...DEFAULT_SCREEN, audio: false })).toMatchObject({ audio: false, systemAudio: "exclude" });
  });
});

describe("bitrate by codec", () => {
  it("gives H.264 and VP9 more bits than AV1 for the same picture", () => {
    expect(screenPublishOptions(DEFAULT_SCREEN, av1Card).screenShareEncoding?.maxBitrate).toBe(12_000_000);
    expect(screenPublishOptions(DEFAULT_SCREEN, h264).screenShareEncoding?.maxBitrate).toBe(16_200_000);
    expect(screenPublishOptions(DEFAULT_SCREEN, { codec: "vp9", hardware: false }).screenShareEncoding?.maxBitrate).toBe(13_800_000);
  });
});

describe("how the screen is encoded", () => {
  it("AV1 on the video card: two whole streams of one layer each — the card takes no AV1 layers — full and a quarter", () => {
    const publish = screenPublishOptions(DEFAULT_SCREEN, av1Card);
    expect(publish).toMatchObject({ videoCodec: "av1", simulcast: true, scalabilityMode: "L1T1" });
    expect(publish.screenShareSimulcastLayers).toEqual([new VideoPreset(960, 540, 3_000_000, 30, "high")]);
  });

  it("AV1 on the processor: one stream with time layers, no second encoder to feed", () => {
    expect(screenPublishOptions(DEFAULT_SCREEN, { codec: "av1", hardware: false })).toMatchObject({ videoCodec: "av1", simulcast: false, scalabilityMode: "L1T3" });
  });

  it("H.264 in one stream: every extra layer would be one more encoder on the processor", () => {
    expect(screenPublishOptions(DEFAULT_SCREEN, h264)).toMatchObject({ videoCodec: "h264", simulcast: false, scalabilityMode: undefined });
  });

  it("VP9 with its layers, as before", () => {
    expect(screenPublishOptions(DEFAULT_SCREEN, { codec: "vp9", hardware: false })).toMatchObject({ videoCodec: "vp9", simulcast: false, scalabilityMode: "L3T3_KEY" });
  });

  it("a watcher keeps a short buffer, as a stream player does, so the frames come evenly", () => {
    expect(SCREEN_SMOOTH_MS).toBe(250);
  });
});

describe("a phone's screen", () => {
  it("goes out of the phone's video chip at an uplink's bitrate, after the voice", () => {
    const options = phoneScreenPublishOptions({ ...DEFAULT_SCREEN, resolution: "720", fps: "30" }, false);
    expect(options.videoCodec).toBe("h264");
    expect(options.screenShareEncoding?.maxBitrate, "a PC's 720p 30 in H.264 is 4.9 Mbit/s").toBe(PHONE_SCREEN_MAX_BITRATE.mobile);
    expect(phoneScreenPublishOptions({ ...DEFAULT_SCREEN, resolution: "720", fps: "30" }, true).screenShareEncoding?.maxBitrate).toBe(4_000_000);
    expect(PHONE_SCREEN_HINT, "a phone's screen moves: frames go first, not pixels").toBe("motion");
    expect(onWifi({ type: "wifi" })).toBe(true);
    expect(onWifi({ type: "cellular" })).toBe(false);
    expect(onWifi(undefined), "unknown counts as a mobile network").toBe(false);
    expect(options.screenShareEncoding?.priority).toBe("low");
    expect(options.screenShareEncoding?.maxFramerate).toBeGreaterThanOrEqual(30);
    expect(options.degradationPreference).toBe("maintain-framerate");
    expect(options.simulcast).toBe(false);
  });
});
