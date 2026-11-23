import { describe, expect, it } from "vitest";
import { buildProfile } from "./clearance";
import { bodyRadius, DEFAULT_RADIUS, DESK_MAX_STEP_S, DESK_WALK_SCALE, deskStroll, deskWalkTarget, freeSpot, GAP, separate, spreadOnDesk, strollPlan, STROLL_SLOT_MS, wallTime, type Disc, frameStep } from "./spacing";

const FLOOR = { x: 4.6, back: -1.5, front: 1.45 };

describe("a body's radius", () => {
  it("is half its width or depth, whichever is more, plus room for the arms", () => {
    // A box 0.6 wide and 0.3 deep, a metre tall.
    const points: number[] = [];
    for (let y = 0; y <= 1; y += 0.05) for (let x = -0.3; x <= 0.3; x += 0.05) for (let z = -0.15; z <= 0.15; z += 0.05) points.push(x, y, z);
    expect(bodyRadius(buildProfile(points))).toBeCloseTo(0.36, 1);
    expect(bodyRadius(null)).toBe(DEFAULT_RADIUS);
  });
});

describe("a free spot", () => {
  it("is the wanted one when nobody is there, and the nearest free one when somebody is", () => {
    expect(freeSpot(1, 0, 0.3, [{ x: -2, z: 0, r: 0.3 }], FLOOR)).toEqual({ x: 1, z: 0 });
    const spot = freeSpot(0, 0, 0.3, [{ x: 0, z: 0, r: 0.3 }], FLOOR);
    expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(0.6 + GAP - 1e-6);
    expect(Math.hypot(spot.x, spot.z)).toBeLessThan(0.9);
  });

  it("stays on the floor", () => {
    const spot = freeSpot(9, 9, 0.3, [], FLOOR);
    expect(spot).toEqual({ x: FLOOR.x, z: FLOOR.front });
  });
});

describe("pushing apart", () => {
  it("moves two who overlap until they touch no more, but not two who are left together", () => {
    const discs: Disc[] = [
      { x: 0, z: 0, r: 0.3 },
      { x: 0.2, z: 0, r: 0.3 },
    ];
    for (let i = 0; i < 60; i++) separate(discs, 0.5);
    expect(discs[1]!.x - discs[0]!.x).toBeGreaterThan(0.59);
    const hugging: Disc[] = [
      { x: 0, z: 0, r: 0.3 },
      { x: 0.2, z: 0, r: 0.3 },
    ];
    separate(hugging, 1, () => false);
    expect(hugging[1]!.x).toBe(0.2);
  });

  it("parts even two on exactly the same spot", () => {
    const discs: Disc[] = [
      { x: 1, z: 1, r: 0.3 },
      { x: 1, z: 1, r: 0.3 },
    ];
    separate(discs, 1);
    expect(Math.abs(discs[1]!.x - discs[0]!.x)).toBeGreaterThan(0.5);
  });
});

describe("the desktop row", () => {
  it("spreads those put on the same spot (everyone not placed yet) side by side, inside the screen", () => {
    const items = ["a", "b", "c"].map((id) => ({ id, x: 5, y: 0, r: 0.3 }));
    const xs = spreadOnDesk(items, 0, 10, 0.5);
    const sorted = [...xs.values()].sort((a, b) => a - b);
    expect(sorted[1]! - sorted[0]!).toBeGreaterThanOrEqual(0.6 + GAP - 1e-6);
    expect(sorted[2]! - sorted[1]!).toBeGreaterThanOrEqual(0.6 + GAP - 1e-6);
    expect(sorted[0]!).toBeGreaterThanOrEqual(0.3);
    expect(sorted[2]!).toBeLessThanOrEqual(9.7);
    // Centred on where they all were put.
    expect((sorted[0]! + sorted[2]!) / 2).toBeCloseTo(5, 5);
  });

  it("leaves alone those on different lines and those already apart", () => {
    const xs = spreadOnDesk(
      [
        { id: "low", x: 5, y: 0, r: 0.3 },
        { id: "high", x: 5, y: 2, r: 0.3 },
        { id: "far", x: 1, y: 0, r: 0.3 },
      ],
      0,
      10,
      0.5,
    );
    expect(xs.get("low")).toBe(5);
    expect(xs.get("high")).toBe(5);
    expect(xs.get("far")).toBe(1);
  });

  it("slides a row that runs over the right edge back in", () => {
    const xs = spreadOnDesk(
      [
        { id: "a", x: 9.8, y: 0, r: 0.3 },
        { id: "b", x: 9.8, y: 0, r: 0.3 },
      ],
      0,
      10,
      0.5,
    );
    expect(Math.max(...xs.values())).toBeLessThanOrEqual(9.7 + 1e-9);
  });
});

describe("a stroll on the desktop", () => {
  it("goes some steps either way from where it was put, never off the screen", () => {
    expect(deskStroll(5, 0.5, 12, 3.5, 0.35)).toBe(5);
    expect(deskStroll(5, 1, 12, 3.5, 0.35)).toBe(8.5);
    expect(deskStroll(5, 0, 12, 3.5, 0.35)).toBe(1.5);
    expect(deskStroll(11, 1, 12, 3.5, 0.35), "the right edge").toBe(11.65);
    expect(deskStroll(1, 0, 12, 3.5, 0.35), "the left edge").toBe(0.35);
  });
});

describe("a frame's step", () => {
  it("a rare frame moves the walkers by the time that passed, up to a cap", () => {
    // The overlay drew a frame or two a second: with a tenth at most, a stroll went ten times slower.
    expect(frameStep(1000, 0.5)).toBe(0.5);
    expect(frameStep(1000, 0.1)).toBe(0.1);
    expect(frameStep(33, 0.5)).toBeCloseTo(0.033, 6);
    expect(frameStep(0, 0.5), "a first frame").toBeCloseTo(0.016, 6);
    expect(frameStep(-5, 0.5), "never backwards").toBe(0);
  });
});

describe("strolls in the call and on the desktop", () => {
  const WALL = 1_790_000_000_000;

  it("are told by the wall clock: two windows opened at different times stroll at the same moment, to the same side", () => {
    // The main window opened an hour before the characters' window: their own clocks differ, the wall clock does not.
    for (const seed of [0.4, 3.7, 9.9]) {
      for (let s = 0; s < 600; s += 7) {
        const stage = strollPlan(seed, wallTime(WALL - 3_600_000, 3_600_000 + s * 1000));
        const desk = strollPlan(seed, wallTime(WALL - 2_000, 2_000 + s * 1000));
        expect(desk).toEqual(stage);
      }
    }
  });

  it("a new one begins every 10 to 50 seconds, to either side", () => {
    const starts: number[] = [];
    const sides: number[] = [];
    let slot = strollPlan(2.5, WALL).slot;
    for (let ms = 0; ms <= 3_600_000; ms += 100) {
      const plan = strollPlan(2.5, WALL + ms);
      if (plan.slot === slot) continue;
      expect(plan.slot, "never a stroll skipped or taken twice").toBe(slot + 1);
      slot = plan.slot;
      starts.push(ms);
      sides.push(plan.chance);
    }
    expect(starts.length).toBeGreaterThan(3_600_000 / STROLL_SLOT_MS - 3);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(10_000);
      expect(starts[i]! - starts[i - 1]!).toBeLessThanOrEqual(50_000);
    }
    expect(sides.some((c) => c < 0.3)).toBe(true);
    expect(sides.some((c) => c > 0.7)).toBe(true);
    expect(sides.every((c) => c >= 0 && c < 1)).toBe(true);
  });

  it("two people do not stroll in lockstep", () => {
    let same = 0;
    for (let s = 0; s < 120; s++) {
      if (strollPlan(1.1, WALL + s * 30_000).chance === strollPlan(6.2, WALL + s * 30_000).chance) same++;
    }
    expect(same).toBe(0);
  });

  it("a window that draws once in a few seconds still walks the whole way in time", () => {
    // Windows may hold back the see-through window over everything: a stroll of two heights takes about three seconds.
    expect(frameStep(3000, DESK_MAX_STEP_S)).toBe(3);
  });
});

describe("the desktop walking as the call's stage does", () => {
  it("goes from where it was put as far as the stage's figure goes from its place, a few times over", () => {
    expect(deskWalkTarget(5, 0, 12, 0.35)).toBe(5);
    expect(deskWalkTarget(5, 0.7, 12, 0.35)).toBeCloseTo(5 + 0.7 * DESK_WALK_SCALE, 9);
    expect(deskWalkTarget(5, -0.7, 12, 0.35)).toBeCloseTo(5 - 0.7 * DESK_WALK_SCALE, 9);
  });

  it("never off the screen", () => {
    expect(deskWalkTarget(11, 3, 12, 0.35)).toBe(11.65);
    expect(deskWalkTarget(1, -3, 12, 0.35)).toBe(0.35);
  });
});
