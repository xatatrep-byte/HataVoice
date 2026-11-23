import { describe, expect, it } from "vitest";
import { emptyClip, isClipAct, keyFromPose, mirrorKey, parseClip, parsePack, playClip, writeClipPose, type Clip } from "./clip";
import { restPose } from "./motion";

function raised(): Clip {
  const clip = emptyClip("Тест");
  const up = restPose();
  up.armR = [-1.2, 0, 0];
  up.smile = 1;
  up.y = 0.4;
  up.fistR = true;
  clip.keys[1] = keyFromPose(up, 2);
  return clip;
}

describe("a clip", () => {
  it("goes through its keys, and past the ends stays at them", () => {
    const clip = raised();
    const at = (t: number) => {
      const pose = restPose();
      writeClipPose(clip, t, pose);
      return pose;
    };
    expect(at(0).armR[0]).toBeCloseTo(restPose().armR[0], 3);
    expect(at(2).armR[0]).toBeCloseTo(-1.2, 3);
    expect(at(99).armR[0]).toBeCloseTo(-1.2, 3);
    expect(at(1).smile).toBeCloseTo((restPose().smile + 1) / 2, 2);
    expect(at(2).y).toBeCloseTo(0.4, 3);
    expect(at(2).fistR).toBe(true);
    expect(at(0).fistR).toBe(false);
  });

  it("a step key holds its pose until the next one", () => {
    const clip = raised();
    clip.keys[0]!.ease = "step";
    const pose = restPose();
    writeClipPose(clip, 1.9, pose);
    expect(pose.smile).toBeCloseTo(restPose().smile, 3);
  });

  it("played as an act it eases in and out over what the figure does", () => {
    const clip = raised();
    const start = restPose();
    start.smile = -1;
    playClip(clip, 0, start);
    expect(start.smile).toBe(-1);
    const middle = restPose();
    playClip(clip, 1.7, middle);
    expect(middle.armR[0]).toBeLessThan(-0.8);
    const end = restPose();
    end.smile = -1;
    playClip(clip, 2, end);
    expect(end.smile).toBe(-1);
  });

  it("a mirrored key swaps the sides", () => {
    const key = keyFromPose({ ...restPose(), armL: [-1, 0.2, 0.3], fistL: true, turn: 0.5 }, 0);
    const mirrored = mirrorKey(key);
    expect(mirrored.joints.armR).toEqual([-1, -0.2, -0.3]);
    expect(mirrored.fistR).toBe(true);
    expect(mirrored.fistL).toBe(false);
    expect(mirrored.body.turn).toBe(-0.5);
  });
});

describe("a clip from a friend", () => {
  it("survives the trip as JSON", () => {
    const clip = raised();
    expect(parseClip(JSON.parse(JSON.stringify(clip)))).toEqual({ ...clip, keys: clip.keys.map((k) => ({ ...k, ease: k.ease ?? "smooth" })) });
  });

  it("every number stays in its range, whatever the file says", () => {
    const clip = raised() as unknown as { keys: { joints: Record<string, unknown>; body: Record<string, unknown>; face: Record<string, unknown>; t: unknown }[] };
    clip.keys[0]!.joints.armR = [1e30, "x", null];
    clip.keys[0]!.body.y = 1e9;
    clip.keys[0]!.face.mouth = -50;
    clip.keys[0]!.t = -3;
    const parsed = parseClip(JSON.parse(JSON.stringify(clip)))!;
    expect(parsed.keys[0]!.joints.armR).toEqual([7, 0, 0]);
    expect(parsed.keys[0]!.body.y).toBe(2);
    expect(parsed.keys[0]!.face.mouth).toBe(-1);
    expect(parsed.keys[0]!.t).toBe(0);
  });

  it("is refused when it is not one", () => {
    expect(parseClip(null)).toBeNull();
    expect(parseClip({ id: "wave", name: "x", duration: 1, keys: [{ joints: {} }] }), "an act of the program's own").toBeNull();
    expect(parseClip({ id: "clipabc", name: "x", duration: 1, keys: [] })).toBeNull();
    expect(parseClip({ id: "clipabc", name: "x", duration: "1", keys: [{ joints: {} }] })).toBeNull();
    expect(parseClip({ id: "clipabc", name: "x", duration: 1, keys: Array.from({ length: 1000 }, () => ({ joints: {} })) })).toBeNull();
    expect(parseClip({ id: "clip abc", name: "x", duration: 1, keys: [{ joints: {} }] })).toBeNull();
  });

  it("only a clip's id is an act", () => {
    expect(isClipAct("clipabc")).toBe(true);
    expect(isClipAct("clipa1b2"), "only letters go through the group").toBe(false);
    expect(isClipAct("wave")).toBe(false);
    expect(isClipAct("clip")).toBe(false);
    expect(isClipAct("clip<script>")).toBe(false);
  });
});

describe("a character's pack", () => {
  const sha = "a".repeat(52);
  const key = "b".repeat(26);

  it("carries a model's address and key, the clips, or a model of the gallery", () => {
    const pack = parsePack({ v: 1, model: { sha, key }, clips: [raised()] })!;
    expect(pack.model).toEqual({ sha, key });
    expect(pack.clips).toHaveLength(1);
    expect(parsePack({ v: 1, gallery: "shino", clips: [] })!.gallery).toBe("shino");
  });

  it("drops what does not look right", () => {
    expect(parsePack({ v: 2, clips: [] })).toBeNull();
    expect(parsePack({ v: 1 })).toBeNull();
    expect(parsePack({ v: 1, gallery: "../../etc", clips: [] })!.gallery).toBeUndefined();
    expect(parsePack({ v: 1, model: { sha: "../x", key }, clips: [] })!.model).toBeUndefined();
    expect(parsePack({ v: 1, model: { sha, key: "a/b" }, clips: [] })!.model).toBeUndefined();
    expect(parsePack({ v: 1, clips: [{ id: "bad" }, raised()] })!.clips).toHaveLength(1);
  });
});
