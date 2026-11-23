import { describe, expect, it } from "vitest";
import { DEFAULT_AUDIO_SETTINGS, parseAudioSettings } from "./settings";

describe("parseAudioSettings", () => {
  it("returns defaults for missing or broken data", () => {
    expect(parseAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings("not json")).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings("[1,2]")).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it("defaults to RNNoise, echo cancellation on, voice activation, 200 ms tail", () => {
    expect(DEFAULT_AUDIO_SETTINGS).toEqual({
      noiseSuppression: "rnnoise",
      echoCancellation: true,
      mode: "voice",
      pttBinding: [],
      pttTailMs: 200,
      vadThresholdDb: -50,
      inputDeviceId: "default",
      outputDeviceId: "default",
      sounds: true,
      moderationGifSound: true,
      voicePreset: "none",
      voiceCustom: { pitch: 0, wobble: 0, robot: 0, echo: 0, reverb: 0, radio: false },
      voiceQuality: "510",
    });
  });

  it("validates the activation threshold, devices and sounds", () => {
    expect(parseAudioSettings(JSON.stringify({ vadThresholdDb: -200 })).vadThresholdDb).toBe(-80);
    expect(parseAudioSettings(JSON.stringify({ vadThresholdDb: 0 })).vadThresholdDb).toBe(-10);
    expect(parseAudioSettings(JSON.stringify({ vadThresholdDb: "loud" })).vadThresholdDb).toBe(-50);
    expect(parseAudioSettings(JSON.stringify({ outputDeviceId: 5 })).outputDeviceId).toBe("default");
    expect(parseAudioSettings(JSON.stringify({ outputDeviceId: "abc" })).outputDeviceId).toBe("abc");
    expect(parseAudioSettings(JSON.stringify({ inputDeviceId: 5 })).inputDeviceId).toBe("default");
    expect(parseAudioSettings(JSON.stringify({ inputDeviceId: "usb" })).inputDeviceId).toBe("usb");
    expect(parseAudioSettings(JSON.stringify({ sounds: false })).sounds).toBe(false);
    expect(parseAudioSettings(JSON.stringify({ moderationGifSound: false })).moderationGifSound).toBe(false);
    expect(parseAudioSettings(JSON.stringify({ moderationGifSound: 1 })).moderationGifSound).toBe(true);
  });

  it("keeps valid fields and replaces invalid ones with defaults", () => {
    const parsed = parseAudioSettings(
      JSON.stringify({
        noiseSuppression: "browser",
        echoCancellation: "yes",
        mode: "ptt",
        pttBinding: ["key:162", 5, "mouse:x1"],
        pttTailMs: 350,
      }),
    );
    expect(parsed).toEqual({
      noiseSuppression: "browser",
      echoCancellation: true,
      mode: "ptt",
      pttBinding: ["key:162", "mouse:x1"],
      pttTailMs: 350,
      vadThresholdDb: -50,
      inputDeviceId: "default",
      outputDeviceId: "default",
      sounds: true,
      moderationGifSound: true,
      voicePreset: "none",
      voiceCustom: { pitch: 0, wobble: 0, robot: 0, echo: 0, reverb: 0, radio: false },
      voiceQuality: "510",
    });
  });

  it("rejects unknown enum values", () => {
    const parsed = parseAudioSettings(JSON.stringify({ noiseSuppression: "magic", mode: "always" }));
    expect(parsed.noiseSuppression).toBe("rnnoise");
    expect(parsed.mode).toBe("voice");
  });

  it("clamps the release tail to 0..1000 ms", () => {
    expect(parseAudioSettings(JSON.stringify({ pttTailMs: -5 })).pttTailMs).toBe(0);
    expect(parseAudioSettings(JSON.stringify({ pttTailMs: 99999 })).pttTailMs).toBe(1000);
    expect(parseAudioSettings(JSON.stringify({ pttTailMs: "fast" })).pttTailMs).toBe(200);
  });

  it("keeps the voice changer and the quality, and refuses what is none", () => {
    const parsed = parseAudioSettings(
      JSON.stringify({ voicePreset: "robot", voiceCustom: { pitch: 40, robot: 0.5, radio: true, echo: "a" }, voiceQuality: "256" }),
    );
    expect(parsed.voicePreset).toBe("robot");
    expect(parsed.voiceCustom).toEqual({ pitch: 12, wobble: 0, robot: 0.5, echo: 0, reverb: 0, radio: true });
    expect(parsed.voiceQuality).toBe("256");
    expect(parseAudioSettings(JSON.stringify({ voicePreset: "dragon", voiceQuality: "ultra" }))).toMatchObject({ voicePreset: "none", voiceQuality: "510" });
    expect(parseAudioSettings(JSON.stringify({ voicePreset: "custom" })).voicePreset).toBe("custom");
  });
});
