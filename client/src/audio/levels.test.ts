import { describe, expect, it } from "vitest";
import { dbToMeter, rmsToDb } from "./levels";

describe("rmsToDb", () => {
  it("converts RMS amplitude to dBFS with a floor for silence", () => {
    expect(rmsToDb(1)).toBe(0);
    expect(rmsToDb(0.1)).toBeCloseTo(-20, 2);
    expect(rmsToDb(0)).toBe(-100);
    expect(rmsToDb(-1)).toBe(-100);
  });
});

describe("dbToMeter", () => {
  it("maps −60…0 dB linearly onto 0…1 and clamps", () => {
    expect(dbToMeter(-60)).toBe(0);
    expect(dbToMeter(-30)).toBe(0.5);
    expect(dbToMeter(0)).toBe(1);
    expect(dbToMeter(5)).toBe(1);
    expect(dbToMeter(-100)).toBe(0);
  });
});
