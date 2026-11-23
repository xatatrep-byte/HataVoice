import { describe, expect, it } from "vitest";
import { bindingLabel } from "./keyLabels";

describe("bindingLabel", () => {
  it("names common keys and mouse buttons", () => {
    expect(bindingLabel(["key:86"])).toBe("V");
    expect(bindingLabel(["key:49"])).toBe("1");
    expect(bindingLabel(["key:113"])).toBe("F2");
    expect(bindingLabel(["key:32"])).toBe("Пробел");
    expect(bindingLabel(["key:20"])).toBe("Caps Lock");
    expect(bindingLabel(["mouse:x1"])).toBe("Мышь 4");
    expect(bindingLabel(["mouse:x2"])).toBe("Мышь 5");
    expect(bindingLabel(["mouse:middle"])).toBe("Колесо мыши");
  });

  it("joins combos with +", () => {
    expect(bindingLabel(["key:162", "mouse:x1"])).toBe("Левый Ctrl + Мышь 4");
  });

  it("reads the same codes as a Mac keyboard's keys on a Mac", () => {
    expect(bindingLabel(["key:91"], true)).toBe("Левый ⌘");
    expect(bindingLabel(["key:164", "key:86"], true)).toBe("Левый ⌥ + V");
    expect(bindingLabel(["key:162"], true)).toBe("Левый Control");
    expect(bindingLabel(["key:91"], false)).toBe("Левый Win");
    expect(bindingLabel(["key:162"], false)).toBe("Левый Ctrl");
  });

  it("falls back to the raw code and says when nothing is bound", () => {
    expect(bindingLabel(["key:255"])).toBe("Клавиша 255");
    expect(bindingLabel([])).toBe("Не назначена");
  });
});
