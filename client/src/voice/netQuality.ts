import type { Quality } from "./participants";

/**
 * How good the link is, in 0–5 bars, and who makes it worse: us, the other one, or the server. Every two seconds the
 * call reads WebRTC's own reports: our sending (round trip to the server, loss the server reports back) and, for each
 * person, how their voice reaches us (loss and jitter). LiveKit's server adds its word on each person's own link
 * (`connectionQuality`, from what it receives from them). Bars are a voice call's MOS by the simplified E-model.
 */

export type Blame = "none" | "me" | "them" | "server" | "unknown";

export type NetJudgement = {
  /** 0–5; null while nothing is measured yet. */
  bars: number | null;
  blame: Blame;
  /** One line: «Всё в порядке», «Слабое звено — интернет Ани». */
  summary: string;
  /** The numbers behind it, a line each. */
  details: string[];
};

export type MyLink = { rttMs: number | null; lossUpPct: number | null; lossDownPct: number | null; jitterMs: number | null };
export type PersonLink = { id: string; name: string; server: Quality; inbound: { lossPct: number | null; jitterMs: number | null } | null };

/** Bars for a voice link: 5 is clean, 0 is barely there. */
export function barsFor({ rttMs, lossPct, jitterMs }: { rttMs: number | null; lossPct: number | null; jitterMs: number | null }): number | null {
  if (rttMs === null && lossPct === null && jitterMs === null) return null;
  // One way plus what the jitter buffer holds plus the codec: the delay the ear gets.
  const latency = (rttMs ?? 40) / 2 + 2 * (jitterMs ?? 5) + 20;
  let r = latency < 160 ? 93.2 - latency / 40 : 93.2 - (latency - 120) / 10;
  r -= 2.5 * (lossPct ?? 0);
  r = Math.max(0, Math.min(100, r));
  const mos = 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r);
  if (mos >= 4.2) return 5;
  if (mos >= 3.9) return 4;
  if (mos >= 3.5) return 3;
  if (mos >= 3.0) return 2;
  if (mos >= 2.4) return 1;
  return 0;
}

/** LiveKit's word on someone's own link, as bars. */
export function serverBars(quality: Quality): number | null {
  switch (quality) {
    case "excellent":
      return 5;
    case "good":
      return 4;
    case "poor":
      return 2;
    case "lost":
      return 0;
    default:
      return null;
  }
}

export type Counters = { lost: number; received: number };

/** Loss between two readings, %; null when nothing came between them. */
export function lossPercent(before: Counters | null, after: Counters): number | null {
  if (!before) return null;
  const lost = Math.max(0, after.lost - before.lost);
  const received = Math.max(0, after.received - before.received);
  if (lost + received === 0) return null;
  return (100 * lost) / (lost + received);
}

type Report = Record<string, unknown> & { type: string };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Our sending: the round trip to the server and the loss it reports back. */
export function readUplink(report: Report[]): { rttMs: number | null; lossPct: number | null } {
  let rtt: number | null = null;
  let loss: number | null = null;
  for (const s of report) {
    if (s.type === "candidate-pair" && (s.nominated === true || s.selected === true) && s.state === "succeeded") {
      rtt = num(s.currentRoundTripTime) ?? rtt;
    }
    if (s.type === "remote-inbound-rtp") {
      loss = num(s.fractionLost) ?? loss;
      if (rtt === null) rtt = num(s.roundTripTime);
    }
  }
  return { rttMs: rtt === null ? null : Math.round(rtt * 1000), lossPct: loss === null ? null : Math.round(loss * 1000) / 10 };
}

/** How someone's voice reaches us: the loss counters and the jitter. */
export function readInbound(report: Report[]): { counters: Counters; jitterMs: number | null } | null {
  for (const s of report) {
    if (s.type === "inbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) {
      const lost = num(s.packetsLost) ?? 0;
      const received = num(s.packetsReceived) ?? 0;
      const jitter = num(s.jitter);
      return { counters: { lost, received }, jitterMs: jitter === null ? null : Math.round(jitter * 1000) };
    }
  }
  return null;
}

const BAD = 2;
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(v < 10 ? 1 : 0).replace(".", ",")}%`);
const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} мс`);
const QUALITY_WORD: Record<Quality, string> = {
  excellent: "отличная",
  good: "хорошая",
  poor: "плохая",
  lost: "потеряна",
  unknown: "пока неизвестна",
};

/** Why our own link is weak, in a few words. */
function myReason(me: MyLink): string {
  if ((me.lossUpPct ?? 0) >= 3) return `теряются пакеты при отправке (${pct(me.lossUpPct)})`;
  if ((me.lossDownPct ?? 0) >= 3) return `теряются пакеты при приёме (${pct(me.lossDownPct)})`;
  if ((me.rttMs ?? 0) >= 250) return `большой пинг до сервера (${ms(me.rttMs)})`;
  if ((me.jitterMs ?? 0) >= 30) return `скачет задержка (${ms(me.jitterMs)})`;
  return "связь неровная";
}

/** Bars and blame for us and for each person in the call. */
export function judgeNet({ me, people }: { me: MyLink; people: PersonLink[] }): { me: NetJudgement; people: Record<string, NetJudgement> } {
  const myBars = barsFor({ rttMs: me.rttMs, lossPct: Math.max(me.lossUpPct ?? 0, me.lossDownPct ?? 0), jitterMs: me.jitterMs });
  const theirServer = people.map((p) => serverBars(p.server)).filter((b): b is number => b !== null);
  // Everyone's own link bad at once, ours too: what they share is the server (or the line of whoever hosts it).
  const serverToBlame = myBars !== null && myBars <= BAD && theirServer.length >= 1 && theirServer.every((b) => b <= BAD);
  const myDetails = [
    `Пинг до сервера: ${ms(me.rttMs)}`,
    `Потери: отправка ${pct(me.lossUpPct)}, приём ${pct(me.lossDownPct)}`,
    `Скачки задержки: ${ms(me.jitterMs)}`,
  ];
  const mine: NetJudgement =
    myBars === null
      ? { bars: null, blame: "unknown", summary: "Связь ещё измеряется", details: myDetails }
      : serverToBlame
        ? { bars: myBars, blame: "server", summary: "Плохо у всех сразу: похоже, проблема у сервера или у интернета того, кто его держит", details: myDetails }
        : myBars <= BAD
          ? { bars: myBars, blame: "me", summary: `Слабое звено — твой интернет: ${myReason(me)}`, details: myDetails }
          : { bars: myBars, blame: "none", summary: myBars >= 4 ? "Твой интернет в порядке" : "Связь терпимая", details: myDetails };

  const result: Record<string, NetJudgement> = {};
  for (const person of people) {
    const own = serverBars(person.server);
    const path = person.inbound ? barsFor({ rttMs: me.rttMs, lossPct: person.inbound.lossPct, jitterMs: person.inbound.jitterMs }) : null;
    const known = [own, path, myBars].filter((b): b is number => b !== null);
    const bars = known.length ? Math.min(...known) : null;
    const details = [
      `Его интернет по данным сервера: ${QUALITY_WORD[person.server]}`,
      `Его голос до тебя: потери ${pct(person.inbound?.lossPct ?? null)}, скачки ${ms(person.inbound?.jitterMs ?? null)}`,
      `Твой пинг до сервера: ${ms(me.rttMs)}`,
    ];
    let blame: Blame;
    let summary: string;
    if (bars === null) {
      blame = "unknown";
      summary = "Связь ещё измеряется";
    } else if (serverToBlame) {
      blame = "server";
      summary = "Плохо у всех сразу: похоже, проблема у сервера";
    } else if (own !== null && own <= BAD) {
      blame = "them";
      summary = `Слабое звено — интернет: ${person.name}. Сервер видит потери с его стороны`;
    } else if (myBars !== null && myBars <= BAD) {
      blame = "me";
      summary = `Слабое звено — твой интернет: ${myReason(me)}`;
    } else if (path !== null && path <= BAD) {
      blame = "them";
      summary = `Голос ${person.name} доходит до тебя с потерями — где-то по дороге`;
    } else {
      blame = "none";
      summary = bars >= 4 ? "Всё в порядке" : "Связь терпимая";
    }
    result[person.id] = { bars, blame, summary, details };
  }
  return { me: mine, people: result };
}
