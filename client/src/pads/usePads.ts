import { useCallback, useEffect, useRef, useState } from "react";
import { useEvent } from "../chat/useChat";
import { fromB64 } from "../remote/api";
import { notify } from "../ui/toasts";
import { useAsksExpiry, useWaitingExpiry } from "../remote/askExpiry";
import { onPads, padAnswer, padAsk, padKick, padRelease, padSeal, padState, padStopAll, type PlayView } from "./api";
import { firstPad, fromGamepad, fromKeys, isPadKey, NEUTRAL, padName, samePad, type PadState } from "./state";

/** An ask to play on our PC; `at` is when it came (see `ASK_TTL_MS`). */
export type PadAsk = { address: string; channel: string; user: string; at: number };

export type PadControls = {
  /** Who asks to play on our PC now. */
  asks: PadAsk[];
  /** The host we asked, waiting for their answer. */
  waiting: string | null;
  /** We play on someone's PC. */
  playing: PlayView | null;
  /** Friends who play on ours. */
  guests: PlayView[];
  /** Someone asked to play, and this PC has no driver for pads: the card about it. */
  noDriver: string | null;
  /** The pad we play with; null: the keyboard. */
  device: string | null;
  ask: (host: string) => void;
  answer: (guest: string, allow: boolean) => void;
  kick: (guest: string) => void;
  stopAll: () => void;
  release: () => void;
  /** A key of the keyboard pad went down or up (while the host's picture has the focus): whether it was the pad's. */
  key: (code: string, down: boolean) => boolean;
  /** The host's picture lost the focus: every key of the keyboard pad is up. */
  keysUp: () => void;
  /** The pad on a phone's screen as it is held now; null when it is gone. */
  touch: (state: PadState | null) => void;
  dismissNoDriver: () => void;
};

/** A changed pad goes out at most this often… */
export const SEND_MS = 8;
/** …and an unchanged one this often, so the host knows we are still here. */
export const KEEPALIVE_MS = 100;

type Props = {
  address: string | null;
  channel: string | null;
  /** We show our screen now. */
  sharing: boolean;
  /** Whose screens we see in the call. */
  sharers: string[];
  nameOf: (user: string) => string;
  sendData: (packet: Uint8Array<ArrayBuffer>, to: string) => Promise<void>;
};

const REFUSED: Record<string, (name: string) => string> = {
  denied: (name) => `${name} не дал геймпад`,
  full: () => "Свободных мест для геймпада нет",
  "no-driver": (name) => `У ${name} не установлен драйвер геймпадов`,
  failed: () => "Не удалось подключить геймпад",
};

/** Playing together in the call in voice channel `channel` of `address`, as the window sees it. */
export function usePads({ address, channel, sharing, sharers, nameOf, sendData }: Props): PadControls {
  const [asks, setAsks] = useState<PadAsk[]>([]);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [askedAt, setAskedAt] = useState(0);
  const [playing, setPlaying] = useState<PlayView | null>(null);
  const [guests, setGuests] = useState<PlayView[]>([]);
  const [noDriver, setNoDriver] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const latest = useRef({ nameOf, sendData });
  latest.current = { nameOf, sendData };
  const held = useRef(new Set<string>());
  /** The pad on a phone's screen, while it is shown. */
  const touchPad = useRef<PadState | null>(null);

  const refresh = useCallback(() => void padState().then((view) => setGuests(view.guests), () => {}), []);

  useEvent(onPads, (event) => {
    const name = (user: string) => latest.current.nameOf(user);
    switch (event.kind) {
      case "asked":
        setAsks((list) => [...list.filter((a) => a.user !== event.user), { address: event.address, channel: event.channel, user: event.user, at: Date.now() }]);
        break;
      case "no-driver":
        setNoDriver(event.user);
        break;
      case "started":
        if (event.host) {
          refresh();
          setAsks((list) => list.filter((a) => a.user !== event.peer));
          notify.info(`${name(event.peer)} играет твоим геймпадом: игрок ${event.player}`);
        } else {
          setWaiting(null);
          setPlaying({ address: event.address, channel: event.channel, peer: event.peer, player: event.player });
          notify.info(`Ты — игрок ${event.player} у ${name(event.peer)}`);
        }
        break;
      case "refused":
        setWaiting(null);
        notify.info((REFUSED[event.why] ?? REFUSED.denied)(name(event.user)));
        break;
      case "ended":
        if (event.host) {
          refresh();
          if (event.why !== "stopped") notify.info(`${name(event.peer)} больше не играет геймпадом`);
        } else {
          setPlaying(null);
          held.current.clear();
          if (event.why === "failed") notify.error("Игра геймпадом прервалась");
          else if (event.why !== "stopped") notify.info(`Игра геймпадом у ${name(event.peer)} закончилась`);
        }
        break;
    }
  });

  // An ask that got no answer while it held ends on both sides: we may ask again, and theirs closes.
  useWaitingExpiry(waiting, askedAt, (host) => {
    setWaiting((now) => (now === host ? null : now));
    notify.info(`Ответа на просьбу о геймпаде нет (${latest.current.nameOf(host)}): можно попросить ещё раз`);
  });
  useAsksExpiry(asks, setAsks, (ask) => notify.info(`Просьба о геймпаде от ${latest.current.nameOf(ask.user)} истекла`));

  const release = useCallback(() => {
    setWaiting(null);
    void padRelease().catch(() => {});
  }, []);
  const stopAll = useCallback(() => void padStopAll().catch(() => {}), []);

  // A call left or switched, the host's screen gone: our play ends. Our own screen no longer shown: theirs.
  const leaving = !!playing && (playing.address !== address || playing.channel !== channel || !sharers.includes(playing.peer));
  useEffect(() => {
    if (leaving) release();
  }, [leaving, release]);
  const hosting = guests.length > 0;
  const closing = hosting && (!sharing || guests.some((g) => g.address !== address || g.channel !== channel));
  useEffect(() => {
    if (closing) stopAll();
  }, [closing, stopAll]);
  useEffect(() => {
    setAsks((list) => list.filter((a) => a.address === address && a.channel === channel));
  }, [address, channel]);

  // While we play: our pad (or the keyboard pad) goes out when it changes, and now and then anyway.
  const active = !!playing;
  useEffect(() => {
    if (!active) return;
    let last: PadState | null = null;
    let lastAt = 0;
    let name: string | null = null;
    const timer = setInterval(() => {
      const pad = firstPad(navigator.getGamepads?.() ?? []);
      const now = pad ? padName(pad) : null;
      if (now !== name) setDevice((name = now));
      // A hidden window gets no pad from the browser: nothing stays pressed meanwhile.
      const state = document.hidden ? NEUTRAL : pad ? (fromGamepad(pad) ?? NEUTRAL) : (touchPad.current ?? fromKeys(held.current));
      const at = performance.now();
      if (last && samePad(state, last) && at - lastAt < KEEPALIVE_MS) return;
      last = state;
      lastAt = at;
      void padSeal(state)
        .then(({ to, packet }) => latest.current.sendData(fromB64(packet), to))
        .catch(() => {});
    }, SEND_MS);
    return () => {
      clearInterval(timer);
      held.current.clear();
    };
  }, [active]);

  return {
    asks,
    waiting,
    playing,
    guests,
    noDriver,
    device,
    ask: (host) => {
      if (!address || !channel) return;
      setWaiting(host);
      setAskedAt(Date.now());
      void padAsk(address, channel, host).catch((e) => {
        setWaiting(null);
        notify.error(String(e));
      });
    },
    answer: (guest, allow) => {
      setAsks((list) => list.filter((a) => a.user !== guest));
      if (!address) return;
      void padAnswer(address, guest, allow).catch((e) => notify.error(String(e)));
    },
    kick: (guest) => {
      if (address) void padKick(address, guest).catch(() => {});
    },
    stopAll,
    release,
    key: (code, down) => {
      if (!active || !isPadKey(code)) return false;
      if (down) held.current.add(code);
      else held.current.delete(code);
      return true;
    },
    keysUp: () => held.current.clear(),
    touch: (state) => {
      touchPad.current = state;
    },
    dismissNoDriver: () => setNoDriver(null),
  };
}
