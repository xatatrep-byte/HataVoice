import { describe, expect, it } from "vitest";
import { readAgentWord } from "./browser";

describe("an agent's word from Android's site window", () => {
  it("keeps what the program shows, within reason", () => {
    expect(readAgentWord({ t: "Фильм", v: { playing: true, pos: 1500, dur: 60_000, frame: "https://site.example/player" }, c: { dub: { items: ["LostFilm", "Оригинал"], active: 1 } }, th: true })).toEqual({
      t: "Фильм",
      v: { playing: true, pos: 1500, dur: 60_000, frame: "https://site.example/player" },
      c: { dub: { items: ["LostFilm", "Оригинал"], active: 1 } },
      th: true,
    });
  });

  it("takes nothing a site wrote as it is: long titles, control characters, odd numbers, other shapes", () => {
    const word = readAgentWord({ t: "a\u0000b".padEnd(500, "x"), v: { playing: "yes", pos: -5, dur: 1e30, frame: 42 } });
    expect(word.t).toHaveLength(200);
    expect(word.t.startsWith("ab")).toBe(true);
    expect(word.v).toEqual({ playing: false, pos: 0, dur: 7 * 24 * 3600 * 1000, frame: "" });
    expect(readAgentWord({ t: 7, v: "video", c: "x", th: "yes" })).toEqual({ t: "", v: null, c: {}, th: false });
    expect(readAgentWord(null)).toEqual({ t: "", v: null, c: {}, th: false });
    expect(readAgentWord({ v: { pos: Number.NaN } }).v?.pos).toBe(0);
  });
});
