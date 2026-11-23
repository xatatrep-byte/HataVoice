/**
 * A mic Windows did not give us: another program holds it for a while (a DAW, a recorder), or it is not released yet.
 * Such a mic is tried again rather than turned off: a moment later it usually opens.
 */
export function isMicBusy(e: unknown): boolean {
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  return name === "NotReadableError" || name === "AbortError" || name === "TrackStartError";
}

/** Failed tries after which the message tells the person what they can do about it. */
export const MIC_PATIENCE = 3;

/** How long to wait before the next try, after `failures` failed ones: quick at first, then every five seconds. */
export function micRetryDelay(failures: number): number {
  return [1000, 2000, 3000][failures - 1] ?? 5000;
}
