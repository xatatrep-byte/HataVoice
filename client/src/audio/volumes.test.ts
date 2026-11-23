import { describe, expect, it } from "vitest";
import { effectiveVolume, parseVolumes, withVolume } from "./volumes";

describe("participant volumes", () => {
  it("parses stored volumes, dropping broken entries and clamping to 0..2", () => {
    const parsed = parseVolumes(
      JSON.stringify({
        Петя: { volume: 1.5, muted: false },
        Вася: { volume: 7, muted: true },
        Коля: { volume: "loud" },
        Аня: "nope",
      }),
    );
    expect(parsed).toEqual({
      Петя: { volume: 1.5, muted: false },
      Вася: { volume: 2, muted: true },
    });
    expect(parseVolumes(null)).toEqual({});
    expect(parseVolumes("{broken")).toEqual({});
  });

  it("effective volume is 1 by default, 0 when locally muted", () => {
    const volumes = { Петя: { volume: 0.5, muted: false }, Вася: { volume: 1.8, muted: true } };
    expect(effectiveVolume(volumes, "Петя")).toBe(0.5);
    expect(effectiveVolume(volumes, "Вася")).toBe(0);
    expect(effectiveVolume(volumes, "Новенький")).toBe(1);
  });

  it("withVolume updates one entry immutably and clamps", () => {
    const before = { Петя: { volume: 1, muted: false } };
    const after = withVolume(before, "Петя", { volume: 3 });
    expect(after).toEqual({ Петя: { volume: 2, muted: false } });
    expect(before).toEqual({ Петя: { volume: 1, muted: false } });
    expect(withVolume({}, "Вася", { muted: true })).toEqual({ Вася: { volume: 1, muted: true } });
  });
});
