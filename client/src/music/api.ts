import { invoke } from "@tauri-apps/api/core";

/** A program playing sound on this PC (`music.rs`). */
export type SoundSource = { pid: number; name: string; exe: string; level: number; active: boolean };

/** What Windows' media controls say a program plays; the cover as Windows gives it. */
export type NowPlaying = { title: string; artist: string; playing: boolean; cover: string | null };

export const musicSources = (): Promise<SoundSource[]> => invoke("music_sources");

/** What `music_now` answers once the program is closed (`MUSIC_GONE` in `music.rs`). */
export const MUSIC_GONE = "Программа с музыкой закрылась";

export const musicNow = (pid: number): Promise<NowPlaying | null> => invoke("music_now", { pid });

/** The sound of program `pid` goes to the page on the music lane (`OwnAudioTrack(view, "music")`). */
export const musicStart = (pid: number): Promise<void> => invoke("music_start", { pid });

export const musicStop = (): Promise<void> => invoke("music_stop");
