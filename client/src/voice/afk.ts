/**
 * Time to move to the AFK channel: AFK is set up, we are in another channel, and for the set
 * minutes there was neither keyboard or mouse input nor our voice. Counted on the client — the
 * server cannot reliably hear quiet voices.
 */
export function shouldGoAfk(a: {
  idleSeconds: number;
  lastVoiceAtMs: number | null;
  nowMs: number;
  afkMinutes: number;
  inChannel: string | null;
  afkChannel: string | null;
}): boolean {
  if (a.afkMinutes <= 0 || !a.afkChannel || !a.inChannel || a.inChannel === a.afkChannel) return false;
  const limitMs = a.afkMinutes * 60_000;
  const quiet = a.lastVoiceAtMs === null || a.nowMs - a.lastVoiceAtMs >= limitMs;
  return a.idleSeconds * 1000 >= limitMs && quiet;
}

/** How often the client looks at idle time while in a channel. */
export const AFK_CHECK_MS = 15_000;
