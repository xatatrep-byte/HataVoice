import type { Picks } from "./picks";

/** What is being watched together in a call, as the last word about it said. */
export type WatchState = {
  url: string;
  playing: boolean;
  /** Where the video was, ms, … */
  pos: number;
  /** … at this moment of the server's clock, ms. */
  at: number;
  /** Who said it last. */
  by: string;
  /** On a site: the player, season, episode and dub everyone watches. */
  picks: Picks;
};

/** Players further apart than this are put back in step. */
export const DRIFT_MS = 1500;
/** While a video plays, whoever moved it last says where it is this often (late comers catch on). */
export const HEARTBEAT_MS = 5000;

/** Where the video should be now (ms), by the last word and the server's clock now. */
export function expectedPosition(state: WatchState, serverNow: number): number {
  return state.playing ? state.pos + Math.max(0, serverNow - state.at) : state.pos;
}

/** The player at `current` (ms) has gone too far from where it should be. */
export function needsSeek(current: number, expected: number): boolean {
  return Math.abs(current - expected) > DRIFT_MS;
}
