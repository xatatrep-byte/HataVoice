import { describe, expect, it } from "vitest";
import { MAX_KEYS, parseClip } from "./clip";
import { bakeRecipe, blendPoses, layOut, mirrorPose, newBodyPiece, parseRecipe, poseOfRecipe, recipeLength, type Recipe, type Sampler } from "./compose";
import { restPose, type Pose } from "./motion";

/** Motions whose pose tells where in them one is: the right arm's x is (the act's number plus the moment) / 100. */
const ACTS: Record<string, number> = { "": 0, wave: 10, bow: 20, dance: 30 };
const LENGTHS: Record<string, number> = { "": 1, wave: 2, bow: 1, dance: 4 };
const sampler: Sampler = {
  length: (act) => LENGTHS[act] ?? 1,
  pose: (act, u) => {
    const pose = restPose();
    pose.armR = [(ACTS[act]! + u) / 100, 0.05, 0];
    pose.fistR = act === "bow";
    return pose;
  },
};
const piece = (act: string, extra: Partial<ReturnType<typeof newBodyPiece>> = {}) => ({ ...newBodyPiece(act), blend: 0, ...extra });
const armX = (pose: Pose) => pose.armR[0] * 100;

describe("the motion constructor", () => {
  it("lays pieces one after another, each flowing out of the one before", () => {
    const recipe: Recipe = { body: [piece("wave"), piece("bow", { blend: 0.4 }), piece("dance", { speed: 2, repeat: 3 })], face: [] };
    const laid = layOut(recipe, sampler);
    expect(laid.map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [1.6, 2.6],
      [2.6, 8.6],
    ]);
    // The overlap is never more than half of either piece.
    expect(layOut({ body: [piece("bow"), piece("wave", { blend: 0.8 })], face: [] }, sampler)[1]!.overlap).toBe(0.5);
    expect(recipeLength(recipe, sampler)).toBeCloseTo(8.6);
  });

  it("plays each piece at its speed, repeats it, and blends across an overlap", () => {
    const recipe: Recipe = { body: [piece("wave"), piece("dance", { speed: 2, repeat: 2, blend: 0.4 })], face: [] };
    expect(armX(poseOfRecipe(recipe, sampler, 1))).toBeCloseTo(11);
    // The dance starts at 1.6 and plays twice as fast: 1 s in, it is 2 s into the dance.
    expect(armX(poseOfRecipe(recipe, sampler, 2.6))).toBeCloseTo(32);
    // The second time round starts again from the dance's beginning.
    expect(armX(poseOfRecipe(recipe, sampler, 1.6 + 2.5))).toBeCloseTo(31);
    // Halfway through the overlap: between the wave's end and the dance's start.
    const mid = armX(poseOfRecipe(recipe, sampler, 1.8));
    expect(mid).toBeGreaterThan(12);
    expect(mid).toBeLessThan(30.2);
  });

  it("mirrors a piece: the other arm does it", () => {
    const recipe: Recipe = { body: [piece("bow", { mirror: true })], face: [] };
    const pose = poseOfRecipe(recipe, sampler, 0.5);
    expect(pose.armL[0]).toBeCloseTo(0.205);
    expect(pose.armL[1]).toBeCloseTo(-0.05);
    expect(pose.fistL).toBe(true);
    expect(mirrorPose(mirrorPose(pose)).armL[1]).toBeCloseTo(pose.armL[1]);
  });

  it("stands before and after the pieces", () => {
    const recipe: Recipe = { body: [piece("bow")], face: [{ id: "f", look: "smile", start: 0, length: 3 }] };
    expect(armX(poseOfRecipe({ body: [], face: [] }, sampler, 0.3))).toBeCloseTo(0.3);
    // A second after the bow ended: back to standing.
    expect(armX(poseOfRecipe(recipe, sampler, 2))).toBeCloseTo(2);
  });

  it("brings a face in and out softly", () => {
    const recipe: Recipe = { body: [], face: [{ id: "f", look: "smile", start: 1, length: 2 }] };
    expect(poseOfRecipe(recipe, sampler, 0.5).smile).toBe(restPose().smile);
    const rest = restPose().smile;
    expect(poseOfRecipe(recipe, sampler, 1.125).smile).toBeCloseTo(rest + (1 - rest) / 2);
    expect(poseOfRecipe(recipe, sampler, 2).smile).toBeCloseTo(1);
    expect(poseOfRecipe(recipe, sampler, 3.1).smile).toBe(restPose().smile);
  });

  it("bakes into an ordinary clip that friends' copies accept", () => {
    const recipe: Recipe = { body: [piece("wave"), piece("dance", { repeat: 4 })], face: [{ id: "f", look: "laugh", start: 0, length: 1 }] };
    const clip = bakeRecipe(recipe, sampler, { id: "clipabc", name: "Привет", emoji: "👋" });
    expect(clip.duration).toBeCloseTo(18);
    expect(clip.keys.length).toBe(18 * 15 + 1);
    expect(clip.keys[0]!.t).toBe(0);
    expect(clip.keys[clip.keys.length - 1]!.t).toBeCloseTo(18);
    expect(parseClip(JSON.parse(JSON.stringify(clip)))).not.toBeNull();
    // A long one keeps within the most keys a clip may have.
    const long = bakeRecipe({ body: Array.from({ length: 14 }, () => piece("dance")), face: [] }, sampler, { id: "clipabd", name: "Долго", emoji: "💃" });
    expect(long.keys.length).toBeLessThanOrEqual(MAX_KEYS);
  });

  it("reads a kept recipe, dropping what is not allowed", () => {
    const acts = new Set(["wave", "bow"]);
    const recipe = parseRecipe({ body: [{ act: "wave", speed: 9, repeat: 2 }, { act: "evil" }], face: [{ look: "smile", start: 1, length: 2 }, { look: "x" }] }, acts);
    expect(recipe?.body.map((p) => [p.act, p.speed, p.repeat])).toEqual([["wave", 2, 2]]);
    expect(recipe?.face.map((f) => f.look)).toEqual(["smile"]);
    expect(parseRecipe("nope", acts)).toBeNull();
  });

  it("blends the short way round", () => {
    const a = restPose();
    const b = restPose();
    a.head = [0, 3, 0];
    b.head = [0, -3, 0];
    expect(Math.abs(blendPoses(a, b, 0.5).head[1])).toBeGreaterThan(3);
  });
});
