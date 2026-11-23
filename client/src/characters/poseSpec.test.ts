import { describe, expect, it } from "vitest";
import { restPose } from "./motion";
import { ARM_PRESETS, BODY_PRESETS, HEAD_PRESETS, LEGS_PRESETS, RANGES, armReach, armsReach, defaultSpec, parseSpec, partsToPose, type ArmPlace } from "./poseSpec";

const preset = (id: string): ArmPlace => ARM_PRESETS.find((p) => p.id === id)!.value;
const length = (v: readonly number[]) => Math.hypot(...v);

describe("poseSpec", () => {
  it("sends a hand where its preset says, the left one to its own side", () => {
    const side = armReach(preset("side"), "R");
    expect(side.part).toBe("handR");
    expect(side.from).toBe("armR");
    expect(side.offset[0]).toBeLessThan(-0.95);
    expect(Math.abs(side.offset[1])).toBeLessThan(0.05);
    expect(armReach(preset("side"), "L").offset[0]).toBeGreaterThan(0.95);
    expect(armReach(preset("forward"), "R").offset[2]).toBeGreaterThan(0.95);
    expect(armReach(preset("up"), "R").offset[1]).toBeGreaterThan(0.9);
    expect(armReach(preset("down"), "R").offset[1]).toBeLessThan(-0.85);
  });

  it("brings the hand nearer the more the elbow bends, and a hand at the face crosses in front", () => {
    const straight = armReach({ raise: 0.5, side: 0.5, bend: 0 }, "R");
    const bent = armReach({ raise: 0.5, side: 0.5, bend: 0.8 }, "R");
    expect(length(straight.offset)).toBeCloseTo(1, 2);
    expect(length(bent.offset)).toBeLessThan(0.6);
    const face = armReach(preset("face"), "R");
    expect(face.offset[0], "toward the middle").toBeGreaterThan(0);
    expect(face.offset[1], "up by the face").toBeGreaterThan(0);
  });

  it("points a low elbow out and back, a raised one down", () => {
    const low = armReach(preset("hip"), "R").pole;
    expect(low[0]).toBeLessThan(-0.5);
    expect(low[2]).toBeLessThan(-0.3);
    const high = armReach(preset("up"), "R").pole;
    expect(high[1]).toBeLessThan(-0.9);
    expect(armsReach(defaultSpec()).map((r) => r.part)).toEqual(["handR", "handL"]);
  });

  it("keeps every preset inside the ranges the sliders allow", () => {
    const inside = (value: Record<string, number>, ranges: Record<string, readonly [number, number]>) => {
      for (const [key, [a, b]] of Object.entries(ranges)) expect(value[key], key).toBeGreaterThanOrEqual(a), expect(value[key], key).toBeLessThanOrEqual(b);
    };
    for (const p of ARM_PRESETS) inside(p.value, RANGES.arm);
    for (const p of HEAD_PRESETS) inside(p.value, RANGES.head);
    for (const p of BODY_PRESETS) inside(p.value, RANGES.body);
    for (const p of LEGS_PRESETS) inside(p.value, RANGES.legs);
  });

  it("stands as at rest when nothing is set", () => {
    const pose = partsToPose(defaultSpec());
    const rest = restPose();
    for (const joint of ["head", "neck", "spine", "chest", "armR", "foreR"] as const) expect(pose[joint]).toEqual(rest[joint]);
    expect(pose.y).toBe(0);
  });

  it("crouches with both knees and keeps a step's front foot forward", () => {
    const low = partsToPose({ ...defaultSpec(), legs: { crouch: 0.6, step: 0, wide: 0, knee: 0 } });
    expect(low.y).toBeLessThan(-0.03);
    expect(low.shinL[0]).toBeGreaterThan(0.8);
    expect(low.shinR[0]).toBeGreaterThan(0.8);
    const step = partsToPose({ ...defaultSpec(), legs: { crouch: 0, step: 1, wide: 0, knee: 0 } });
    expect(step.legR[0], "the right foot forward").toBeLessThan(-0.3);
    expect(step.legL[0], "the left one behind").toBeGreaterThan(0.15);
    const back = partsToPose({ ...defaultSpec(), legs: { crouch: 0, step: -1, wide: 0, knee: 0 } });
    expect(back.legL[0]).toBeLessThan(-0.3);
  });

  it("reads a kept pose back, bringing odd numbers in range", () => {
    const spec = { ...defaultSpec(), armR: { raise: 3, side: -9, bend: 0.4 }, fistR: true };
    const read = parseSpec(JSON.parse(JSON.stringify(spec)))!;
    expect(read.armR).toEqual({ raise: 1, side: -0.6, bend: 0.4 });
    expect(read.fistR).toBe(true);
    expect(parseSpec(null)).toBeNull();
    expect(parseSpec({ head: "x" })!.head).toEqual(defaultSpec().head);
  });
});
