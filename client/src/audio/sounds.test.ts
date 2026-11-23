import { describe, expect, it } from "vitest";
import { SOUND_TONES, type SoundKind } from "./sounds";

describe("SOUND_TONES", () => {
  it("has notes for every event, and paired events sound different", () => {
    const kinds: SoundKind[] = ["join", "leave", "mute", "unmute", "deafen", "undeafen"];
    for (const kind of kinds) expect(SOUND_TONES[kind].length).toBeGreaterThan(0);
    expect(SOUND_TONES.join).not.toEqual(SOUND_TONES.leave);
    expect(SOUND_TONES.mute).not.toEqual(SOUND_TONES.unmute);
    expect(SOUND_TONES.deafen).not.toEqual(SOUND_TONES.undeafen);
  });
});
