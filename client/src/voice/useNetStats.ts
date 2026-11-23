import { useEffect, useRef, useState } from "react";
import { Track, type Room } from "livekit-client";
import { lossPercent, readInbound, readUplink, type Counters, type MyLink } from "./netQuality";

/** What the call measured on this PC: our own link, and how each person's voice reaches us. */
export type NetStats = {
  me: MyLink;
  inbound: Record<string, { lossPct: number | null; jitterMs: number | null }>;
};

const EVERY_MS = 2000;

type Report = Record<string, unknown> & { type: string };
const reportOf = async (holder: unknown): Promise<Report[] | null> => {
  const statsOf = holder as { getStats?: () => Promise<RTCStatsReport> } | undefined;
  if (!statsOf?.getStats) return null;
  return [...(await statsOf.getStats()).values()] as Report[];
};
const average = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Reads WebRTC's reports every two seconds while the call is connected; null otherwise. */
export function useNetStats(room: Room | null, connected: boolean): NetStats | null {
  const [stats, setStats] = useState<NetStats | null>(null);
  const before = useRef(new Map<string, Counters>());

  useEffect(() => {
    before.current.clear();
    setStats(null);
    if (!room || !connected) return;
    let alive = true;
    const read = async () => {
      const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as { sender?: RTCRtpSender } | undefined;
      const upReport = await reportOf(mic?.sender);
      let uplink = upReport ? readUplink(upReport) : { rttMs: null, lossPct: null };
      const inbound: NetStats["inbound"] = {};
      const losses: number[] = [];
      const jitters: number[] = [];
      for (const person of room.remoteParticipants.values()) {
        const voice = person.getTrackPublication(Track.Source.Microphone)?.track as { receiver?: RTCRtpReceiver } | undefined;
        const report = await reportOf(voice?.receiver);
        if (!report) continue;
        // Not sending ourselves (no mic): the round trip of the receiving connection says the same about the line.
        if (uplink.rttMs === null) uplink = { ...uplink, rttMs: readUplink(report).rttMs };
        const read = readInbound(report);
        if (!read) continue;
        const loss = lossPercent(before.current.get(person.identity) ?? null, read.counters);
        before.current.set(person.identity, read.counters);
        inbound[person.identity] = { lossPct: loss, jitterMs: read.jitterMs };
        if (loss !== null) losses.push(loss);
        if (read.jitterMs !== null) jitters.push(read.jitterMs);
      }
      if (!alive) return;
      setStats({ me: { rttMs: uplink.rttMs, lossUpPct: uplink.lossPct, lossDownPct: average(losses), jitterMs: average(jitters) }, inbound });
    };
    void read().catch(() => {});
    const timer = setInterval(() => void read().catch(() => {}), EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [room, connected]);

  return stats;
}
