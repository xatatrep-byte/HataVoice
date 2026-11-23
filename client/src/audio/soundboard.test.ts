import { describe, expect, it } from "vitest";
import { BOARD, BOARD_LOUDNESS, BOARD_PEAK, BOARD_RATE, energyAbove, loudestMoment, synthesize } from "./soundboard";

describe("the sound board", () => {
  it.each(BOARD.map((s) => s.id))("%s sounds, fits in its length and does not clip", (id) => {
    const sound = BOARD.find((s) => s.id === id)!;
    const samples = synthesize(id)!;
    expect(samples.length).toBe(Math.ceil(sound.seconds * BOARD_RATE));
    let peak = 0;
    for (const sample of samples) {
      expect(Number.isFinite(sample)).toBe(true);
      peak = Math.max(peak, Math.abs(sample));
    }
    expect(peak).toBeLessThanOrEqual(BOARD_PEAK + 1e-6);
    // The end fades out: no click when it stops.
    expect(Math.abs(samples[samples.length - 1]!)).toBeLessThan(1e-3);
  });

  it.each(BOARD.map((s) => s.id))("%s is as loud as a voice, not louder (0.14.x had sounds up to 4.5 times louder)", (id) => {
    const loud = loudestMoment(synthesize(id)!);
    expect(loud).toBeLessThanOrEqual(BOARD_LOUDNESS + 1e-6);
    expect(loud).toBeGreaterThan(BOARD_LOUDNESS * 0.8);
  });

  it("is not hiss: applause is hands, not static (it was 88% noise above 5 kHz)", () => {
    expect(energyAbove(synthesize("applause")!, 5000)).toBeLessThan(0.2);
    for (const s of BOARD) {
      // Crickets sing at 4–5 kHz, that is their sound; the rest keeps the top quiet.
      const limit = s.id === "crickets" ? 0.45 : 0.15;
      expect(energyAbove(synthesize(s.id)!, 5000), s.id).toBeLessThan(limit);
      expect(energyAbove(synthesize(s.id)!, 8000), s.id).toBeLessThan(0.08);
    }
  });

  it("a sound is the same each time, and an unknown one is nothing", () => {
    expect(synthesize("applause")).toEqual(synthesize("applause"));
    expect(synthesize("nope")).toBeNull();
  });

  it("each sound is its own", () => {
    const ids = new Set(BOARD.map((s) => s.id));
    expect(ids.size).toBe(BOARD.length);
  });
});
