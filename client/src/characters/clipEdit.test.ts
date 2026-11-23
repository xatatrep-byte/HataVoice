import { actLength } from "./motion";
import { describe, expect, it } from "vitest";
import { emptyClip } from "./clip";
import { addKey, clipFromAct, editPose, keyIndexAt, mirrorAt, moveKey, pastePose, poseOfClip, removeKey, resetJoint, stretch } from "./clipEdit";
import { restPose } from "./motion";

describe("editing a clip", () => {
  it("a change between keys makes a key there; on a key it changes that key", () => {
    const clip = emptyClip();
    const one = editPose(clip, 1, (pose) => (pose.smile = 1));
    expect(one.keys.map((k) => k.t)).toEqual([0, 1, 2]);
    expect(poseOfClip(one, 1).smile).toBeCloseTo(1);
    const two = editPose(one, 1, (pose) => (pose.smile = -1));
    expect(two.keys).toHaveLength(3);
    expect(poseOfClip(two, 1).smile).toBeCloseTo(-1);
    expect(clip.keys, "the clip before stays as it was: that is what undo returns to").toHaveLength(2);
  });

  it("a key added keeps what the clip showed at that moment", () => {
    const moved = editPose(emptyClip(), 2, (pose) => (pose.y = 0.4));
    const before = poseOfClip(moved, 1).y;
    const added = addKey(moved, 1);
    expect(added.keys).toHaveLength(3);
    expect(poseOfClip(added, 1).y).toBeCloseTo(before, 2);
  });

  it("a key goes, except the last one", () => {
    const clip = emptyClip();
    const one = removeKey(clip, 2);
    expect(one.keys).toHaveLength(1);
    expect(removeKey(one, 0).keys).toHaveLength(1);
    expect(removeKey(clip, 1), "no key there").toBe(clip);
  });

  it("a key moves between the ends and never onto another", () => {
    const clip = addKey(emptyClip(), 1);
    expect(moveKey(clip, 1, 1.5).keys.map((k) => k.t)).toEqual([0, 1.5, 2]);
    expect(moveKey(clip, 1, 99).keys.map((k) => k.t)).toEqual([0, 2, 2].length ? clip.keys.map((k) => k.t) : []);
    expect(moveKey(clip, 1, 2), "another is there").toBe(clip);
    expect(moveKey(clip, 0, 1.2).keys.map((k) => k.t)).toEqual([1, 1.2, 2]);
  });

  it("a new length stretches the motion", () => {
    const clip = addKey(emptyClip(), 1);
    const long = stretch(clip, 4);
    expect(long.duration).toBe(4);
    expect(long.keys.map((k) => k.t)).toEqual([0, 2, 4]);
    expect(stretch(clip, 1000).duration).toBe(60);
    expect(stretch(clip, 0).duration).toBe(0.2);
  });

  it("mirrors a pose and puts a joint back", () => {
    let clip = editPose(emptyClip(), 0, (pose) => (pose.armL = [-1, 0, 0.5]));
    clip = mirrorAt(clip, 0);
    expect(poseOfClip(clip, 0).armR[0]).toBeCloseTo(-1);
    clip = resetJoint(clip, 0, "armR");
    expect(poseOfClip(clip, 0).armR[0]).toBeCloseTo(restPose().armR[0]);
  });

  it("pastes a copied pose at another moment", () => {
    const clip = editPose(emptyClip(), 0, (pose) => (pose.smile = 1));
    const pasted = pastePose(clip, 1, clip.keys[0]!);
    expect(keyIndexAt(pasted, 1)).toBe(1);
    expect(poseOfClip(pasted, 1).smile).toBeCloseTo(1);
  });

  it("starts from an emote of the program, which then moves the same way", () => {
    const wave = clipFromAct("wave", "Привет", "👋");
    expect(wave.duration).toBeCloseTo(actLength("wave"));
    expect(wave.keys.length).toBeGreaterThan(8);
    const raised = wave.keys.some((key) => key.joints.armR[0] < -1 || key.joints.armL[0] < -1 || Math.abs(key.joints.armR[2]) > 1 || Math.abs(key.joints.armL[2]) > 1);
    expect(raised, "somewhere in it an arm is up").toBe(true);
  });
});
