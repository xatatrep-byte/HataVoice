import { describe, expect, it } from "vitest";
import { isPlain, NO_FX, presetFx, VOICE_PRESETS } from "./voiceFx";
import { voiceBitrate } from "./settings";

describe("the voice changer", () => {
  it("has its presets, funny ones too, each with a name and an emoji", () => {
    const ids = VOICE_PRESETS.map((p) => p.id);
    for (const id of ["none", "chipmunk", "giant", "robot", "alien", "demon", "radio", "cave", "ghost"]) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(VOICE_PRESETS.every((p) => p.name && p.emoji)).toBe(true);
    expect(isPlain(presetFx("none", NO_FX))).toBe(true);
    expect(presetFx("chipmunk", NO_FX).pitch).toBeGreaterThan(0);
    expect(presetFx("giant", NO_FX).pitch).toBeLessThan(0);
    expect(presetFx("robot", NO_FX).robot).toBeGreaterThan(0.5);
    expect(presetFx("radio", NO_FX).radio).toBe(true);
  });

  it("«Свой» is what was set by hand; an unknown preset is the plain voice", () => {
    const own = { ...NO_FX, pitch: -3, echo: 0.4 };
    expect(presetFx("custom", own)).toEqual(own);
    expect(presetFx("nope", own)).toEqual(NO_FX);
  });

  it("the quality is a bitrate of Opus", () => {
    expect(voiceBitrate("32")).toBe(32_000);
    expect(voiceBitrate("256")).toBe(256_000);
    expect(voiceBitrate("510")).toBe(510_000);
  });
});
