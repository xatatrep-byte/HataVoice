import { describe, expect, it } from "vitest";
import { DUCK_HOLD_MS, DUCK_SHARE, DUCK_STEP, DUCK_TICK_MS, duckedNow, duckTarget, stepToward } from "./duck";

describe("music under speech", () => {
  it("goes down to 35% while someone else speaks, if the listener wants it", () => {
    expect(DUCK_SHARE).toBe(0.35);
    expect(duckTarget(1, true, true)).toBeCloseTo(0.35, 6);
    expect(duckTarget(1, true, false), "the listener turned it off").toBe(1);
    expect(duckTarget(0.5, false, true)).toBe(0.5);
  });

  it("stays down for 600 ms after the words end", () => {
    expect(DUCK_HOLD_MS).toBe(600);
    expect(duckedNow(true, 0, 10_000)).toBe(true);
    expect(duckedNow(false, 10_000, 10_599)).toBe(true);
    expect(duckedNow(false, 10_000, 10_600)).toBe(false);
  });

  it("moves there in steps of a tenth of a second, never past it", () => {
    expect(DUCK_TICK_MS).toBe(100);
    let gain = 1;
    let ticks = 0;
    while (gain !== DUCK_SHARE && ticks < 50) {
      gain = stepToward(gain, DUCK_SHARE, DUCK_STEP);
      ticks++;
    }
    expect(gain).toBe(DUCK_SHARE);
    expect(ticks, "smooth, not a jump").toBeGreaterThan(1);
    expect(ticks * DUCK_TICK_MS, "within the hold").toBeLessThanOrEqual(DUCK_HOLD_MS);
    expect(stepToward(0.9, 1, DUCK_STEP)).toBe(1);
  });
});
