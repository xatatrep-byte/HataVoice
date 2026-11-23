import { describe, expect, it } from "vitest";
import { controllable } from "./phoneControl";

describe("who may be asked in to control", () => {
  it("a PC and an Android phone are asked; an iPhone says no at once", () => {
    expect(controllable(false, false)).toBe(true);
    // 0.23.0 refused every phone, Android too: «Андроид не дал управление» on the PC.
    expect(controllable(true, true)).toBe(true);
    expect(controllable(true, false)).toBe(false);
  });
});
