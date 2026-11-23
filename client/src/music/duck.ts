/** How loud music stays while someone else speaks (the listener's «Тише, когда говорят»). */
export const DUCK_SHARE = 0.35;
/** How long it stays down after the words end: the gaps between words do not pump it up and down. */
export const DUCK_HOLD_MS = 600;
/** How often the gain moves, and by how much at most: from full to 35% in a few steps, no jump. */
export const DUCK_TICK_MS = 100;
export const DUCK_STEP = 0.2;

/** The music's volume for `base` (the listener's own), down while someone else speaks if `duck` is on. */
export function duckTarget(base: number, othersSpeaking: boolean, duck: boolean): number {
  return duck && othersSpeaking ? base * DUCK_SHARE : base;
}

/** Down now: someone speaks, or spoke less than `DUCK_HOLD_MS` ago. */
export function duckedNow(othersSpeaking: boolean, lastSpeechAt: number, now: number): boolean {
  return othersSpeaking || now - lastSpeechAt < DUCK_HOLD_MS;
}

/** One step from `current` toward `target`, at most `step`. */
export function stepToward(current: number, target: number, step: number): number {
  const delta = target - current;
  return Math.abs(delta) <= step ? target : current + Math.sign(delta) * step;
}
