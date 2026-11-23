import { describe, expect, it } from "vitest";
import { shortcut } from "./platform";

describe("platform", () => {
  it("writes shortcuts as the system does", () => {
    expect(shortcut("K", true)).toBe("⌘K");
    expect(shortcut(",", true)).toBe("⌘,");
    expect(shortcut("K", false)).toBe("Ctrl+K");
  });
});
