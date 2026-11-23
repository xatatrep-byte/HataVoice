// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { emptyClip } from "../../characters/clip";
import type { Sampler } from "../../characters/compose";
import { restPose } from "../../characters/motion";
import { defaultSpec } from "../../characters/poseSpec";
import { actItem, bakePoses, forgetEmotion, fromRecipes, itemAct, loadEmotions, parseEmotions, saveEmotions, toRecipe, withPoses, type PoseItem } from "./emotions";

const LENGTHS: Record<string, number> = { "": 1, wave: 2, bow: 1, dance: 4 };
const sampler: Sampler = {
  length: (act) => LENGTHS[act] ?? 1,
  pose: (act) => ({ ...restPose(), smile: act === "wave" ? 1 : 0 }),
};
const ACTS = new Set(["wave", "bow", "dance"]);

const poseItem = (): PoseItem => {
  const clip = { ...emptyClip("x"), duration: 1.6 };
  return { id: "own1", kind: "pose", poses: [defaultSpec(), defaultSpec()], gap: 0.6, clip, speed: "normal", repeat: 1, face: null };
};

describe("emotions", () => {
  beforeEach(() => localStorage.clear());

  it("turns items into the constructor's recipe: speed, times, and each face over its own item", () => {
    const wave = { ...actItem("wave"), speed: "fast" as const, repeat: 2, face: "laugh" as const };
    const bow = { ...actItem("bow"), face: "smile" as const };
    const recipe = toRecipe([wave, bow], sampler);
    expect(recipe.body.map((p) => [p.act, p.speed, p.repeat])).toEqual([["wave", 1.4, 2], ["bow", 1, 1]]);
    const [first, second] = recipe.face;
    expect(first).toMatchObject({ look: "laugh", start: 0 });
    expect(first!.length).toBeCloseTo((2 / 1.4) * 2, 5);
    expect(second!.look).toBe("smile");
    expect(second!.start).toBeLessThan(first!.length);
  });

  it("plays poses of one's own from their clip", () => {
    const own = poseItem();
    const known = withPoses(sampler, [actItem("wave"), own]);
    expect(known.length(itemAct(own))).toBe(1.6);
    expect(known.length("wave")).toBe(2);
    expect(known.pose(itemAct(own), 0.5).smile).toBeCloseTo(restPose().smile, 3);
    expect(toRecipe([own], known).body[0]!.act).toBe(itemAct(own));
  });

  it("bakes poses one after another, holding the last; a single pose for a second", () => {
    const a = { ...restPose(), smile: 0 };
    const b = { ...restPose(), smile: 1 };
    const clip = bakePoses([a, b], 0.6);
    expect(clip.keys.map((k) => k.t)).toEqual([0, 0.6, 1.2]);
    expect(clip.keys[2]!.face.smile).toBe(1);
    expect(clip.duration).toBe(1.2);
    const one = bakePoses([a], 0.35);
    expect(one.keys.map((k) => k.t)).toEqual([0, 1]);
  });

  it("keeps and reads back emotions, dropping what it does not know", () => {
    saveEmotions({ clipabc: { name: "Привет", emoji: "👋", items: [actItem("wave"), actItem("moonwalk"), poseItem()] } });
    const read = loadEmotions(ACTS, sampler);
    expect(read.clipabc!.items.map((i) => i.kind)).toEqual(["act", "pose"]);
    expect(parseEmotions({ x: { name: 5 } }, ACTS)).toEqual({});
  });

  it("brings over the old constructor's motions, a face to the piece it covers most", () => {
    const old = {
      clipold: {
        name: "Старое",
        emoji: "🎉",
        recipe: { body: [{ act: "wave", speed: 0.6, repeat: 1 }, { act: "dance", speed: 1.5, repeat: 9 }], face: [{ look: "surprise", start: 2.5, length: 3 }] },
      },
    };
    const items = fromRecipes(old, ACTS, sampler).clipold!.items;
    expect(items.map((i) => (i.kind === "act" ? [i.act, i.speed, i.repeat, i.face] : null))).toEqual([
      ["wave", "slow", 1, null],
      ["dance", "fast", 3, "surprise"],
    ]);
  });

  it("forgets an emotion for good, also one the old constructor still lists", () => {
    localStorage.setItem("hatavoice.recipes", JSON.stringify({ clipold: { name: "Старое", recipe: { body: [{ act: "wave" }], face: [] } } }));
    const all = loadEmotions(ACTS, sampler);
    expect(Object.keys(all)).toEqual(["clipold"]);
    forgetEmotion(all, "clipold");
    expect(loadEmotions(ACTS, sampler)).toEqual({});
  });
});
