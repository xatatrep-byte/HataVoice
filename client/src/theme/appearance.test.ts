// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyAppearance, DEFAULT_APPEARANCE, parseAppearance, resolveCore } from "./appearance";
import { BUILTIN_THEMES, mixThemes, parseThemeCode, themeCode, tokensOf } from "./themes";

describe("themes", () => {
  it("every built-in theme gives every color the stylesheet reads", () => {
    for (const theme of BUILTIN_THEMES) {
      const tokens = tokensOf(theme);
      expect(Object.values(tokens).every((v) => /^#[0-9a-f]{6}$/.test(v)), theme.id).toBe(true);
      expect(Object.keys(tokens)).toContain("accent-hover");
    }
  });

  it("is «Лобби» by default, and «Как в системе» follows Windows", () => {
    expect(resolveCore(DEFAULT_APPEARANCE, true).accent).toBe("#45e3a2");
    expect(resolveCore({ ...DEFAULT_APPEARANCE, theme: "system" }, false).base).toBe("light");
    expect(resolveCore({ ...DEFAULT_APPEARANCE, theme: "system" }, true).bg).toBe("#0c0e12");
  });

  it("mixes two themes and puts the person's own accent on top", () => {
    const hata = BUILTIN_THEMES[0]!;
    const light = BUILTIN_THEMES.find((t) => t.id === "light")!;
    expect(mixThemes(hata, light, 0)).toMatchObject({ bg: hata.bg, base: "dark" });
    expect(mixThemes(hata, light, 1)).toMatchObject({ bg: light.bg, base: "light" });
    const mixed = resolveCore({ ...DEFAULT_APPEARANCE, mixWith: "light", mixAmount: 30, accent: "#00ff88" }, true);
    expect(mixed.base).toBe("dark");
    expect(mixed.bg).not.toBe(hata.bg);
    expect(mixed.accent).toBe("#00ff88");
  });

  it("passes a theme to a friend as code, and refuses what is not one", () => {
    const own = { base: "dark" as const, bg: "#101010", panel: "#202020", card: "#303030", text: "#fafafa", accent: "#ff0066" };
    expect(parseThemeCode(themeCode(own))).toEqual(own);
    expect(parseThemeCode("hvtheme1:мусор")).toBeNull();
    expect(parseThemeCode("просто текст")).toBeNull();
    expect(parseThemeCode(themeCode({ ...own, bg: "red" }))).toBeNull();
  });

  it("carries the settings of an earlier version over", () => {
    expect(parseAppearance({ theme: "dark", accent: "violet", scale: 110 })).toMatchObject({ theme: "hata", accent: "#8b6cff", scale: 110 });
    expect(parseAppearance({ theme: "light", accent: "blue" })).toMatchObject({ theme: "light", accent: null });
    expect(parseAppearance({ theme: "system" }).theme).toBe("system");
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({ theme: "custom" }).theme, "no own theme stored").toBe("hata");
    expect(parseAppearance({ theme: "nope", mixWith: "nope", mixAmount: 300 })).toMatchObject({ theme: "hata", mixWith: null, mixAmount: 100 });
    expect(parseAppearance({ theme: "sakura" }).theme, "a theme 0.10.0 dropped").toBe("hata");
  });

  it("keeps the settings' sections on top unless asked for the left", () => {
    expect(parseAppearance({}).settingsTabs).toBe("top");
    expect(parseAppearance({ settingsTabs: "left" }).settingsTabs).toBe("left");
    expect(parseAppearance({ settingsTabs: "bottom" }).settingsTabs).toBe("top");
  });
});

describe("applyAppearance", () => {
  it("writes every color, the base, density and scale onto the root element", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: "light", accent: "#8b6cff", compact: true, scale: 110 }, false);
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("--accent")).toBe("#8b6cff");
    expect(root.style.getPropertyValue("--bg")).toBe("#f3f2ee");
    expect(root.dataset.compact).toBe("true");
    expect(root.style.getPropertyValue("--scale")).toBe("110");
  });
});
