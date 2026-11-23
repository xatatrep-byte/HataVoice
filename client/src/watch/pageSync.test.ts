import { describe, expect, it } from "vitest";
import { CATCH_UP, followCommands, HOLD_BACK, viewerAction, type Report } from "./pageSync";
import type { WatchState } from "./sync";

const state = (playing: boolean, pos: number, at = 1000): WatchState => ({ url: "https://example.com/a", playing, pos, at, by: "a", picks: {} });
const report = (playing: boolean, pos: number, wall: number): Report => ({ video: { playing, pos, dur: 1_330_000, frame: "https://p.example/1" }, wall });

describe("a page's video in step with everyone", () => {
  it("is moved where everyone is, and started or paused as they are", () => {
    // Everyone is at 60 s and playing; our page paused at 10 s.
    expect(followCommands(state(true, 60_000), 1000, report(false, 10_000, 5000), 5000)).toEqual([{ op: "seek", ms: 60_000 }, { op: "play" }]);
    // Close enough and playing too: nothing to do.
    expect(followCommands(state(true, 60_000), 2000, report(true, 60_500, 5000), 5500)).toEqual([]);
    // No video found on the page yet: nothing to tell it.
    expect(followCommands(state(true, 60_000), 1000, null, 5000)).toEqual([]);
  });

  it("catches up a little behind by speed, waits a little ahead, and moves only when far off, a little ahead", () => {
    // Everyone at 61 s now; ours playing at 58 s: 3 s behind, faster, no move (a move would load again).
    expect(followCommands(state(true, 60_000), 2000, report(true, 58_000, 5000), 5000)).toEqual([{ op: "rate", rate: CATCH_UP }]);
    // Already faster: nothing new to say.
    expect(followCommands(state(true, 60_000), 2000, report(true, 58_000, 5000), 5000, { rate: CATCH_UP, lead: 0 })).toEqual([]);
    // Ahead by a second: slower.
    expect(followCommands(state(true, 60_000), 2000, report(true, 62_000, 5000), 5000)).toEqual([{ op: "rate", rate: HOLD_BACK }]);
    // In step again: back to its own speed; halfway there, it keeps on.
    expect(followCommands(state(true, 60_000), 2000, report(true, 61_050, 5000), 5000, { rate: CATCH_UP, lead: 0 })).toEqual([{ op: "rate", rate: 1 }]);
    expect(followCommands(state(true, 60_000), 2000, report(true, 60_700, 5000), 5000, { rate: CATCH_UP, lead: 0 })).toEqual([]);
    // Ten seconds behind: moved, ahead by the time a move takes to play again.
    expect(followCommands(state(true, 60_000), 2000, report(true, 51_000, 5000), 5000, { rate: 1, lead: 1200 })).toEqual([{ op: "seek", ms: 62_200 }]);
    // Paused everywhere: no speed games, its own speed back.
    expect(followCommands(state(false, 60_000), 2000, report(false, 60_000, 5000), 5000, { rate: CATCH_UP, lead: 1200 })).toEqual([{ op: "rate", rate: 1 }]);
  });

  it("says to everyone what the viewer pressed in the page, but not what we made it do", () => {
    const playing = state(true, 60_000);
    expect(viewerAction(report(true, 60_000, 1000), report(false, 61_000, 2000), playing, 0)).toEqual({ op: "pause", pos: 61_000 });
    expect(viewerAction(report(true, 60_000, 1000), report(false, 61_000, 2000), playing, 2500), "our command settles").toBeNull();
    // A drag of the time bar.
    expect(viewerAction(report(true, 60_000, 1000), report(true, 300_000, 2000), playing, 0)).toEqual({ op: "seek", pos: 300_000 });
    // Playing on, a second later: nothing.
    expect(viewerAction(report(true, 60_000, 1000), report(true, 61_000, 2000), playing, 0)).toBeNull();
  });

  it("does not take another video loading (an episode, a dub, a player chosen) for the viewer's pause or move", () => {
    const playing = state(true, 60_000);
    const other = (playing: boolean, pos: number, wall: number, change: { dur?: number; frame?: string }): Report => ({ video: { playing, pos, dur: 1_330_000, frame: "https://p.example/1", ...change }, wall });
    expect(viewerAction(report(true, 600_000, 1000), other(false, 0, 2000, { dur: 3_010_041 }), playing, 0), "another episode").toBeNull();
    expect(viewerAction(report(true, 600_000, 1000), other(false, 0, 2000, { frame: "https://other.example/2" }), playing, 0), "another player").toBeNull();
  });

  it("does not take a video that never started for a pause", () => {
    const playing = state(true, 60_000);
    // The browser refused to start it: paused in report after report.
    expect(viewerAction(report(false, 0, 1000), report(false, 0, 2000), playing, 0)).toBeNull();
    // The first report of all says nothing about the viewer.
    expect(viewerAction(null, report(false, 0, 2000), playing, 0)).toBeNull();
  });
});
