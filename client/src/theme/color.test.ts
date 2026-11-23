import { describe, expect, it } from "vitest";
import { contrast, hexToHsv, hsvToHex, isHex, lightness, mix, parseHex, shade, textOn } from "./color";

describe("colors", () => {
  it("reads HEX in its usual shapes and nothing else", () => {
    expect(parseHex("#FF8A4C")).toBe("#ff8a4c");
    expect(parseHex("ff8a4c")).toBe("#ff8a4c");
    expect(parseHex("#f84")).toBe("#ff8844");
    for (const bad of ["", "#ff8a4", "red", "#gggggg", "rgb(1,2,3)"]) expect(parseHex(bad), bad).toBeNull();
    expect(isHex("#a1b2c3")).toBe(true);
    expect(isHex("blue")).toBe(false);
  });

  it("goes to HSV and back without losing the color", () => {
    for (const hex of ["#ff8a4c", "#14121f", "#ffffff", "#000000", "#5b8cff", "#26b36a", "#808080"]) {
      expect(hsvToHex(hexToHsv(hex)), hex).toBe(hex);
    }
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe("#00ff00");
  });

  it("mixes in OKLab: the ends are the colors, the middle is not muddier", () => {
    expect(mix("#ff0000", "#0000ff", 0)).toBe("#ff0000");
    expect(mix("#ff0000", "#0000ff", 1)).toBe("#0000ff");
    const middle = mix("#ffff00", "#0000ff", 0.5);
    expect(lightness(middle)).toBeGreaterThan(Math.min(lightness("#ffff00"), lightness("#0000ff")));
    expect(mix("#123456", "#abcdef", 2), "amount is held to 0–1").toBe("#abcdef");
  });

  it("shades by lightness and picks the readable text on a color", () => {
    expect(lightness(shade("#5b8cff", 0.1))).toBeGreaterThan(lightness("#5b8cff"));
    expect(lightness(shade("#5b8cff", -0.1))).toBeLessThan(lightness("#5b8cff"));
    expect(textOn("#ffd54a")).toBe("#14121f");
    expect(textOn("#3b2a8f")).toBe("#ffffff");
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });
});
