import { describe, expect, it } from "vitest";
import { readScreenStats, screenStatsLine } from "./screenStats";

const report = (bytes: number, timestamp: number, protocol = "udp") => [
  { type: "inbound-rtp", kind: "video", bytesReceived: bytes, timestamp, frameWidth: 2560, frameHeight: 1440, framesPerSecond: 59.6, codecId: "c" },
  { type: "inbound-rtp", kind: "audio", bytesReceived: 1, timestamp },
  { type: "codec", id: "c", mimeType: "video/AV1" },
  { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "l", currentRoundTripTime: 0.018 },
  { type: "local-candidate", id: "l", protocol },
];

describe("the numbers of the stream one drives", () => {
  it("come from the receiver's report, the rate from the last one", () => {
    const first = readScreenStats(report(1_000_000, 1000), null)!;
    expect(first.stats.mbps).toBe(0);
    const second = readScreenStats(report(4_000_000, 2000), first.point)!;
    expect(second.stats).toEqual({ width: 2560, height: 1440, fps: 60, mbps: 24, codec: "AV1", rttMs: 18, tcp: false });
    expect(screenStatsLine(second.stats)).toBe("2560×1440 · 60 к/с · 24 Мбит/с · AV1 · сеть 18 мс");
  });

  it("say when the way is TCP, which is why it stutters", () => {
    const { stats } = readScreenStats(report(1, 1000, "tcp"), null)!;
    expect(stats.tcp).toBe(true);
    expect(screenStatsLine({ ...stats, mbps: 6.25 })).toContain("6.3 Мбит/с · AV1 · сеть 18 мс · через TCP");
  });

  it("are nothing before any video came", () => {
    expect(readScreenStats([{ type: "inbound-rtp", kind: "audio" }], null)).toBeNull();
  });
});
