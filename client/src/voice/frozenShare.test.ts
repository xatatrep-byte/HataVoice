import { describe, expect, it } from "vitest";
import { FROZEN_AFTER, isFrozen, nextLook, samePicture, THUMB_HEIGHT, THUMB_WIDTH } from "./frozenShare";

const thumb = (value: number) => new Uint8ClampedArray(THUMB_WIDTH * THUMB_HEIGHT * 4).fill(value);

describe("a shared window that froze", () => {
  it("tells the same picture from a changed one, a moving pointer being the same", () => {
    const a = thumb(100);
    const pointer = thumb(100);
    pointer.set([255, 255, 255, 255], 4 * 40);
    expect(samePicture(a, pointer)).toBe(true);
    expect(samePicture(a, thumb(110)), "a game that plays").toBe(false);
    expect(samePicture(a, new Uint8ClampedArray(8)), "another size").toBe(false);
  });

  it("counts as frozen only after a few still looks while a program fills the screen", () => {
    let state = { stuck: 0, last: null as Uint8ClampedArray | null };
    state = nextLook(state, thumb(50), true);
    expect(state.stuck, "the first look has nothing to compare with").toBe(0);
    for (let i = 1; i < FROZEN_AFTER; i++) state = nextLook(state, thumb(50), true);
    expect(isFrozen(state.stuck)).toBe(false);
    state = nextLook(state, null, true);
    expect(isFrozen(state.stuck), "no frame at all is still").toBe(true);
    // The picture moves again: it is over at once.
    expect(nextLook(state, thumb(90), true).stuck).toBe(0);
  });

  it("never blames a still window when nothing fills the screen (a document, a paused video in a window)", () => {
    let state = { stuck: 0, last: null as Uint8ClampedArray | null };
    for (let i = 0; i < 10; i++) state = nextLook(state, thumb(50), false);
    expect(isFrozen(state.stuck)).toBe(false);
  });
});
