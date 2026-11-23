import { describe, expect, it } from "vitest";
import { shouldGoAfk } from "./afk";

const NOW = 10_000_000;
const base = { idleSeconds: 15 * 60, lastVoiceAtMs: null, nowMs: NOW, afkMinutes: 15, inChannel: "games", afkChannel: "away" };

describe("shouldGoAfk", () => {
  it("goes AFK only after both input and voice are idle for the set minutes", () => {
    expect(shouldGoAfk(base)).toBe(true);
    expect(shouldGoAfk({ ...base, idleSeconds: 15 * 60 - 1 })).toBe(false);
    expect(shouldGoAfk({ ...base, lastVoiceAtMs: NOW - 60_000 })).toBe(false);
    expect(shouldGoAfk({ ...base, lastVoiceAtMs: NOW - 15 * 60_000 })).toBe(true);
  });

  it("never moves someone already in the AFK channel or when AFK is off", () => {
    expect(shouldGoAfk({ ...base, inChannel: "away" })).toBe(false);
    expect(shouldGoAfk({ ...base, inChannel: null })).toBe(false);
    expect(shouldGoAfk({ ...base, afkMinutes: 0 })).toBe(false);
    expect(shouldGoAfk({ ...base, afkChannel: null })).toBe(false);
  });
});
