import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

/**
 * How long an ask (to control a screen, to play on a pad) holds: Rust keeps it as long (`ASK_TTL` in remote.rs and
 * pads.rs) and refuses a later answer. The window used to wait for an answer that would never come: no new ask could
 * be sent until both apps were restarted, and the one asked could still press «Разрешить» and get an error.
 */
export const ASK_TTL_MS = 60_000;

/** Our ask, unanswered for `ASK_TTL_MS` since `askedAt`, ends: `onExpired` is told, and one may ask again. */
export function useWaitingExpiry(waiting: string | null, askedAt: number, onExpired: (host: string) => void): void {
  const latest = useRef(onExpired);
  latest.current = onExpired;
  useEffect(() => {
    if (!waiting) return;
    const left = Math.max(0, askedAt + ASK_TTL_MS - Date.now());
    const timer = setTimeout(() => latest.current(waiting), left);
    return () => clearTimeout(timer);
  }, [waiting, askedAt]);
}

/** Asks to us older than `ASK_TTL_MS` go, each told to `onExpired`: an answer to one would be refused anyway. */
export function useAsksExpiry<T extends { user: string; at: number }>(asks: T[], setAsks: Dispatch<SetStateAction<T[]>>, onExpired: (ask: T) => void): void {
  const latest = useRef(onExpired);
  latest.current = onExpired;
  useEffect(() => {
    if (asks.length === 0) return;
    const soonest = Math.min(...asks.map((a) => a.at)) + ASK_TTL_MS;
    const timer = setTimeout(() => {
      const now = Date.now();
      const gone = asks.filter((a) => a.at + ASK_TTL_MS <= now);
      if (gone.length === 0) return;
      setAsks((list) => list.filter((a) => a.at + ASK_TTL_MS > now));
      for (const ask of gone) latest.current(ask);
    }, Math.max(0, soonest - Date.now()));
    return () => clearTimeout(timer);
  }, [asks, setAsks]);
}
