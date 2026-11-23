import { describe, expect, it } from "vitest";
import { Track } from "livekit-client";
import { isMusicPublication, musicErrorText, musicPublishOptions, MUSIC_BITRATE, MUSIC_TRACK, MUSIC_UPDATE_SERVER } from "./music";

describe("music played together, as a track", () => {
  it("goes as a stereo track of its own at a stream's quality", () => {
    const options = musicPublishOptions();
    expect(options.source).toBe(Track.Source.Unknown);
    expect(options.name).toBe(MUSIC_TRACK);
    expect(MUSIC_TRACK).toBe("music");
    expect(options.audioPreset?.maxBitrate).toBe(256_000);
    expect(MUSIC_BITRATE).toBe(256_000);
    expect(options.forceStereo).toBe(true);
    expect(options.dtx).toBe(false);
    expect(options.red).toBe(false);
  });

  it("is told from the other tracks by its name", () => {
    expect(isMusicPublication({ source: Track.Source.Unknown, trackName: "music" })).toBe(true);
    expect(isMusicPublication({ source: Track.Source.ScreenShareAudio, trackName: "screen-audio" })).toBe(false);
    expect(isMusicPublication({ source: Track.Source.Unknown, trackName: "other" })).toBe(false);
  });

  it("says plainly when the server is too old to let music in", () => {
    expect(musicErrorText(new Error("publishing rejected: not allowed to publish this source"))).toBe(MUSIC_UPDATE_SERVER);
    expect(MUSIC_UPDATE_SERVER).toBe("Сервер не разрешает музыку — его нужно обновить");
    expect(musicErrorText(new Error("insufficient permissions"))).toBe(MUSIC_UPDATE_SERVER);
    expect(musicErrorText(new Error("network down"))).toBe("Музыка не включилась: network down");
  });
});

describe("how loud a friend's track plays", () => {
  const at = (volume: number) => ({ volume, muted: false });
  const volumes = { anna: at(0.8), "music:anna": at(0.5), "screen:anna": at(0.9) };
  it("music at the listener's one music volume (ducked already), whoever plays it; deafened, nothing at all", async () => {
    const { trackVolume } = await import("./music");
    expect(trackVolume({ source: Track.Source.Unknown, trackName: "music" }, "anna", volumes, false, 0.7 * 0.35)).toBeCloseTo(0.7 * 0.35, 6);
    expect(trackVolume({ source: Track.Source.Unknown, trackName: "music" }, "boris", volumes, false, 1.4), "anyone's music, the same knob").toBeCloseTo(1.4, 6);
    expect(trackVolume({ source: Track.Source.Unknown, trackName: "music" }, "anna", volumes, true, 1), "deafened").toBe(0);
    expect(trackVolume({ source: Track.Source.ScreenShareAudio, trackName: "screen-audio" }, "anna", volumes, false, 0.35), "ducking is music's alone").toBe(0.9);
    expect(trackVolume({ source: Track.Source.Microphone, trackName: "mic" }, "anna", volumes, false, 0.35)).toBe(0.8);
  });
});
