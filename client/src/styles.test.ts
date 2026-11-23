import { describe, expect, it } from "vitest";

/**
 * Every stylesheet of the app, as text. The build puts them all on every page, so a class name means the same
 * everywhere: two features that pick the same name style each other's parts (the workshop's `.composer` once squeezed
 * the chat's field, the home page's `.way-icon` blew up the icons of «Подключение»).
 */
const SHEETS = import.meta.glob<string>("/src/**/*.css", { query: "?raw", import: "default", eager: true });

/** The phone's sheet re-styles whatever the screen is narrow for: it may name any class. */
const PHONE = "/src/theme/phone.css";

/**
 * Classes styled from more than one sheet on purpose: the shared controls of ui.css re-styled where they sit, and parts
 * one feature puts on another's (a screen tile under remote control or a pad).
 */
const SHARED = new Set([
  "card",
  "check",
  "create-ports",
  "field",
  "field-row",
  "form-error",
  "input",
  "modal",
  "person-name",
  "screen-tile",
  "settings-content",
]);

/** The first class of every selector a sheet styles, with the comments out. */
function classesOf(css: string): Set<string> {
  const found = new Set<string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1]!.trim();
    if (selector.startsWith("@") || /^(from|to|\d+%)/.test(selector)) continue;
    for (const part of selector.split(",")) {
      const first = /^\.([A-Za-z_][\w-]*)/.exec(part.trim());
      if (first) found.add(first[1]!);
    }
  }
  return found;
}

describe("stylesheets", () => {
  it("give no class two owners by accident", () => {
    expect(Object.keys(SHEETS).length).toBeGreaterThan(10);
    const owners = new Map<string, string[]>();
    for (const [path, css] of Object.entries(SHEETS)) {
      if (path === PHONE) continue;
      for (const name of classesOf(css)) owners.set(name, [...(owners.get(name) ?? []), path]);
    }
    const clashes = [...owners].filter(([name, paths]) => paths.length > 1 && !SHARED.has(name)).map(([name, paths]) => `.${name}: ${paths.join(", ")}`);
    expect(clashes).toEqual([]);
  });

  it("keep the shared row of buttons that settings and the avatar chooser lay out with", () => {
    // Lost once with the old shell: «Случайный» and «Как по умолчанию» stuck together.
    expect(classesOf(SHEETS["/src/ui/ui.css"]!).has("row")).toBe(true);
  });

  it("finds a clash when there is one", () => {
    expect([...classesOf(".way-icon { width: 44px } .a .b {} .c:hover, .d.e {}")]).toEqual(["way-icon", "a", "c", "d"]);
  });
});
