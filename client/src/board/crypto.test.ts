import { describe, expect, it } from "vitest";
import { boardKey, openPacket, sealPacket } from "./crypto";

const frameKey = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("the board's packets", () => {
  it("are sealed with a key made from the sender's call key, and open only with it, for that sender", async () => {
    const anna = await boardKey(frameKey(7));
    const packet = { n: 1, ops: [{ t: "clear" as const }] };
    const sealed = await sealPacket(packet, anna, 3, "anna");
    expect(new TextDecoder().decode(sealed)).not.toContain("clear");
    const keyFor = async (index: number) => (index === 3 ? anna : null);
    expect(await openPacket(sealed, "anna", keyFor)).toEqual(packet);
    expect(await openPacket(sealed, "boris", keyFor), "said to be someone else's").toBeNull();
    const other = await boardKey(frameKey(8));
    expect(await openPacket(sealed, "anna", async () => other), "another key").toBeNull();
    const broken = sealed.slice();
    broken[broken.length - 1]! ^= 1;
    expect(await openPacket(broken, "anna", keyFor), "changed on the way").toBeNull();
    expect(await openPacket(new Uint8Array([9, 9, 9]), "anna", keyFor)).toBeNull();
  });

  it("the board's key is not the call key itself", async () => {
    const key = await boardKey(frameKey(7));
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
  });
});
