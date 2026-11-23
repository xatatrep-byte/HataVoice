import { describe, expect, it } from "vitest";
import { isMicBusy, micRetryDelay } from "./micRetry";

const domError = (name: string) => Object.assign(new Error("x"), { name });

describe("isMicBusy", () => {
  it("takes a mic Windows did not give for one worth another try", () => {
    expect(isMicBusy(domError("NotReadableError"))).toBe(true);
    expect(isMicBusy(domError("AbortError"))).toBe(true);
    expect(isMicBusy(domError("TrackStartError"))).toBe(true);
  });

  it("gives up on what a try cannot fix", () => {
    expect(isMicBusy(domError("NotAllowedError"))).toBe(false);
    expect(isMicBusy(domError("NotFoundError"))).toBe(false);
    expect(isMicBusy(domError("OverconstrainedError"))).toBe(false);
    expect(isMicBusy(new Error("x"))).toBe(false);
    expect(isMicBusy("NotReadableError")).toBe(false);
  });
});

describe("micRetryDelay", () => {
  it("tries quickly at first, then every five seconds", () => {
    expect([1, 2, 3, 4, 10].map(micRetryDelay)).toEqual([1000, 2000, 3000, 5000, 5000]);
  });
});
