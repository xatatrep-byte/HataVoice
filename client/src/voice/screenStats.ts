import { useEffect, useRef, useState } from "react";

/** What the one who drives a PC sees of the stream: its picture, its rate, and the way it comes. */
export type ScreenStats = { width: number; height: number; fps: number; mbps: number; codec: string; rttMs: number | null; tcp: boolean };

export type StatsPoint = { bytes: number; at: number };

type Stat = Record<string, unknown> & { type: string; id?: string };

/** The numbers of one receiver's report; `last` gives the rate since the previous report. */
export function readScreenStats(report: Stat[], last: StatsPoint | null): { stats: ScreenStats; point: StatsPoint } | null {
  const inbound = report.find((s) => s.type === "inbound-rtp" && s.kind === "video");
  if (!inbound) return null;
  const bytes = Number(inbound.bytesReceived ?? 0);
  const at = Number(inbound.timestamp ?? 0);
  const seconds = last ? (at - last.at) / 1000 : 0;
  const mbps = last && seconds > 0 ? Math.max(0, (bytes - last.bytes) * 8) / seconds / 1_000_000 : 0;
  const codec = report.find((s) => s.id === inbound.codecId);
  const name = String(codec?.mimeType ?? "").replace(/^video\//i, "").toUpperCase();
  const pair = report.find((s) => s.type === "candidate-pair" && s.nominated === true && s.state === "succeeded");
  const local = report.find((s) => s.id === pair?.localCandidateId);
  const rtt = pair?.currentRoundTripTime;
  return {
    stats: {
      width: Number(inbound.frameWidth ?? 0),
      height: Number(inbound.frameHeight ?? 0),
      fps: Math.round(Number(inbound.framesPerSecond ?? 0)),
      mbps,
      codec: name,
      rttMs: typeof rtt === "number" ? Math.round(rtt * 1000) : null,
      tcp: local?.protocol === "tcp",
    },
    point: { bytes, at },
  };
}

export function screenStatsLine({ width, height, fps, mbps, codec, rttMs, tcp }: ScreenStats): string {
  const parts = [`${width}×${height}`, `${fps} к/с`, `${mbps.toFixed(mbps < 10 ? 1 : 0)} Мбит/с`];
  if (codec) parts.push(codec);
  if (rttMs !== null) parts.push(`сеть ${rttMs} мс`);
  if (tcp) parts.push("через TCP");
  return parts.join(" · ");
}

const EVERY_MS = 1000;

/** The stream's numbers once a second while `on`; null when off or not known yet. */
export function useScreenStats(track: object | null, on: boolean): ScreenStats | null {
  const [stats, setStats] = useState<ScreenStats | null>(null);
  const last = useRef<StatsPoint | null>(null);
  const receiver = (track as { receiver?: RTCRtpReceiver } | null)?.receiver;

  useEffect(() => {
    last.current = null;
    setStats(null);
    if (!on || !receiver?.getStats) return;
    let alive = true;
    const read = async () => {
      const report = [...(await receiver.getStats()).values()] as Stat[];
      const read = readScreenStats(report, last.current);
      if (!alive || !read) return;
      if (last.current) setStats(read.stats);
      last.current = read.point;
    };
    void read().catch(() => {});
    const timer = setInterval(() => void read().catch(() => {}), EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [receiver, on]);

  return on ? stats : null;
}
