import { useCallback, useEffect, useRef, useState } from "react";
import { chatMusic, onChatMusic, type MusicWord } from "../chat/api";
import { useEvent } from "../chat/useChat";
import { notify } from "../ui/toasts";
import { MUSIC_GONE, musicNow, musicSources, type SoundSource } from "./api";
import { coverToJpeg } from "./cover";
import { fitText, MUSIC_MAX_APP, MUSIC_MAX_TEXT, MUSIC_POLL_MS, resendDue, sameTrack } from "./nowPlaying";

/** The music playing in the call now: whose, what, and whether it is ours. */
export type MusicNow = MusicWord & { identity: string; mine: boolean };

export type MusicProps = {
  address: string | null;
  channel: string | null;
  me: string;
  nameOf: (identity: string) => string;
  /** Everyone in the call: a newcomer is told what plays. */
  participants: string[];
  /** Whose music track is in the call now (ours too). */
  players: string[];
  /** Our music track goes (`useVoice`). */
  musicOn: boolean;
  startMusic: (pid: number) => Promise<string | null>;
  stopMusic: () => Promise<void>;
};

export type MusicControls = {
  playing: MusicNow | null;
  mine: boolean;
  /** Plays `source` for the call; one who plays already stops (a take-over). The error to show, or null. */
  start: (source: SoundSource) => Promise<string | null>;
  stop: () => Promise<void>;
  sources: () => Promise<SoundSource[]>;
};

const NOTHING: Omit<MusicWord, "on" | "take"> = { title: null, artist: null, app: null, cover: null };

/** Music played together in voice channel `channel` of `address`: what plays, told and heard through the group. */
export function useMusic(props: MusicProps): MusicControls {
  const { address, channel, me, participants, players, musicOn } = props;
  const latest = useRef(props);
  latest.current = props;
  const [words, setWords] = useState<Record<string, MusicWord>>({});
  const [mineWord, setMineWord] = useState<MusicWord | null>(null);
  const source = useRef<SoundSource | null>(null);
  const lastSent = useRef<{ word: MusicWord | null; at: number }>({ word: null, at: 0 });
  const cover = useRef<{ from: string | null; jpeg: string | null }>({ from: null, jpeg: null });
  const seen = useRef(new Set<string>());
  const joined = useRef(false);

  useEffect(() => {
    setWords({});
    seen.current = new Set();
  }, [address, channel]);

  const send = useCallback((word: MusicWord) => {
    const { address, channel } = latest.current;
    if (!address || !channel) return;
    void chatMusic(address, channel, word).catch(() => {});
  }, []);

  useEvent(onChatMusic, (word) => {
    const { address, channel, me, musicOn, nameOf, stopMusic } = latest.current;
    if (word.address !== address || word.channel !== channel || word.user === me) return;
    if (word.take && musicOn) {
      source.current = null;
      setMineWord(null);
      void stopMusic();
      notify.info(`Музыку теперь включает ${nameOf(word.user)}`);
    }
    setWords((all) => {
      const { [word.user]: _old, ...rest } = all;
      const { on, take, title, artist, app, cover } = word;
      return on ? { ...rest, [word.user]: { on, take, title, artist, app, cover } } : rest;
    });
  });

  // A newcomer to the call: told what plays at the next look.
  useEffect(() => {
    for (const id of participants) {
      if (!seen.current.has(id)) {
        if (seen.current.size > 0) joined.current = true;
        seen.current.add(id);
      }
    }
  }, [participants]);

  // While ours plays: what Windows says plays, told when it changes, now and then, and to newcomers.
  useEffect(() => {
    if (!musicOn) return;
    let busy = false;
    const look = async () => {
      const playing = source.current;
      if (busy || !playing) return;
      busy = true;
      try {
        let gone = false;
        const now = await musicNow(playing.pid).catch((e) => {
          gone = String(e) === MUSIC_GONE;
          return null;
        });
        if (gone && source.current === playing) {
          // The player was closed: its sound has gone, and so has the music for everyone.
          source.current = null;
          setMineWord(null);
          void latest.current.stopMusic();
          send({ on: false, take: false, ...NOTHING });
          notify.info(`${MUSIC_GONE}: музыка для всех остановлена`);
          return;
        }
        let jpeg: string | null = null;
        if (now?.cover) {
          if (cover.current.from !== now.cover) cover.current = { from: now.cover, jpeg: await coverToJpeg(now.cover) };
          jpeg = cover.current.jpeg;
        }
        const word: MusicWord = {
          on: true,
          take: false,
          title: fitText(now?.title, MUSIC_MAX_TEXT),
          artist: fitText(now?.artist, MUSIC_MAX_TEXT),
          app: fitText(playing.name, MUSIC_MAX_APP),
          cover: jpeg,
        };
        if (source.current !== playing) return;
        setMineWord(word);
        const at = Date.now();
        if (!sameTrack(lastSent.current.word, word) || resendDue(lastSent.current.at, at) || joined.current) {
          joined.current = false;
          lastSent.current = { word, at };
          send(word);
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void look(), MUSIC_POLL_MS);
    return () => clearInterval(timer);
  }, [musicOn, send]);

  const start = useCallback(
    async (picked: SoundSource) => {
      const { address, channel, me, players, startMusic } = latest.current;
      if (!address || !channel) return "Сначала зайди в голосовой канал";
      if (players.some((id) => id !== me)) send({ on: false, take: true, ...NOTHING });
      const error = await startMusic(picked.pid);
      if (error) return error;
      source.current = picked;
      lastSent.current = { word: null, at: 0 };
      setMineWord({ on: true, take: false, ...NOTHING, app: fitText(picked.name, MUSIC_MAX_APP) });
      return null;
    },
    [send],
  );

  const stop = useCallback(async () => {
    source.current = null;
    setMineWord(null);
    await latest.current.stopMusic();
    send({ on: false, take: false, ...NOTHING });
  }, [send]);

  let playing: MusicNow | null = null;
  if (musicOn) {
    playing = { identity: me, mine: true, ...(mineWord ?? { on: true, take: false, ...NOTHING }) };
  } else {
    const other = players.find((id) => id !== me);
    if (other) playing = { identity: other, mine: false, ...(words[other] ?? { on: true, take: false, ...NOTHING }) };
  }

  return { playing, mine: musicOn, start, stop, sources: musicSources };
}
