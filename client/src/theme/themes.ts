import { isHex, mix, shade, textOn } from "./color";

/** What a theme is made of: its base (dark or light) and five colors; every other color is drawn from them. */
export type ThemeCore = {
  base: "dark" | "light";
  bg: string;
  panel: string;
  card: string;
  text: string;
  accent: string;
};

export type ThemeDef = ThemeCore & { id: string; name: string };

/** The colors the stylesheet reads, as CSS variables (without the `--`). */
export type ThemeTokens = Record<
  "bg" | "panel" | "panel-2" | "card" | "hover" | "border" | "text" | "text-2" | "muted" | "accent" | "accent-hover" | "on-accent" | "ok" | "warn" | "danger",
  string
>;

/**
 * Ten themes, each tuned by hand: background, panels, cards, text and accent, the text checked against what it lies on.
 * 0.9.x had eight quicker ones; «Закат», «Классика» and «Сакура» are gone, and a choice of one of them falls back to «Лобби»
 * (`known` in appearance.ts). «Светлая» keeps its id as «Бумага», as «Как в системе» asks for it by that id.
 */
export const BUILTIN_THEMES: readonly ThemeDef[] = [
  { id: "hata", name: "Лобби", base: "dark", bg: "#0c0e12", panel: "#13161c", card: "#191d25", text: "#eef1f6", accent: "#45e3a2" },
  { id: "graphite", name: "Графит", base: "dark", bg: "#111214", panel: "#18191c", card: "#212327", text: "#ececee", accent: "#f0f0f2" },
  { id: "midnight", name: "Полночь", base: "dark", bg: "#0b1020", panel: "#111831", card: "#18213f", text: "#e6ebff", accent: "#7aa2ff" },
  { id: "plum", name: "Слива", base: "dark", bg: "#120f17", panel: "#19141f", card: "#231c2c", text: "#f1ecf6", accent: "#c08cff" },
  { id: "mocha", name: "Мокко", base: "dark", bg: "#14110f", panel: "#1b1714", card: "#25201c", text: "#f3ece6", accent: "#e0a86a" },
  { id: "ocean", name: "Океан", base: "dark", bg: "#081417", panel: "#0d1d21", card: "#13282d", text: "#e2f3f4", accent: "#3cc8c8" },
  { id: "coal", name: "Уголь", base: "dark", bg: "#000000", panel: "#0a0a0a", card: "#141414", text: "#f5f5f5", accent: "#ff8a4c" },
  { id: "forest", name: "Лес", base: "dark", bg: "#0d130f", panel: "#121a15", card: "#19241d", text: "#e7efe9", accent: "#7fd38a" },
  { id: "light", name: "Бумага", base: "light", bg: "#f3f2ee", panel: "#faf9f6", card: "#ffffff", text: "#1d1c19", accent: "#2f6f5e" },
  { id: "cloud", name: "Облако", base: "light", bg: "#edf0f5", panel: "#f7f9fc", card: "#ffffff", text: "#151a22", accent: "#3563e9" },
];

export const DEFAULT_THEME = "hata";

export function builtinTheme(id: string): ThemeDef | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

/** Every color of the stylesheet from a theme's five: hover, borders, quieter text, the accent's states. */
export function tokensOf(core: ThemeCore): ThemeTokens {
  const dark = core.base === "dark";
  return {
    bg: core.bg,
    panel: core.panel,
    "panel-2": shade(core.bg, dark ? -0.025 : -0.035),
    card: core.card,
    hover: mix(core.card, core.text, dark ? 0.07 : 0.06),
    border: mix(core.panel, core.text, dark ? 0.12 : 0.14),
    text: core.text,
    "text-2": mix(core.text, core.bg, 0.25),
    muted: mix(core.text, core.bg, 0.48),
    accent: core.accent,
    "accent-hover": shade(core.accent, dark ? 0.06 : -0.06),
    "on-accent": textOn(core.accent),
    ok: dark ? "#45e3a2" : "#12925c",
    warn: dark ? "#f2c14e" : "#a8761a",
    danger: dark ? "#ff5c5c" : "#d63d3d",
  };
}

/** Two themes mixed, `amount` 0 (all `a`) to 1 (all `b`); the base is that of the one there is more of. */
export function mixThemes(a: ThemeCore, b: ThemeCore, amount: number): ThemeCore {
  const t = Math.min(1, Math.max(0, amount));
  return {
    base: t < 0.5 ? a.base : b.base,
    bg: mix(a.bg, b.bg, t),
    panel: mix(a.panel, b.panel, t),
    card: mix(a.card, b.card, t),
    text: mix(a.text, b.text, t),
    accent: mix(a.accent, b.accent, t),
  };
}

const CODE_PREFIX = "hvtheme1:";

/** A theme as text to pass to a friend. */
export function themeCode(core: ThemeCore): string {
  const json = JSON.stringify({ base: core.base, bg: core.bg, panel: core.panel, card: core.card, text: core.text, accent: core.accent });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return CODE_PREFIX + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A theme from a friend's code; null when it is not one. */
export function parseThemeCode(text: string): ThemeCore | null {
  const code = text.trim();
  if (!code.startsWith(CODE_PREFIX)) return null;
  try {
    const b64 = code.slice(CODE_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return parseCore(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** A theme's five colors and base from whatever was stored; null when any is missing or no color. */
export function parseCore(raw: unknown): ThemeCore | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const base = r.base === "light" ? "light" : r.base === "dark" ? "dark" : null;
  const colors = [r.bg, r.panel, r.card, r.text, r.accent];
  if (!base || !colors.every(isHex)) return null;
  return {
    base,
    bg: (r.bg as string).toLowerCase(),
    panel: (r.panel as string).toLowerCase(),
    card: (r.card as string).toLowerCase(),
    text: (r.text as string).toLowerCase(),
    accent: (r.accent as string).toLowerCase(),
  };
}
