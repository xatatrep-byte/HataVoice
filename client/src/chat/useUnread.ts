import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { chatUnreadBase, onChatChanged } from "./api";
import { mentionCounts, onReadChange, unreadCounts } from "./unread";
import { useEvent } from "./useChat";

/** Unread messages and mentions of us in each of the servers at `addresses`, all channels together. */
export function useServersUnread(addresses: string[]): Record<string, { messages: number; mentions: number }> {
  const [bases, setBases] = useState<Record<string, Record<string, { seqs: number[]; mentions: number[] }>>>({});
  const [, setReads] = useState(0);
  const key = addresses.join("|");
  const load = useCallback(async (address: string) => {
    if (!isTauri()) return;
    try {
      const base = (await chatUnreadBase(address)) ?? {};
      setBases((now) => ({ ...now, [address]: base }));
    } catch {
      // Not open yet.
    }
  }, []);
  useEffect(() => {
    for (const address of key ? key.split("|") : []) void load(address);
  }, [key, load]);
  useEvent(onChatChanged, (event) => {
    if (addresses.includes(event.address)) void load(event.address);
  });
  useEffect(() => onReadChange(() => setReads((n) => n + 1)), []);
  const result: Record<string, { messages: number; mentions: number }> = {};
  for (const address of addresses) {
    const base = bases[address] ?? {};
    const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
    const seqs = Object.fromEntries(Object.entries(base).map(([c, u]) => [c, u.seqs]));
    const mentions = Object.fromEntries(Object.entries(base).map(([c, u]) => [c, u.mentions]));
    result[address] = { messages: sum(unreadCounts(address, seqs)), mentions: sum(mentionCounts(address, mentions)) };
  }
  return result;
}

/** Unread messages and mentions of us by channel of the server at `address`: asked again when its chat changes or
 * something is read. */
export function useUnread(address: string | null): { counts: Record<string, number>; mentions: Record<string, number> } {
  const [base, setBase] = useState<{ seqs: Record<string, number[]>; mentions: Record<string, number[]> }>({ seqs: {}, mentions: {} });
  const [, setReads] = useState(0);
  const current = useRef(address);
  current.current = address;

  const load = useCallback(async () => {
    const from = current.current;
    if (!from || !isTauri()) return;
    try {
      const next = Object.entries((await chatUnreadBase(from)) ?? {});
      const seqs = Object.fromEntries(next.map(([channel, unread]) => [channel, unread.seqs]));
      const mentions = Object.fromEntries(next.map(([channel, unread]) => [channel, unread.mentions]));
      if (current.current === from) setBase({ seqs, mentions });
    } catch {
      // The chat is not open yet: its first change brings the numbers.
    }
  }, []);

  useEffect(() => {
    setBase({ seqs: {}, mentions: {} });
    void load();
  }, [address, load]);
  useEvent(onChatChanged, (event) => {
    if (event.address === current.current) void load();
  });
  useEffect(() => onReadChange(() => setReads((n) => n + 1)), []);

  if (!address) return { counts: {}, mentions: {} };
  return { counts: unreadCounts(address, base.seqs), mentions: mentionCounts(address, base.mentions) };
}
