import { describe, expect, it } from "vitest";
import { defaultAvatarFor, GALLERY, galleryCode, packCode, parseAvatar } from "./gallery";
import { galleryMotions } from "./iskraMotions";
import { actLength } from "./motion";

const HASH = "a".repeat(52);
const SECRET = "b".repeat(26);

describe("a character's code", () => {
  it("fits what every version accepts in a profile: 96 characters of lowercase letters, digits and dots", () => {
    for (const code of [packCode(HASH, SECRET), ...GALLERY.map((m) => galleryCode(m.id))]) {
      expect(code.length).toBeLessThanOrEqual(96);
      expect(code).toMatch(/^[a-z0-9.]+$/);
    }
  });

  it("names a model of the gallery or a pack", () => {
    expect(parseAvatar("m1.shino")).toEqual({ kind: "gallery", id: "shino" });
    expect(parseAvatar(packCode(HASH, SECRET))).toEqual({ kind: "pack", sha: HASH, key: SECRET });
  });

  it("is nothing else", () => {
    expect(parseAvatar(null)).toBeNull();
    expect(parseAvatar("c2.round.f6d1b1")).toBeNull();
    expect(parseAvatar("m1.../../etc")).toBeNull();
    expect(parseAvatar(`p1.${HASH}`)).toBeNull();
    expect(parseAvatar(`p1.${HASH}.${SECRET}.x`)).toBeNull();
    expect(parseAvatar(`p1.${HASH.toUpperCase()}.${SECRET}`)).toBeNull();
  });

  it("the heroes made for HataVoice are in the gallery, and nobody gets one without choosing it", () => {
    for (const hero of ["iskra", "ren", "mira", "kai"]) {
      expect(GALLERY.find((m) => m.id === hero)?.group).toBe("heroes");
      expect(parseAvatar(galleryCode(hero))).toEqual({ kind: "gallery", id: hero });
      // Defaults stay among the people: adding a hero must not change what anyone already looks like.
      for (const id of ["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "ggggggg", "hhhhhhhh", "user-1", "user-2"]) expect(defaultAvatarFor(id)).not.toBe(galleryCode(hero));
    }
  });

  it("one who chose nothing is the same person on every PC, from the gallery's people", () => {
    const people = new Set(GALLERY.filter((m) => m.group === "people").map((m) => galleryCode(m.id)));
    expect(defaultAvatarFor("abcd")).toBe(defaultAvatarFor("abcd"));
    expect(people.has(defaultAvatarFor("abcd"))).toBe(true);
    const many = new Set(["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "ggggggg", "hhhhhhhh"].map(defaultAvatarFor));
    expect(many.size).toBeGreaterThan(2);
  });

  it("plays Iskra's takes for the full duration of the corresponding shared acts", () => {
    const takes = galleryMotions("iskra");
    expect([...takes.keys()].sort()).toEqual(["call", "dance", "wave"]);
    for (const [id, take] of takes) {
      expect(take.keys[0]!.t).toBe(0);
      expect(take.duration).toBe(actLength(id));
      expect(take.keys[take.keys.length - 1]!.t).toBe(take.duration);
    }
    const personal = new Map([["cliptest", takes.get("wave")!]]);
    expect(galleryMotions("iskra", personal).size).toBe(4);
    expect(galleryMotions("mira", personal)).toEqual(personal);
    expect(personal.size).toBe(1);
  });
});
