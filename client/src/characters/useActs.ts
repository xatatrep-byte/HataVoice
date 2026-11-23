import { useCallback, useEffect, useRef, useState } from "react";
import { chatAct, onChatAct } from "../chat/api";
import { useEvent } from "../chat/useChat";
import { isAct } from "./character";
import type { SceneAct } from "./scene";

export type ActControls = {
  /** Acts of the last few seconds, ours too. */
  acts: SceneAct[];
  /** Our character does `act` (to `to`); false when it is too soon after the last one. */
  perform: (act: string, to?: string | null) => boolean;
};

/** One act a second at most: the server lets through only a few signals in a row. */
export const ACT_EVERY_MS = 1100;
const KEEP_MS = 5000;
let nextKey = 1;

/** The characters' acts in voice channel `channel` of `address`: ours go to the others through the server's group. */
export function useActs(address: string | null, channel: string | null, me: string): ActControls {
  const [acts, setActs] = useState<SceneAct[]>([]);
  const lastSent = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => setActs([]), [address, channel]);

  const add = useCallback((user: string, act: string, to: string | null) => {
    const now = performance.now();
    setActs((list) => [...list.filter((a) => now - a.startedAt < KEEP_MS), { key: nextKey++, user, act, to, startedAt: now }]);
  }, []);

  useEvent(onChatAct, (word) => {
    if (word.address !== address || word.channel !== channel || !isAct(word.act)) return;
    add(word.user, word.act, word.to);
  });

  const perform = useCallback(
    (act: string, to: string | null = null) => {
      if (!address || !channel || !isAct(act)) return false;
      const now = performance.now();
      if (now - lastSent.current < ACT_EVERY_MS) return false;
      lastSent.current = now;
      add(me, act, to);
      void chatAct(address, channel, act, to).catch(() => {});
      return true;
    },
    [add, address, channel, me],
  );

  return { acts, perform };
}
