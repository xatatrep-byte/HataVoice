import { Track, type TrackPublishOptions } from "livekit-client";
import { effectiveVolume, type VolumeMap } from "../audio/volumes";
import { screenVolumeKey } from "./screen";

/**
 * Music played together: the sound of one program of the one who plays, a track of its own in the call, encrypted like
 * every other. LiveKit has no source for music; `unknown` (allowed with the stream right) and this name tell it apart.
 */
export const MUSIC_TRACK = "music";

/** Stereo Opus at a stream's quality: music is listened to, not talked over. */
export const MUSIC_BITRATE = 256_000;

export const MUSIC_UPDATE_SERVER = "Сервер не разрешает музыку — его нужно обновить";

export function musicPublishOptions(): TrackPublishOptions {
  return {
    source: Track.Source.Unknown,
    name: MUSIC_TRACK,
    audioPreset: { maxBitrate: MUSIC_BITRATE },
    forceStereo: true,
    // Silence and redundancy are a voice's: music keeps every packet as it is.
    dtx: false,
    red: false,
  };
}

export function isMusicPublication(publication: { source: Track.Source; trackName: string }): boolean {
  return publication.source === Track.Source.Unknown && publication.trackName === MUSIC_TRACK;
}

/**
 * How loud someone's track plays here: their voice and their screen's sound each by a volume of its own, music at
 * `music` (the listener's one music volume, already under ducking while someone else speaks), and nothing at all while
 * we do not listen to anyone.
 */
export function trackVolume(publication: { source: Track.Source; trackName: string }, identity: string, volumes: VolumeMap, deafened: boolean, music: number): number {
  if (deafened) return 0;
  if (isMusicPublication(publication)) return music;
  return effectiveVolume(volumes, publication.source === Track.Source.ScreenShareAudio ? screenVolumeKey(identity) : identity);
}

/** What the one who plays is told when the music would not go: a server from before music asks to be updated. */
export function musicErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/not allowed|permission|denied|unauthori[sz]ed/i.test(text)) return MUSIC_UPDATE_SERVER;
  return `Музыка не включилась: ${text}`;
}
