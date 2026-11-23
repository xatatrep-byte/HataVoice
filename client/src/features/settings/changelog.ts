import text from "../../../CHANGELOG.md?raw";

export type Release = { version: string; date: string; changes: string[] };

/** `## 0.2.0 — 2026-11-07` starts a release, `- …` lines are its changes; anything else is ignored. */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const head = /^## (\d+\.\d+\.\d+) — (\S+)/.exec(line);
    if (head) releases.push({ version: head[1]!, date: head[2]!, changes: [] });
    else if (line.startsWith("- ")) releases[releases.length - 1]?.changes.push(line.slice(2).trim());
  }
  return releases;
}

export const CHANGELOG = parseChangelog(text);

const parts = (version: string) => version.split(".").map(Number);

/** Whether `current` is a later release than the last one this PC ran. A first start has nothing to announce. */
export function isNewerRelease(current: string, seen: string | null): boolean {
  if (!seen) return false;
  const [a, b] = [parts(current), parts(seen)];
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff > 0;
  }
  return false;
}
