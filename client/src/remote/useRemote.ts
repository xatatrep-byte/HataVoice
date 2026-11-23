import { useCallback, useEffect, useRef, useState } from "react";
import { useEvent } from "../chat/useChat";
import { notify } from "../ui/toasts";
import { useAsksExpiry, useWaitingExpiry } from "./askExpiry";
import { fromB64, onRemote, onRemoteNote, remoteAnswer, remoteAsk, remoteSeal, remoteStop, type RemoteInput, type RemoteNote, type RemoteSession } from "./api";

/** An ask to control our screen; `at` is when it came (see `ASK_TTL_MS`). */
export type RemoteAsk = { address: string; channel: string; user: string; at: number };

export type RemoteControls = {
  /** Who asks to control our PC now. */
  asks: RemoteAsk[];
  /** The one we asked, waiting for their answer. */
  waiting: string | null;
  /** Control going on now, either way. */
  session: RemoteSession | null;
  ask: (host: string) => void;
  answer: (viewer: string, allow: boolean, keyboard: boolean, screen: number | null) => void;
  stop: () => void;
  /** One input of ours to the PC we control; lossy for mouse moves. */
  send: (input: RemoteInput, lossy: boolean) => void;
};

/** The one in control says something at least this often, or the host ends it (after 20 s). */
export const PING_MS = 5000;

type Props = {
  address: string | null;
  channel: string | null;
  /** We show our screen now. */
  sharing: boolean;
  /** Whose screens we see in the call. */
  sharers: string[];
  nameOf: (user: string) => string;
  sendData: (packet: Uint8Array<ArrayBuffer>, to: string, reliable: boolean) => Promise<void>;
  /** A note to the other end of control (see `REMOTE_NOTE_TOPIC`). */
  sendNote?: (note: RemoteNote, to: string) => Promise<void>;
  /** On an Android phone: whether its accessibility service is on (the friend's clicks need it); null elsewhere. */
  phoneReady?: boolean | null;
};

/** Remote control in the call in voice channel `channel` of `address`, as the window sees it. */
export function useRemote({ address, channel, sharing, sharers, nameOf, sendData, sendNote, phoneReady = null }: Props): RemoteControls {
  const [asks, setAsks] = useState<RemoteAsk[]>([]);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [askedAt, setAskedAt] = useState(0);
  const [session, setSession] = useState<RemoteSession | null>(null);
  const latest = useRef({ nameOf, sendData });
  latest.current = { nameOf, sendData };

  useEvent(onRemote, (event) => {
    const name = (user: string) => latest.current.nameOf(user);
    switch (event.kind) {
      case "asked":
        setAsks((list) => [...list.filter((a) => a.user !== event.user), { address: event.address, channel: event.channel, user: event.user, at: Date.now() }]);
        break;
      case "started":
        setSession({ address: event.address, channel: event.channel, peer: event.peer, host: event.host, keyboard: event.keyboard });
        setWaiting(null);
        setAsks((list) => list.filter((a) => a.user !== event.peer));
        if (!event.host) notify.info(`Ты управляешь ПК: ${name(event.peer)}`);
        break;
      case "denied":
        setWaiting(null);
        notify.info(`${name(event.user)} не дал управление`);
        break;
      case "ended":
        setSession(null);
        if (event.why !== "stopped") notify.info(event.host ? `${name(event.peer)} больше не управляет твоим ПК` : `Управление ПК (${name(event.peer)}) закончилось`);
        break;
    }
  });

  // A phone we let in tells the PC whether its accessibility service is on, at the start and on every change: without it
  // the clicks reach nothing, and the PC would not know why.
  const hostPeer = session?.host ? session.peer : null;
  useEffect(() => {
    if (!hostPeer || phoneReady === null || !sendNote) return;
    void sendNote({ t: "phone-control", ready: phoneReady }, hostPeer).catch(() => {});
  }, [hostPeer, phoneReady, sendNote]);

  // The PC: what the phone we control says of its service, told once per change.
  const controlledPeer = session && !session.host ? session.peer : null;
  const phoneOff = useRef<boolean | null>(null);
  useEffect(() => {
    phoneOff.current = null;
    if (!controlledPeer) return;
    return onRemoteNote((from, note) => {
      if (from !== controlledPeer || note.t !== "phone-control") return;
      const off = !note.ready;
      if (phoneOff.current === off) return;
      const was = phoneOff.current;
      phoneOff.current = off;
      const who = latest.current.nameOf(from);
      if (off) {
        notify.error(
          `Нажатия не доходят до телефона: у ${who} не включена служба «ХатаВойс — управление с ПК». Пусть нажмёт «Включить управление в Android» на телефоне и включит её там.`,
        );
      } else if (was) {
        notify.info(`На телефоне ${who} управление включено: нажатия доходят`);
      }
    });
  }, [controlledPeer]);

  // An ask that got no answer while it held ends on both sides: we may ask again, and theirs closes.
  useWaitingExpiry(waiting, askedAt, (host) => {
    setWaiting((now) => (now === host ? null : now));
    notify.info(`Ответа на просьбу об управлении нет (${latest.current.nameOf(host)}): можно попросить ещё раз`);
  });
  useAsksExpiry(asks, setAsks, (ask) => notify.info(`Просьба об управлении от ${latest.current.nameOf(ask.user)} истекла`));

  const stop = useCallback(() => {
    setWaiting(null);
    void remoteStop().catch(() => {});
  }, []);

  // A call left or switched, our screen no longer shown, the other's screen gone: control ends.
  const ending = !!session && (session.address !== address || session.channel !== channel || (session.host ? !sharing : !sharers.includes(session.peer)));
  useEffect(() => {
    if (ending) stop();
  }, [ending, stop]);
  useEffect(() => {
    setAsks((list) => list.filter((a) => a.address === address && a.channel === channel));
  }, [address, channel]);

  const send = useCallback((input: RemoteInput, lossy: boolean) => {
    void remoteSeal(input, lossy)
      .then(({ to, packet }) => latest.current.sendData(fromB64(packet), to, !lossy))
      .catch(() => {});
  }, []);

  // While we control, we say we are still here.
  const controlling = !!session && !session.host;
  useEffect(() => {
    if (!controlling) return;
    const timer = setInterval(() => send({ t: "ping" }, false), PING_MS);
    return () => clearInterval(timer);
  }, [controlling, send]);

  return {
    asks,
    waiting,
    session,
    ask: (host) => {
      if (!address || !channel) return;
      setWaiting(host);
      setAskedAt(Date.now());
      void remoteAsk(address, channel, host).catch((e) => {
        setWaiting(null);
        notify.error(String(e));
      });
    },
    answer: (viewer, allow, keyboard, screen) => {
      setAsks((list) => list.filter((a) => a.user !== viewer));
      if (!address) return;
      void remoteAnswer(address, viewer, allow, keyboard, screen).catch((e) => notify.error(String(e)));
    },
    stop,
    send,
  };
}
