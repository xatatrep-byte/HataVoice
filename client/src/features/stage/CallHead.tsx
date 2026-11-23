import { useEffect, useRef, useState } from "react";
import { ChevronDown, House, Lock } from "lucide-react";
import { portraitFor } from "../../characters/members";
import { displayName, type ChannelView, type MemberView } from "../../server/session";
import { Avatar } from "../../ui/Avatar";
import type { CallSecurity } from "../../voice/callSecurity";
import type { ParticipantView } from "../../voice/participants";
import { peopleLabel } from "../home/rooms";
import type { NetJudgement } from "../../voice/netQuality";
import { CallLock } from "./CallLock";
import { NetBars } from "./NetBars";

type Props = {
  /** The room we are in. */
  room: ChannelView | null;
  /** All the house's rooms (not its chats). */
  rooms: ChannelView[];
  participants: ParticipantView[];
  members: MemberView[];
  me: string;
  /** Our own character as set now. */
  mine?: string | null;
  /** How long we are in, «12:40». */
  time: string | null;
  status: "idle" | "connecting" | "connected" | "reconnecting";
  security: CallSecurity;
  onRetryEncryption: () => void;
  onJoin: (id: string) => void;
  /** «Весь сервер»: the house with the call in a small panel. */
  onHouse: () => void;
  /** Our own link: five bars and, when weak, why. */
  myNet?: NetJudgement | null;
};

/** The top of the stage: which room (and the others to go to), how long, and the lock. Nothing else. */
export function CallHead({ room, rooms, participants, members, me, mine, time, status, security, onRetryEncryption, onJoin, onHouse, myNet }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const byId = new Map(members.map((m) => [m.user_id, m]));
  const name = room?.name ?? "";

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="call-head">
      <div className="call-rooms" ref={box}>
        <button type="button" className="call-title" aria-label={`Комната «${name}»: другие комнаты`} aria-haspopup="menu" aria-expanded={open} title="Другие комнаты" onClick={() => setOpen((o) => !o)}>
          <span className="call-title-name">{name}</span>
          <ChevronDown size={16} aria-hidden />
        </button>
        {open && (
          <div className="call-rooms-menu" role="menu" aria-label="Комнаты">
            {rooms.map((r) => {
              const here = r.id === room?.id;
              const faces = here
                ? participants.map((p) => ({ id: p.identity, name: p.name, color: p.color, picture: portraitFor(p.isLocal ? mine : p.character, p.identity) }))
                : r.people
                    .filter((id) => id !== me)
                    .map((id) => {
                      const m = byId.get(id);
                      return { id, name: m ? displayName(m) : "Без ника", color: m?.color ?? "blue", picture: portraitFor(m?.character, id) };
                    });
              return (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  className={here ? "call-room here" : "call-room"}
                  disabled={!r.access.connect}
                  aria-current={here ? "true" : undefined}
                  onClick={() => {
                    setOpen(false);
                    if (!here) onJoin(r.id);
                  }}
                >
                  {!r.access.connect && <Lock size={14} aria-hidden />}
                  <span className="call-room-name">{r.name}</span>
                  <span className="call-room-faces" aria-hidden>
                    {faces.slice(0, 4).map((f) => (
                      <Avatar key={f.id} name={f.name} color={f.color} size={22} picture={f.picture} />
                    ))}
                  </span>
                  <span className="call-room-count">{here ? "ты здесь" : faces.length > 0 ? peopleLabel(faces.length) : "свободно"}</span>
                </button>
              );
            })}
            <div className="menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="call-room"
              onClick={() => {
                setOpen(false);
                onHouse();
              }}
            >
              <House size={15} aria-hidden />
              <span className="call-room-name">Весь сервер</span>
            </button>
          </div>
        )}
      </div>
      {time && <span className="call-time">{time}</span>}
      <CallLock security={security} members={members} onRetry={onRetryEncryption} />
      <NetBars net={myNet} label="Твоя связь" />
      {security.state === "pending" && <span className="call-pill warn">Шифрую…</span>}
      {security.state === "failed" && <span className="call-pill bad">Не зашифровано</span>}
      {status === "connecting" && <span className="call-pill warn">Подключаюсь…</span>}
      {status === "reconnecting" && <span className="call-pill warn">Связь прервалась, подключаюсь снова…</span>}
    </header>
  );
}
