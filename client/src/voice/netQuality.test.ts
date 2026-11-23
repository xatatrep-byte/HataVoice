import { describe, expect, it } from "vitest";
import { barsFor, judgeNet, lossPercent, readInbound, readUplink, serverBars } from "./netQuality";

describe("connection bars", () => {
  it("give 5 to a clean link and fewer as loss, ping and jitter grow", () => {
    expect(barsFor({ rttMs: 30, lossPct: 0, jitterMs: 3 })).toBe(5);
    expect(barsFor({ rttMs: 60, lossPct: 3, jitterMs: 10 })).toBe(4);
    expect(barsFor({ rttMs: 120, lossPct: 6, jitterMs: 25 })).toBeLessThanOrEqual(3);
    expect(barsFor({ rttMs: 400, lossPct: 15, jitterMs: 80 })).toBeLessThanOrEqual(1);
    expect(barsFor({ rttMs: null, lossPct: null, jitterMs: null })).toBeNull();
  });

  it("read LiveKit's word for someone's own link", () => {
    expect(serverBars("excellent")).toBe(5);
    expect(serverBars("good")).toBe(4);
    expect(serverBars("poor")).toBe(2);
    expect(serverBars("lost")).toBe(0);
    expect(serverBars("unknown")).toBeNull();
  });

  it("count loss between two readings of the counters", () => {
    expect(lossPercent({ lost: 0, received: 100 }, { lost: 5, received: 195 })).toBeCloseTo(5);
    expect(lossPercent(null, { lost: 5, received: 195 })).toBeNull();
    expect(lossPercent({ lost: 5, received: 195 }, { lost: 5, received: 195 })).toBeNull();
  });

  it("read the numbers out of WebRTC's reports", () => {
    expect(
      readUplink([
        { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.042 },
        { type: "remote-inbound-rtp", kind: "audio", fractionLost: 0.03, roundTripTime: 0.05 },
      ]),
    ).toEqual({ rttMs: 42, lossPct: 3 });
    expect(readInbound([{ type: "inbound-rtp", kind: "audio", packetsLost: 4, packetsReceived: 96, jitter: 0.008 }])).toEqual({
      counters: { lost: 4, received: 96 },
      jitterMs: 8,
    });
  });
});

describe("who the weak link is", () => {
  const good = { rttMs: 35, lossUpPct: 0, lossDownPct: 0.2, jitterMs: 4 };

  it("is nobody when everything is clean", () => {
    const verdict = judgeNet({ me: good, people: [{ id: "a", name: "Аня", server: "excellent", inbound: { lossPct: 0, jitterMs: 3 } }] });
    expect(verdict.me.bars).toBe(5);
    expect(verdict.me.blame).toBe("none");
    expect(verdict.people.a!.blame).toBe("none");
  });

  it("is the other one when the server sees loss on their side", () => {
    const verdict = judgeNet({ me: good, people: [{ id: "a", name: "Аня", server: "poor", inbound: { lossPct: 6, jitterMs: 30 } }] });
    expect(verdict.people.a!.blame).toBe("them");
    expect(verdict.people.a!.bars).toBeLessThanOrEqual(2);
    expect(verdict.people.a!.summary).toContain("Аня");
  });

  it("is us when our own sending loses packets, whoever we listen to", () => {
    const verdict = judgeNet({
      me: { rttMs: 60, lossUpPct: 9, lossDownPct: 7, jitterMs: 40 },
      people: [{ id: "a", name: "Аня", server: "excellent", inbound: { lossPct: 7, jitterMs: 40 } }],
    });
    expect(verdict.me.blame).toBe("me");
    expect(verdict.people.a!.blame).toBe("me");
    expect(verdict.me.summary).toMatch(/твой интернет/i);
  });

  it("is the server when everyone's link is bad at once", () => {
    const verdict = judgeNet({
      me: { rttMs: 380, lossUpPct: 8, lossDownPct: 8, jitterMs: 60 },
      people: [
        { id: "a", name: "Аня", server: "poor", inbound: { lossPct: 8, jitterMs: 60 } },
        { id: "b", name: "Боря", server: "poor", inbound: { lossPct: 9, jitterMs: 55 } },
      ],
    });
    expect(verdict.me.blame).toBe("server");
    expect(verdict.people.b!.blame).toBe("server");
  });
});
