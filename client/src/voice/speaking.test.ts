import { describe, expect, it } from "vitest";
import { SpeakingTracker } from "./speaking";

const tracker = () => new SpeakingTracker({ thresholdDb: -55, holdMs: 300 });

describe("SpeakingTracker", () => {
  it("knows nothing about someone it has not heard", () => {
    expect(tracker().get("anya")).toBeUndefined();
  });

  it("lights up as soon as a voice reaches the threshold and goes dark after the hold", () => {
    const t = tracker();
    t.feed("anya", -70, 0);
    expect(t.get("anya")?.speaking).toBe(false);
    t.feed("anya", -40, 20);
    expect(t.get("anya")?.speaking).toBe(true);
    t.feed("anya", -80, 40);
    t.feed("anya", -80, 300);
    expect(t.get("anya")?.speaking).toBe(true);
    t.feed("anya", -80, 340);
    expect(t.get("anya")?.speaking).toBe(false);
  });

  it("reports a louder voice as a higher level", () => {
    const t = tracker();
    t.feed("quiet", -50, 0);
    t.feed("loud", -20, 0);
    expect(t.get("loud")!.level).toBeGreaterThan(t.get("quiet")!.level);
    expect(t.get("loud")!.level).toBeLessThanOrEqual(1);
  });

  it("tracks people separately and forgets those who left", () => {
    const t = tracker();
    t.feed("anya", -30, 0);
    t.feed("petya", -90, 0);
    expect(t.get("anya")?.speaking).toBe(true);
    expect(t.get("petya")?.speaking).toBe(false);
    t.remove("anya");
    expect(t.get("anya")).toBeUndefined();
    t.clear();
    expect(t.get("petya")).toBeUndefined();
  });
});
