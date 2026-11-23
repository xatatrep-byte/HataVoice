import { isHex } from "./color";
import { builtinTheme, DEFAULT_THEME, mixThemes, parseCore, tokensOf, type ThemeCore, type ThemeTokens } from "./themes";

/** A built-in theme's id, `system` (Хата or Светлая by Windows), or `custom` (the person's own). */
export type ThemeChoice = string;

export type Appearance = {
  theme: ThemeChoice;
  /** The person's own theme, edited in the settings. */
  custom: ThemeCore | null;
  /** Another theme mixed in, and how much of it (0–100 %). */
  mixWith: ThemeChoice | null;
  mixAmount: number;
  /** An accent of the person's own over the theme's (`#rrggbb`). */
  accent: string | null;
  compact: boolean;
  /** Where the settings window keeps its sections: a row on top, or a column down the left (a wide window only). */
  settingsTabs: "top" | "left";
  /** Interface scale in percent, 90–125. */
  scale: number;
};

export const MIN_SCALE = 90;
export const MAX_SCALE = 125;

export const DEFAULT_APPEARANCE: Appearance = {
  theme: DEFAULT_THEME,
  custom: null,
  mixWith: null,
  mixAmount: 50,
  accent: null,
  compact: false,
  settingsTabs: "top",
  scale: 100,
};

/** The accents an earlier version offered by name. */
const OLD_ACCENTS: Record<string, string> = {
  blue: "#5b8cff",
  violet: "#8b6cff",
  green: "#26b36a",
  orange: "#f57c2b",
  pink: "#f0569b",
  teal: "#19a9a1",
};

/** The theme a choice stands for; `system` follows Windows, anything unknown is the default. */
export function themeCore(choice: ThemeChoice, custom: ThemeCore | null, systemDark: boolean): ThemeCore {
  if (choice === "system") return builtinTheme(systemDark ? DEFAULT_THEME : "light")!;
  if (choice === "custom" && custom) return custom;
  return builtinTheme(choice) ?? builtinTheme(DEFAULT_THEME)!;
}

/** What the window looks like now: the theme, mixed with another if asked, under the person's own accent. */
export function resolveCore(appearance: Appearance, systemDark: boolean): ThemeCore {
  let core = themeCore(appearance.theme, appearance.custom, systemDark);
  if (appearance.mixWith && appearance.mixWith !== appearance.theme && appearance.mixAmount > 0) {
    core = mixThemes(core, themeCore(appearance.mixWith, appearance.custom, systemDark), appearance.mixAmount / 100);
  }
  return appearance.accent ? { ...core, accent: appearance.accent } : core;
}

export function resolveTokens(appearance: Appearance, systemDark: boolean): ThemeTokens & { base: string } {
  const core = resolveCore(appearance, systemDark);
  return { ...tokensOf(core), base: core.base };
}

/** The appearance from whatever was stored, settings of an earlier version included. */
export function parseAppearance(raw: unknown): Appearance {
  const a = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_APPEARANCE;
  const scale = typeof a.scale === "number" && Number.isFinite(a.scale) ? Math.round(a.scale) : d.scale;
  const known = (x: unknown): x is string => typeof x === "string" && (x === "system" || x === "custom" || !!builtinTheme(x));
  // An earlier version: «Тёмная» / «Светлая» / «Как в системе» and an accent by name.
  // The very first dark theme went to «Классика», which 0.10.0 dropped: «Лобби» now.
  const legacy = a.theme === "dark" ? "hata" : a.theme;
  const custom = parseCore(a.custom);
  let theme = known(legacy) ? legacy : d.theme;
  if (theme === "custom" && !custom) theme = d.theme;
  const accent = isHex(a.accent) ? a.accent.toLowerCase() : typeof a.accent === "string" && a.theme === "dark" ? (OLD_ACCENTS[a.accent] ?? null) : null;
  const amount = typeof a.mixAmount === "number" && Number.isFinite(a.mixAmount) ? Math.round(a.mixAmount) : d.mixAmount;
  return {
    theme,
    custom,
    mixWith: known(a.mixWith) ? a.mixWith : null,
    mixAmount: Math.min(100, Math.max(0, amount)),
    accent,
    compact: typeof a.compact === "boolean" ? a.compact : d.compact,
    settingsTabs: a.settingsTabs === "left" ? "left" : "top",
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)),
  };
}

/** Applies the appearance to the whole document: every color as a CSS variable, density and scale. */
export function applyAppearance(appearance: Appearance, systemDark: boolean): void {
  const root = document.documentElement;
  const { base, ...tokens } = resolveTokens(appearance, systemDark);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(`--${name}`, value);
  root.dataset.theme = base;
  root.dataset.compact = String(appearance.compact);
  root.style.setProperty("--scale", String(appearance.scale));
}
