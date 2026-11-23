export type ChannelDef = { id: string; name: string };

/** The server's limits (server/src/channels.rs). */
export const MAX_ROOMS = 50;
export const MAX_ROOM_NAME = 32;

const MAX_ID_LEN = 64;

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** A server-safe id (`[a-z0-9-]`, up to 64 chars) from a channel name, unique among `taken`. */
export function makeChannelId(name: string, taken: string[]): string {
  const latin = [...name.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
  const base =
    latin
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ID_LEN - 4)
      .replace(/-+$/, "") || "channel";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * The rooms of a new server from their names, as typed: blank and repeated names dropped, each cut to what the server
 * takes, the first one with the id every server's first room has.
 */
export function roomsFromNames(names: string[]): ChannelDef[] {
  const rooms: ChannelDef[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = [...raw.trim()].slice(0, MAX_ROOM_NAME).join("");
    if (!name || seen.has(name.toLowerCase()) || rooms.length >= MAX_ROOMS) continue;
    seen.add(name.toLowerCase());
    const id = rooms.length === 0 ? "general" : makeChannelId(name, rooms.map((r) => r.id));
    rooms.push({ id, name });
  }
  return rooms;
}

/** False when the channel you are in is gone from the list (the host deleted it). */
export function channelStillExists(channels: ChannelDef[], id: string | null): boolean {
  return id === null || channels.some((c) => c.id === id);
}

/** The list with channel `id` moved one place up (-1) or down (1); unchanged at the edges. */
export function moveChannel<T extends ChannelDef>(list: T[], id: string, delta: -1 | 1): T[] {
  const from = list.findIndex((c) => c.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const moved = [...list];
  [moved[from], moved[to]] = [moved[to], moved[from]];
  return moved;
}
