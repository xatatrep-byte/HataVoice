import { isRecord, loadJson, saveJson } from "../state/persist";

// What this PC has read of each chat: the number of the last message seen, per server and channel. Counted
// locally, never sent anywhere.

const STORAGE_KEY = "hatavoice.chat.read";

type Marks = Record<string, Record<string, number>>;

function load(): Marks {
  const stored = loadJson(STORAGE_KEY);
  const marks: Marks = {};
  if (!isRecord(stored)) return marks;
  for (const [address, channels] of Object.entries(stored)) {
    if (!isRecord(channels)) continue;
    const kept: Record<string, number> = {};
    for (const [channel, seq] of Object.entries(channels)) {
      if (typeof seq === "number" && Number.isFinite(seq)) kept[channel] = seq;
    }
    marks[address] = kept;
  }
  return marks;
}

const listeners = new Set<() => void>();

/** Hears of every new mark; the returned function stops it. */
export function onReadChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Everything up to `seq` in the channel is read; a mark never moves back. */
export function markRead(address: string, channel: string, seq: number): void {
  const marks = load();
  const channels = (marks[address] ??= {});
  if ((channels[channel] ?? 0) >= seq) return;
  channels[channel] = seq;
  saveJson(STORAGE_KEY, marks);
  for (const listener of listeners) listener();
}

/** Unread mentions of us per channel, from the numbers of the messages that mention us; channels with none are left out. */
export function mentionCounts(address: string, mentions: Record<string, number[]>): Record<string, number> {
  return unreadCounts(address, mentions);
}

/** Unread messages per channel, from the numbers of others' messages (`chatUnreadBase`); channels with none are left out. */
export function unreadCounts(address: string, base: Record<string, number[]>): Record<string, number> {
  const read = load()[address] ?? {};
  const counts: Record<string, number> = {};
  for (const [channel, seqs] of Object.entries(base)) {
    const after = read[channel] ?? 0;
    const unread = seqs.filter((seq) => seq > after).length;
    if (unread > 0) counts[channel] = unread;
  }
  return counts;
}
