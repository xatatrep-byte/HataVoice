import { describe, expect, it } from "vitest";
import { actLength, flight, followVoice, JOINTS, poseAt, restPose, type ActNow } from "./motion";
import { EMOTES, INTERACTIONS } from "./character";
import { recordedAct } from "./motionPlan";

const still = { t: 10, seed: 0, level: 0, act: null };
const act = (id: string, elapsed: number, more: Partial<ActNow> = {}): ActNow => ({ id, elapsed, role: "solo", ...more });

describe("motion", () => {
  it("waves hello with the elbow up and the hand by the head, on models too", () => {
    // The actor's take swept a straight arm like a wiper with the wrist hanging, and leaned the body over: on a model it
    // looked like a broken arm. Models play the drawn wave now.
    expect(recordedAct("wave", "solo")).toBe(false);
    for (const s of [0.9, 1.1, 1.3]) {
      const pose = poseAt({ ...still, act: act("wave", s) });
      expect(pose.armR[2], "the upper arm raised to the side").toBeLessThan(-1.3);
      expect(pose.foreR[0], "the elbow bent, the forearm up").toBeLessThan(-1.1);
      expect(Math.abs(pose.chest[2]) + Math.abs(pose.spine[2]), "the body upright").toBeLessThan(0.2);
    }
  });

  it("casts a spell in three beats: a ball at the chest, the hand up, then thrown out in front", () => {
    const at = (p: number) => poseAt({ ...still, act: act("spell", actLength("spell") * p) });
    const ball = at(0.18);
    expect(ball.foreL[0]).toBeLessThan(-1.2);
    expect(ball.foreR[0]).toBeLessThan(-1.2);
    expect(at(0.45).armR[0], "the arm over the head").toBeLessThan(-2.2);
    const thrown = at(0.72);
    expect(thrown.armR[0], "the arm out in front").toBeCloseTo(-1.5, 1);
    expect(thrown.foreR[0], "and straight").toBeGreaterThan(-0.3);
    expect(thrown.legR[0], "a step into it").toBeLessThan(-0.3);
  });

  it("stands, breathes and talks with the voice", () => {
    const quiet = poseAt(still);
    expect(quiet.mouth).toBe(0);
    expect(Math.abs(quiet.armL[2]) + Math.abs(quiet.armR[2])).toBeLessThan(0.5);
    const loud = poseAt({ ...still, level: 0.6 });
    expect(loud.mouth).toBeGreaterThan(0.2);
    expect(loud.mouth).toBeLessThanOrEqual(1);
  });

  it("talks with its face and head, not by waving its arms", () => {
    for (const t of [3, 7.3, 12.9]) {
      const quiet = poseAt({ ...still, t });
      const loud = poseAt({ ...still, t, level: 0.6, energy: 0.6 });
      for (const j of ["armL", "foreL", "handL", "armR", "foreR", "handR"] as const) {
        expect(loud[j], `${j} at ${t}`).toEqual(quiet[j]);
      }
    }
  });

  it("a voice that jumps from one reading to the next moves the mouth, never the head", () => {
    const soft = poseAt({ ...still, level: 0.1, energy: 0.4 });
    const loud = poseAt({ ...still, level: 0.6, energy: 0.4 });
    expect(loud.mouth).toBeGreaterThan(soft.mouth);
    for (const j of ["head", "neck", "chest", "spine"] as const) {
      for (let k = 0; k < 3; k++) expect(loud[j][k]).toBeCloseTo(soft[j][k]!, 6);
    }
  });

  it("follows a voice read ten times a second without jumps", () => {
    // The level arrives in steps every 100 ms, as the call measures it; frames come every 1/60 s.
    const steps = [0, 0.45, 0.05, 0.6, 0.2, 0.55, 0, 0.5, 0.1, 0.6, 0, 0, 0, 0];
    const voice = { mouth: 0, energy: 0 };
    let last = { ...voice };
    let worstMouth = 0;
    let worstEnergy = 0;
    for (let frame = 0; frame < steps.length * 6; frame++) {
      followVoice(voice, steps[Math.floor(frame / 6)]!, 1 / 60);
      worstMouth = Math.max(worstMouth, Math.abs(voice.mouth - last.mouth));
      worstEnergy = Math.max(worstEnergy, Math.abs(voice.energy - last.energy));
      last = { ...voice };
    }
    expect(worstMouth).toBeLessThan(0.16);
    expect(worstEnergy).toBeLessThan(0.02);
    // It talked for a second, so the body knows it; then it calms down.
    expect(voice.energy).toBeGreaterThan(0.05);
    for (let frame = 0; frame < 240; frame++) followVoice(voice, 0, 1 / 60);
    expect(voice.mouth).toBeLessThan(0.01);
    expect(voice.energy).toBeLessThan(0.05);
  });

  it("a clock that jumps back never poisons the voice for good", () => {
    // A frame time from before the last one (a sheet of pictures drawn out of order): nothing may turn into NaN.
    const voice = { mouth: 0.4, energy: 0.3 };
    followVoice(voice, 0.5, -1800);
    expect(Number.isFinite(voice.mouth)).toBe(true);
    expect(Number.isFinite(voice.energy)).toBe(true);
    followVoice(voice, 0.5, 1 / 60);
    expect(Number.isFinite(voice.energy)).toBe(true);
  });

  it("blinks now and then", () => {
    const eyes = Array.from({ length: 800 }, (_, i) => poseAt({ ...still, t: i * 0.01 }).eyes);
    expect(eyes.some((e) => e > 0.5)).toBe(true);
    expect(eyes.filter((e) => e < 0.1).length).toBeGreaterThan(600);
  });

  it("waves with a raised arm, jumps off the ground, spins around", () => {
    expect(poseAt({ ...still, act: act("wave", 1.2) }).armR[2]).toBeLessThan(-1.3);
    expect(Math.max(...[0.8, 1, 1.1, 1.3].map((e) => poseAt({ ...still, act: act("jump", e) }).y))).toBeGreaterThan(0.2);
    const turns = [0.4, 1, 1.6].map((e) => poseAt({ ...still, act: act("spin", e) }).turn);
    expect(turns[2]! - turns[0]!).toBeGreaterThan(Math.PI);
  });

  it("has a real motion for everything the menus offer", () => {
    for (const { id } of [...EMOTES, ...INTERACTIONS]) {
      expect(actLength(id), id).toBeGreaterThan(1);
      const role = INTERACTIONS.some((i) => i.id === id) ? "actor" : "solo";
      const rest = poseAt(still);
      const moved = [0.3, 0.5, 0.7].some((share) => {
        const pose = poseAt({ ...still, act: act(id, actLength(id) * share, { role, toward: { x: 2, z: 0 } }) });
        return JOINTS.some((j) => pose[j].some((v, k) => Math.abs(v - rest[j][k]!) > 0.1));
      });
      expect(moved, id).toBe(true);
    }
  });

  it("an act ends where it began", () => {
    for (const { id } of [...EMOTES, ...INTERACTIONS]) {
      const role = INTERACTIONS.some((i) => i.id === id) ? "actor" : "solo";
      const end = poseAt({ ...still, act: act(id, actLength(id), { role, toward: { x: 2, z: 0 } }) });
      const rest = poseAt(still);
      expect(Math.abs(end.x) + Math.abs(end.z), id).toBeLessThan(0.02);
      for (const j of JOINTS) {
        for (let k = 0; k < 3; k++) expect(Math.abs(end[j][k]! - rest[j][k]!), `${id} ${j}`).toBeLessThan(0.05);
      }
    }
  });

  it("walks up to hug and pushes the other one back", () => {
    const toward = { x: 2, z: 0 };
    const hugging = poseAt({ ...still, act: act("hug", 2, { role: "actor", toward }) });
    expect(hugging.x).toBeGreaterThan(1);
    expect(hugging.x).toBeLessThan(2);
    expect(hugging.armL[0]).toBeLessThan(-1);
    const pushed = poseAt({ ...still, act: act("push", 1.7, { role: "target", toward: { x: -2, z: 0 } }) });
    expect(pushed.x).toBeGreaterThan(0.2);
  });

  it("on the desktop does everything with the other from where it stands", () => {
    const hugging = poseAt({ ...still, act: act("hug", 2, { role: "actor", toward: { x: 6, z: 0 }, stay: true }) });
    expect(Math.abs(hugging.x) + Math.abs(hugging.z)).toBeLessThan(0.01);
    expect(hugging.armL[0]).toBeLessThan(-1);
    const pushed = poseAt({ ...still, act: act("push", 1.7, { role: "target", toward: { x: -6, z: 0 }, stay: true }) });
    expect(Math.abs(pushed.x)).toBeLessThan(0.01);
  });

  it("once walked up by the stage, neither walks nor turns within the act, but is still knocked back", () => {
    const hugging = poseAt({ ...still, act: act("hug", 0.3, { role: "actor", toward: { x: 0.5, z: 0 }, met: true }) });
    expect(Math.abs(hugging.x) + Math.abs(hugging.z)).toBeLessThan(0.01);
    expect(Math.abs(hugging.turn)).toBeLessThan(0.3);
    expect(poseAt({ ...still, act: act("hug", 2, { role: "actor", toward: { x: 0.5, z: 0 }, met: true }) }).armL[0]).toBeLessThan(-1);
    const pushed = poseAt({ ...still, act: act("push", 1.7, { role: "target", toward: { x: -0.6, z: 0 }, met: true }) });
    expect(pushed.x).toBeGreaterThan(0.2);
  });

  it("walks around the one in between, not through them", () => {
    const halfway = poseAt({ ...still, act: act("highfive", 0.42, { role: "actor", toward: { x: 2.3, z: 0 } }) });
    expect(halfway.x).toBeGreaterThan(0.5);
    expect(halfway.z).toBeGreaterThan(0.3);
    const there = poseAt({ ...still, act: act("highfive", 1.6, { role: "actor", toward: { x: 2.3, z: 0 } }) });
    expect(there.z).toBeCloseTo(0, 2);
  });

  it("throws a snowball from where it stands, and the ball flies in the middle of the act", () => {
    const thrower = [0.3, 0.75, 1.5, 2].map((e) => poseAt({ ...still, act: act("snowball", e, { role: "actor", toward: { x: 2, z: 0 } }) }));
    expect(thrower.every((p) => Math.abs(p.x) < 0.01)).toBe(true);
    const length = actLength("snowball");
    expect(flight("snowball", length * 0.3)).toBeNull();
    expect(flight("snowball", length * 0.5)).toBeCloseTo(0.5);
    expect(flight("wave", 1)).toBeNull();
  });

  it("walks by the distance its feet have gone", () => {
    const steps = [0, 0.2, 0.4].map((distance) => poseAt({ ...still, walk: { speed: 1, distance } }).legL[0]);
    expect(new Set(steps.map((v) => v.toFixed(2))).size).toBeGreaterThan(1);
    expect(restPose().legL[0]).toBe(0);
  });
});
