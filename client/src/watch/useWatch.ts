import { useCallback, useEffect, useRef, useState } from "react";
import { chatWatch, onChatWatch } from "../chat/api";
import { useEvent } from "../chat/useChat";
import { startPosition } from "./links";
import { picked, readPicks, type ChoiceKind, type Picks } from "./picks";
import { expectedPosition, HEARTBEAT_MS, type WatchState } from "./sync";

export type WatchControls = {
  state: WatchState | null;
  /** Who we are: whether we lead is whether the last word was ours. */
  me: string;
  /** The server's clock now, ms. */
  serverNow: () => number;
  start: (url: string) => void;
  play: (pos: number) => void;
  pause: (pos: number) => void;
  seek: (pos: number) => void;
  stop: () => void;
  /** A choice made in the call (a player, a season, an episode, a dub): everyone's page makes it. */
  choose: (kind: ChoiceKind, label: string) => void;
  /** What a viewer chose in the site's own player, for everyone; `restart`: from the beginning (a new episode). */
  adopt: (picks: Picks, restart: boolean) => void;
};

/**
 * What the call in voice channel `channel` of `address` watches together: the last word anyone said about it,
 * through the server's group. While it plays, whoever moved it last says where it is every few seconds.
 */
export function useWatch(address: string | null, channel: string | null, clockOffset: number, me: string): WatchControls {
  const [state, setState] = useState<WatchState | null>(null);
  const serverNow = useCallback(() => Date.now() + clockOffset * 1000, [clockOffset]);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => setState(null), [address, channel]);

  useEvent(onChatWatch, (word) => {
    if (word.address !== address || word.channel !== channel) return;
    setState(word.url ? { url: word.url, playing: word.playing, pos: word.pos, at: word.at, by: word.user, picks: readPicks(word.picks) } : null);
  });

  const say = useCallback(
    (url: string | null, playing: boolean, pos: number, picks: Picks = {}) => {
      if (!address || !channel) return;
      const at = Math.round(serverNow());
      const position = Math.max(0, Math.round(pos));
      setState(url ? { url, playing, pos: position, at, by: me, picks } : null);
      void chatWatch(address, channel, url, playing, position, at, picks as Record<string, string>).catch(() => {});
    },
    [address, channel, me, serverNow],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const now = latest.current;
      if (now && now.playing && now.by === me) say(now.url, true, expectedPosition(now, serverNow()), now.picks);
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [me, say, serverNow]);

  return {
    state,
    me,
    serverNow,
    start: (url) => say(url, true, startPosition(url)),
    play: (pos) => latest.current && say(latest.current.url, true, pos, latest.current.picks),
    pause: (pos) => latest.current && say(latest.current.url, false, pos, latest.current.picks),
    seek: (pos) => latest.current && say(latest.current.url, latest.current.playing, pos, latest.current.picks),
    stop: () => say(null, false, 0),
    choose: (kind, label) => {
      const now = latest.current;
      if (!now) return;
      const next = picked(now.picks, kind, label);
      say(now.url, now.playing, next.restart ? 0 : expectedPosition(now, serverNow()), next.picks);
    },
    adopt: (picks, restart) => {
      const now = latest.current;
      if (!now) return;
      say(now.url, now.playing, restart ? 0 : expectedPosition(now, serverNow()), picks);
    },
  };
}
