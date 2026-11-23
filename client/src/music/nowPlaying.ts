import type { MusicWord } from "../chat/api";

/** How often the one who plays asks Windows what plays now. */
export const MUSIC_POLL_MS = 3000;
/** How often the same track is told again: a word lost on the way, or someone who missed it. */
export const MUSIC_RESEND_MS = 60_000;
/** Rust's limits (`music_word.rs`): longer is cut here rather than refused there. */
export const MUSIC_MAX_TEXT = 200;
export const MUSIC_MAX_APP = 60;

/** The same track: by title, artist and program (a cover read again need not be a new track). */
export function sameTrack(a: MusicWord | null, b: MusicWord | null): boolean {
  if (!a || !b) return false;
  return a.on === b.on && a.title === b.title && a.artist === b.artist && a.app === b.app;
}

export function resendDue(lastSentAt: number, now: number): boolean {
  return now - lastSentAt >= MUSIC_RESEND_MS;
}

/** A text as the word carries it: no control characters, at most `most` characters; nothing when empty. */
export function fitText(text: string | null | undefined, most: number): string | null {
  if (!text) return null;
  // eslint-disable-next-line no-control-regex
  const clean = [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()].slice(0, most).join("");
  return clean || null;
}
