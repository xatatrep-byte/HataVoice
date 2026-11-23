import { describe, expect, it } from "vitest";
import pkg from "../../../package.json";
import { CHANGELOG, isNewerRelease, parseChangelog } from "./changelog";

describe("the changelog", () => {
  it("is read as releases with their date and changes", () => {
    const text = "# Что нового\n\n## 0.3.0 — 2026-12-01\n\n- Раз\n- Два\n\n## 0.2.0 — 2026-11-07\n\n- Три\n";
    expect(parseChangelog(text)).toEqual([
      { version: "0.3.0", date: "2026-12-01", changes: ["Раз", "Два"] },
      { version: "0.2.0", date: "2026-11-07", changes: ["Три"] },
    ]);
  });

  it("names the version of this build first, so every release has its notes", () => {
    expect(CHANGELOG[0]?.version).toBe(pkg.version);
    expect(CHANGELOG[0]?.changes.length).toBeGreaterThan(0);
  });

  it("tells a release we have not seen from one we have", () => {
    expect(isNewerRelease("0.2.0", null), "a first start has nothing to announce").toBe(false);
    expect(isNewerRelease("0.2.0", "0.2.0")).toBe(false);
    expect(isNewerRelease("0.10.0", "0.9.3")).toBe(true);
    expect(isNewerRelease("0.9.3", "0.10.0"), "downgrades say nothing").toBe(false);
    expect(isNewerRelease("1.0.0", "0.99.99")).toBe(true);
  });
});
