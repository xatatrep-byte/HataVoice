/**
 * What a site's page lets one choose while watching together (the site's «Плеер 1/2/3», the player's season, episode
 * and dub, as `watch_agent.js` finds them), and keeping everyone's page on the same choice.
 */

export type ChoiceKind = "players" | "season" | "episode" | "dub";
/** In the order they are made: another player shows its own seasons; a season, its own episodes. */
export const CHOICE_KINDS: readonly ChoiceKind[] = ["players", "season", "episode", "dub"];
export type ChoiceGroup = { items: string[]; active: number };
export type Choices = Partial<Record<ChoiceKind, ChoiceGroup>>;
/** What everyone watches: an item's words for each kind. */
export type Picks = Partial<Record<ChoiceKind, string>>;

/** The longest item's words (as the script trims them). */
export const PICK_MAX = 60;
/** The most items of each kind told (as the script trims them). */
const MOST: Record<ChoiceKind, number> = { players: 12, season: 60, episode: 400, dub: 60 };

const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The same choice in two players' words: seasons, episodes and players by their number, dubs by their letters. */
export function sameChoice(kind: ChoiceKind, a: string, b: string): boolean {
  if (kind !== "dub") {
    const x = a.match(/\d+/);
    const y = b.match(/\d+/);
    if (x && y) return Number(x[0]) === Number(y[0]);
  }
  return plain(a) === plain(b);
}

/** The item chosen now on the page, of `kind`. */
export function activeOf(choices: Choices, kind: ChoiceKind): string | undefined {
  const group = choices[kind];
  return group?.items[group.active];
}

/** What the page shows now, as picks. */
export function picksOf(choices: Choices): Picks {
  const picks: Picks = {};
  for (const kind of CHOICE_KINDS) {
    const label = activeOf(choices, kind);
    if (label !== undefined) picks[kind] = label;
  }
  return picks;
}

/**
 * What to choose on this page next so that it shows `picks`: one thing at a time, in order (another player brings
 * other lists); null when it shows them already, or cannot (a list it has not, an item not in it).
 */
export function nextChoice(picks: Picks, choices: Choices): { kind: ChoiceKind; label: string } | null {
  for (const kind of CHOICE_KINDS) {
    const want = picks[kind];
    const group = choices[kind];
    if (want === undefined || !group) continue;
    const now = group.items[group.active];
    if (now !== undefined && sameChoice(kind, now, want)) continue;
    const there = group.items.find((item) => sameChoice(kind, item, want));
    if (there !== undefined) return { kind, label: there };
  }
  return null;
}

/** A new season or episode plays from its beginning; another player or dub keeps the time. */
const restarts = (kind: ChoiceKind) => kind === "season" || kind === "episode";

/**
 * What the viewer chose in the site's own player since the last report, as everyone's choice from now on; null when
 * nothing changed, or the page only came to what everyone has (our own doing).
 */
export function viewerPicks(prev: Choices | null, next: Choices, picks: Picks): { picks: Picks; restart: boolean } | null {
  if (!prev) return null;
  let changed = false;
  let restart = false;
  for (const kind of CHOICE_KINDS) {
    // Only a list that stayed as it was and has another item chosen: other items are the page loading another player
    // or season, which chooses its own first ones.
    const before = prev[kind]?.items;
    const after = next[kind]?.items;
    if (!before || !after || before.length !== after.length || before.some((item, i) => item !== after[i])) continue;
    const was = activeOf(prev, kind);
    const now = activeOf(next, kind);
    if (was === undefined || now === undefined || sameChoice(kind, was, now)) continue;
    const want = picks[kind];
    if (want !== undefined && sameChoice(kind, now, want)) continue;
    changed = true;
    if (restarts(kind)) restart = true;
  }
  return changed ? { picks: picksOf(next), restart } : null;
}

/** A choice made in the call: a new season drops the episode (the player starts it from its first). */
export function picked(picks: Picks, kind: ChoiceKind, label: string): { picks: Picks; restart: boolean } {
  const next: Picks = { ...picks, [kind]: label };
  if (kind === "season") delete next.episode;
  return { picks: next, restart: restarts(kind) };
}

/** Choices as a site's page tells them (the page writes them, so nothing is taken as it is). */
export function readChoices(raw: unknown): Choices {
  const choices: Choices = {};
  if (typeof raw !== "object" || raw === null) return choices;
  for (const kind of CHOICE_KINDS) {
    const group = (raw as Record<string, unknown>)[kind] as { items?: unknown; active?: unknown } | undefined;
    if (!group || !Array.isArray(group.items) || group.items.length === 0) continue;
    const items = group.items.slice(0, MOST[kind]).map((item) => String(item).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, PICK_MAX));
    const active = typeof group.active === "number" && Number.isFinite(group.active) ? Math.max(0, Math.min(items.length - 1, Math.round(group.active))) : 0;
    choices[kind] = { items, active };
  }
  return choices;
}

/** Everyone's picks as they come through the group. */
export function readPicks(raw: unknown): Picks {
  const picks: Picks = {};
  if (typeof raw !== "object" || raw === null) return picks;
  for (const kind of CHOICE_KINDS) {
    const label = (raw as Record<string, unknown>)[kind];
    if (typeof label === "string" && label) picks[kind] = label.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, PICK_MAX);
  }
  return picks;
}
