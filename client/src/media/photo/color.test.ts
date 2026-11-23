import { describe, expect, it } from "vitest";
import { hexToRgb, hsvToRgb, parseHex, rgbToHex, rgbToHsv } from "./color";

describe("colours of the photo editor", () => {
  it("goes between hex, RGB and HSV and back", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(rgbToHex([255, 128, 0])).toBe("#ff8000");
    expect(rgbToHsv([255, 0, 0])).toEqual([0, 1, 1]);
    expect(rgbToHsv([0, 0, 0])).toEqual([0, 0, 0]);
    expect(hsvToRgb([120, 1, 1])).toEqual([0, 255, 0]);
    for (const hex of ["#123456", "#abcdef", "#ffffff", "#000000", "#7f3a99"]) {
      expect(rgbToHex(hsvToRgb(rgbToHsv(hexToRgb(hex))))).toBe(hex);
    }
  });

  it("reads what a person types: with or without #, three or six digits", () => {
    expect(parseHex("FF00aa")).toBe("#ff00aa");
    expect(parseHex("#abc")).toBe("#aabbcc");
    expect(parseHex(" #12345 ")).toBeNull();
    expect(parseHex("red")).toBeNull();
  });
});
