import { describe, expect, it } from "vitest";

/** Every stylesheet of the app, as text (the build puts them all on every page: a class name means the same everywhere). */
const SHEETS = import.meta.glob<string>("/src/**/*.css", { query: "?raw", import: "default", eager: true });

describe("chat styles", () => {
  it("are the chat's own: no other sheet styles .composer (the workshop's grid once squeezed the chat's field)", () => {
    expect(Object.keys(SHEETS).length).toBeGreaterThan(5);
    const others = Object.entries(SHEETS)
      .filter(([path, text]) => !path.endsWith("/chat/chat.css") && /\.composer\b/.test(text))
      .map(([path]) => path);
    expect(others).toEqual([]);
  });
});
