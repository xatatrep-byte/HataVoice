import { describe, expect, it } from "vitest";
import { characterCode, DEFAULT_CHARACTER, defaultCharacterFor, isAct, isInteraction, moveAct, parseCharacter, parseMove } from "./character";

describe("characters", () => {
  it("go into a short code and back", () => {
    const c = { ...DEFAULT_CHARACTER, body: "chunky" as const, hat: "crown" as const, eyes: "cool" as const, outfit: "#00FF88" };
    const code = characterCode(c);
    expect(code).toBe("c2.chunky.f6d1b1.00ff88.short.3b2a20.crown.cool.hoodie.3a3f4b.none");
    expect(code.length).toBeLessThanOrEqual(96);
    expect(parseCharacter(code)).toEqual({ ...c, outfit: "#00ff88" });
  });

  it("refuse codes that are not theirs", () => {
    for (const bad of ["", "c3.round.f6d1b1.ff8a4c.short.3b2a20.none.dots", "c2.round.f6d1b1.ff8a4c.short.3b2a20.none.dots", "c2.round.f6d1b1.ff8a4c.short.3b2a20.none.dots.robe.3a3f4b.none", "c1.round.f6d1b1.ff8a4c.short.3b2a20.dragon.dots", "c1.round.xyz.ff8a4c.short.3b2a20.none.dots", "c1.round", 5, null]) {
      expect(parseCharacter(bad), String(bad)).toBeNull();
    }
  });

  it("read a code of the first version, and fill in what it did not have", () => {
    expect(parseCharacter("c1.chunky.f6d1b1.00ff88.short.3b2a20.crown.cool")).toEqual({
      ...DEFAULT_CHARACTER,
      body: "chunky",
      outfit: "#00ff88",
      hat: "crown",
      eyes: "cool",
    });
  });

  it("say where they were put on the stage in letters, as an act", () => {
    const act = moveAct(1.5, -0.75);
    expect(act).toMatch(/^[a-z]{8}$/);
    expect(isAct(act)).toBe(true);
    const back = parseMove(act)!;
    expect(back.x).toBeCloseTo(1.5, 2);
    expect(back.z).toBeCloseTo(-0.75, 2);
    expect(parseMove("wave")).toBeNull();
    expect(isAct("gozzzzzz")).toBe(false);
    expect(parseMove(moveAct(100, -100))).toEqual({ x: 6, z: -6 });
  });

  it("give someone without one a character of their own color, the same everywhere", () => {
    const a = defaultCharacterFor("abcd", "#123456");
    expect(a.outfit).toBe("#123456");
    expect(defaultCharacterFor("abcd", "#123456")).toEqual(a);
    expect(parseCharacter(characterCode(defaultCharacterFor("zzzz", "pink")))).not.toBeNull();
  });

  it("know their emotes and the things two can do", () => {
    expect(isAct("wave")).toBe(true);
    expect(isAct("hug")).toBe(true);
    expect(isAct("explode")).toBe(false);
    expect(isInteraction("hug")).toBe(true);
    expect(isInteraction("wave")).toBe(false);
  });
});
