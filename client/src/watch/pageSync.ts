import { expectedPosition, needsSeek, type WatchState } from "./sync";

/** The video the agent found on the page: whether it plays, where it is and how long it is (ms), and its frame. */
export type AgentVideo = { playing: boolean; pos: number; dur: number; frame: string };
/** An agent's report, and the moment (this PC's clock, ms) it came. */
export type Report = { video: AgentVideo; wall: number };
export type PageCommand = { op: "play" } | { op: "pause" } | { op: "seek"; ms: number } | { op: "rate"; rate: number };
export type ViewerAction = { op: "play" | "pause" | "seek"; pos: number };

/** After we moved the page's video, what it reports is our doing, not the viewer's. */
export const SETTLE_MS = 1500;
/** A jump this big between two reports is someone seeking, not a stall. */
export const JUMP_MS = 3000;

/** Where the video is now, by its last report. */
export function reportedNow(report: Report, wall: number): number {
  return report.video.pos + (report.video.playing ? Math.max(0, wall - report.wall) : 0);
}

/** A playing video further off than this is moved; nearer, it catches up by its speed (ms). */
export const SEEK_MS = 4000;
/** A playing video this far off starts catching up, and this near stops (ms): a gap between, so it does not flicker. */
export const RATE_START_MS = 400;
export const RATE_STOP_MS = 150;
/** The speeds it catches up and waits by: what every player takes, YouTube's too. */
export const CATCH_UP = 1.25;
export const HOLD_BACK = 0.75;

/** How the page's video is being followed: its speed now, and how far ahead of everyone a move lands (the time the
 * video takes to play again after a move: a phone's took seconds, came back behind and was moved again and again). */
export type Follow = { rate: number; lead: number };

/**
 * What to tell the page's video so that it is where everyone is; nothing before it reported at all. A playing video a
 * little off catches up by its speed (no move, so no wait for it to load again); far off, it is moved, a little ahead.
 */
export function followCommands(state: WatchState, serverNow: number, report: Report | null, wall: number, follow: Follow = { rate: 1, lead: 0 }): PageCommand[] {
  if (!report) return [];
  const expected = expectedPosition(state, serverNow);
  const off = reportedNow(report, wall) - expected;
  const commands: PageCommand[] = [];
  const together = state.playing && report.video.playing;
  if (together ? Math.abs(off) > SEEK_MS : needsSeek(reportedNow(report, wall), expected)) {
    commands.push({ op: "seek", ms: Math.round(expected + (state.playing ? follow.lead : 0)) });
  } else if (together && Math.abs(off) > RATE_START_MS) {
    const rate = off < 0 ? CATCH_UP : HOLD_BACK;
    if (follow.rate !== rate) commands.push({ op: "rate", rate });
  } else if (follow.rate !== 1 && (!together || Math.abs(off) < RATE_STOP_MS)) {
    commands.push({ op: "rate", rate: 1 });
  }
  if (state.playing !== report.video.playing) commands.push({ op: state.playing ? "play" : "pause" });
  return commands;
}

/** A video of another length (both known), or in another frame: not the one the last report was about. */
export function anotherVideo(prev: Report, next: Report): boolean {
  const { dur: a } = prev.video;
  const { dur: b } = next.video;
  return prev.video.frame !== next.video.frame || (a > 0 && b > 0 && Math.abs(a - b) > 2000);
}

/**
 * What the viewer did in the page itself, to be said to everyone: a press of play or pause (the report's state changed
 * from the last one, and is not what everyone has), or a drag of the time bar. Nothing while our own command settles,
 * and nothing from a video that merely never started (a browser may refuse to start one by itself).
 */
export function viewerAction(prev: Report | null, next: Report, state: WatchState, settledUntil: number): ViewerAction | null {
  if (next.wall < settledUntil || !prev) return null;
  // Another video came (an episode, a dub, a player chosen): it loads paused at its start, which nobody pressed.
  if (anotherVideo(prev, next)) return null;
  if (prev.video.playing !== next.video.playing && next.video.playing !== state.playing) {
    return { op: next.video.playing ? "play" : "pause", pos: next.video.pos };
  }
  if (Math.abs(next.video.pos - reportedNow(prev, next.wall)) > JUMP_MS) return { op: "seek", pos: next.video.pos };
  return null;
}
