import { describe, expect, it } from "vitest";
import type { ParticipantView } from "../voice/participants";
import { DEFAULT_CHARACTER, characterCode } from "./character";
import { sceneMembers } from "./members";

const person = (identity: string, more: Partial<ParticipantView> = {}): ParticipantView => ({
  identity,
  name: identity,
  speaking: false,
  muted: false,
  isLocal: false,
  quality: "good",
  level: 0,
  deafened: false,
  color: "blue",
  encrypted: true,
  ...more,
});

describe("scene members", () => {
  it("dress each one: us as we just set, the others from their profile, the rest by their color", () => {
    const crown = characterCode({ ...DEFAULT_CHARACTER, hat: "crown" });
    const cat = characterCode({ ...DEFAULT_CHARACTER, hat: "cat" });
    const [me, anna, bob] = sceneMembers(
      [person("me", { isLocal: true, character: cat }), person("anna", { character: crown }), person("bob", { color: "pink", character: "c9.garbage" })],
      characterCode({ ...DEFAULT_CHARACTER, hat: "horns" }),
      (color) => (color === "pink" ? "#f0569b" : "#5b8cff"),
    );
    expect(me!.character.hat).toBe("horns");
    expect(anna!.character.hat).toBe("crown");
    expect(bob!.character.outfit).toBe("#f0569b");
  });

  it("a muted one does not move their mouth", () => {
    const [muted] = sceneMembers([person("a", { muted: true, speaking: true, level: 0.8 })], null, () => "#5b8cff");
    expect(muted).toMatchObject({ level: 0, speaking: false });
  });
});
