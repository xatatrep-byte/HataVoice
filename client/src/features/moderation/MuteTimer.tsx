import { useEffect, useState } from "react";

/** A moderator's mute on us, as the mic buttons show it. */
export type ServerMute = { until: number | null; byName: string; reason: string };

/** 900 → "15:00", 3725 → "1:02:05". */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mmss = `${h ? String(m).padStart(2, "0") : m}:${String(s % 60).padStart(2, "0")}`;
  return h ? `${h}:${mmss}` : mmss;
}

export function muteLabel(mute: ServerMute): string {
  return mute.reason ? `Тебя заглушил ${mute.byName}: ${mute.reason}` : `Тебя заглушил ${mute.byName}`;
}

/**
 * Time left on the mute by the server's clock (`clockOffset` = server minus local, seconds),
 * ticking every second; «до снятия» when it has no end.
 */
export function MuteTimer({ mute, clockOffset }: { mute: ServerMute; clockOffset: number }) {
  const left = () => (mute.until === null ? null : mute.until - (Date.now() / 1000 + clockOffset));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    setSeconds(left());
    if (mute.until === null) return;
    const timer = setInterval(() => setSeconds(left()), 1000);
    return () => clearInterval(timer);
  }, [mute.until, clockOffset]);
  return <span className="mute-timer">{seconds === null ? "до снятия" : formatRemaining(seconds)}</span>;
}
