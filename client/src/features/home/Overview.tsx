import { EyeOff, HeadphoneOff, Lock, LogIn, MicOff, Plus, UserPlus, WifiOff, ChevronRight } from "lucide-react";
import { portraitFor } from "../../characters/members";
import { displayName, hasPermission, type Body, type ChannelView, type MemberView, type ServerStateView } from "../../server/session";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import type { CallSecurity } from "../../voice/callSecurity";
import type { ParticipantView } from "../../voice/participants";
import { NotEncrypted, outsideEncryption } from "../stage/CallLock";
import { NameInput, peopleLabel, Unread, useChannelEdit } from "./rooms";
import "./home.css";
import { THIS_DEVICE } from "../../platform";

type Props = {
  server: { name: string; address: string; tunnel?: string };
  /** Null until the server has answered. */
  state: ServerStateView | null;
  offline: boolean;
  /** The room you are in on this server. */
  activeChannelId: string | null;
  /** Live participants of that room. */
  participants: ParticipantView[];
  /** Our own character as set now: our face in the room we are in. */
  mine?: string | null;
  /** The lock of that call: who is marked «не в шифровании» depends on it being secure. */
  security: CallSecurity;
  onJoin: (id: string) => void;
  /** Unread messages of rooms' chats. */
  unread?: Record<string, number>;
  mentions?: Record<string, number>;
  /** Writes a journal entry (room changes). */
  onPost: (body: Body) => Promise<void>;
  /** Opens the person menu (user id). */
  onPerson?: (userId: string) => void;
  /** «Позвать друга»; absent for those who may not invite. */
  onInvite?: (() => void) | null;
  /** Opens the people of the house in the panel. */
  onPeople?: () => void;
};

function Person({ id, name, member, picture, speaking, level, frame, color, muted, deafened, outside, onPerson }: {
  id: string;
  name: string;
  member: MemberView | undefined;
  picture: string | null;
  speaking?: boolean;
  level?: number;
  frame?: string | null;
  color: string;
  muted?: boolean;
  deafened?: boolean;
  outside?: boolean;
  onPerson?: (id: string) => void;
}) {
  const playing = member?.activity ? `играет в ${member.activity}` : null;
  return (
    <li className="room-person">
      <button type="button" disabled={!onPerson} title={playing ? `${name}, ${playing}` : name} onClick={() => onPerson?.(id)}>
        <span className="room-person-face">
          <Avatar name={name} color={color} size={46} speaking={speaking} level={level} frame={frame} picture={picture} />
          {(muted || deafened) && (
            <span className="room-person-off">{deafened ? <HeadphoneOff size={11} aria-label="Звук выключен" /> : <MicOff size={11} aria-label="Микрофон выключен" />}</span>
          )}
        </span>
        <span className="room-person-name">{name}</span>
        {playing && <span className="room-person-activity">{playing}</span>}
        {outside && <NotEncrypted />}
      </button>
    </li>
  );
}

/** The house before a call: its rooms as cards with the faces of who is inside, and who else is home. */
export function Overview(props: Props) {
  const { server, state, offline, activeChannelId, participants, security, onJoin, onPost } = props;
  const channels = state?.channels ?? [];
  const members = new Map((state?.members ?? []).map((m) => [m.user_id, m]));
  const me = state?.me ?? null;
  const canEdit = !!me && hasPermission(me, "manage_channels");
  const edit = useChannelEdit(channels, canEdit, onPost);
  const rooms = channels.filter((c) => c.kind !== "text");
  const unread = props.unread ?? {};

  const room = (channel: ChannelView, index: number, list: ChannelView[]) => {
    const here = channel.id === activeChannelId;
    // The server's list lags behind: you are shown only where you really are.
    const others = channel.people.filter((id) => id !== me?.user_id);
    const count = here ? participants.length : others.length;
    const locked = !channel.access.connect;
    const hidden = !channel.access.view;
    const busy = count > 0;
    const classes = ["room-card", busy ? "busy" : "", here ? "here" : "", hidden ? "hidden-room" : "", count >= 4 ? "crowd" : ""];
    const changing = edit.changing(channel);
    const countText = channel.user_limit > 0 ? `${count}/${channel.user_limit}` : busy ? peopleLabel(count) : locked ? "Только для своих" : "Свободно";
    return (
      <li key={channel.id} className={classes.filter(Boolean).join(" ")}>
        {changing ?? (
          <>
            <button
              type="button"
              className="room-enter"
              title={hidden ? "Скрыта правами. Ты видишь её, потому что управляешь комнатами" : locked ? "Нет права заходить в эту комнату" : channel.name}
              disabled={locked}
              onClick={() => onJoin(channel.id)}
            >
              <span className="room-top">
                <span className="room-name">
                  {hidden ? <EyeOff size={15} aria-hidden /> : locked ? <Lock size={15} aria-hidden /> : null}
                  {channel.name}
                </span>
                <Unread count={unread[channel.id]} mentions={props.mentions?.[channel.id]} />
              </span>
              <span className="room-count">
                {here && <span className="room-here">ты здесь</span>}
                {countText}
              </span>
              {!busy && !locked && (
                <span className="room-cta">
                  <LogIn size={15} aria-hidden /> Зайти
                </span>
              )}
            </button>
            {edit.tools(channel, index, list)}
            {busy && (
              <ul className="room-people">
                {here
                  ? participants.map((p) => (
                      <Person
                        key={p.identity}
                        id={p.identity}
                        name={p.name}
                        member={members.get(p.identity)}
                        picture={portraitFor(p.isLocal ? props.mine : p.character, p.identity)}
                        color={p.color}
                        frame={p.frame}
                        speaking={p.speaking}
                        level={p.level}
                        muted={p.muted}
                        deafened={p.deafened}
                        outside={outsideEncryption(p, security)}
                        onPerson={p.isLocal ? undefined : props.onPerson}
                      />
                    ))
                  : others.map((id) => {
                      const person = members.get(id);
                      return (
                        <Person
                          key={id}
                          id={id}
                          name={person ? displayName(person) : "Без ника"}
                          member={person}
                          picture={portraitFor(person?.character, id)}
                          color={person?.color ?? "blue"}
                          frame={person?.frame}
                          onPerson={props.onPerson}
                        />
                      );
                    })}
              </ul>
            )}
          </>
        )}
      </li>
    );
  };

  const inRooms = new Set(channels.flatMap((c) => c.people));
  if (activeChannelId) for (const p of participants) inRooms.add(p.identity);
  const around = (state?.members ?? []).filter((m) => !inRooms.has(m.user_id) && m.user_id !== me?.user_id);
  // Those who play something first: they are around, and it is worth knowing what they are at.
  const sorted = [...around].sort((a, b) => Number(!!b.activity) - Number(!!a.activity));
  const onAir = channels.reduce((sum, c) => sum + c.people.length, 0);
  const named = sorted.slice(0, 2);
  const rest = sorted.length - named.length;

  return (
    <div className="overview">
      <div className="lobby">
        <header className="overview-head">
          <div className="overview-title">
            <h1 title={server.name}>{state?.profile.name || server.name}</h1>
            {state?.profile.description && <p className="overview-description">{state.profile.description}</p>}
            <p className="overview-status">
              {offline ? (
                <span className="overview-offline">
                  <WifiOff size={13} aria-hidden /> Нет связи, подключаюсь снова
                </span>
              ) : state ? (
                <>
                  <span className="online-dot" aria-hidden />
                  {onAir > 0 ? `${onAir} в комнатах` : "Комнаты свободны"} · {state.members.length} на сервере
                </>
              ) : (
                "Подключаюсь…"
              )}
            </p>
          </div>
          {props.onInvite && (
            <Button variant="primary" onClick={props.onInvite}>
              <UserPlus size={16} /> Позвать друга
            </Button>
          )}
        </header>

        <section className="overview-section" aria-label="Комнаты">
          <ul className="room-grid">
            {rooms.map((channel, index) => room(channel, index, rooms))}
            {canEdit && (
              <li className="room-card ghost">
                {edit.adding === "voice" ? (
                  <NameInput initial="" kind="voice" onCancel={() => edit.setAdding(null)} onSubmit={edit.create} />
                ) : (
                  <button type="button" className="room-add" aria-label="Добавить комнату" onClick={() => edit.setAdding("voice")}>
                    <Plus size={18} aria-hidden /> Новая комната
                  </button>
                )}
              </li>
            )}
          </ul>
        </section>

        {sorted.length > 0 && (
          <section className="overview-around" aria-label="На сервере">
            <button type="button" className="around-row" disabled={!props.onPeople} onClick={props.onPeople}>
              <span className="around-label">На сервере</span>
              <span className="around-faces" aria-hidden>
                {sorted.slice(0, 5).map((m) => (
                  <Avatar key={m.user_id} name={displayName(m)} color={m.color} size={30} picture={portraitFor(m.character, m.user_id)} />
                ))}
              </span>
              <span className="around-names">
                {named.map((m, i) => (
                  <span key={m.user_id}>
                    {i > 0 && ", "}
                    <span className="around-name">{displayName(m)}</span>
                  </span>
                ))}
                {rest > 0 && <span className="around-rest"> и ещё {rest}</span>}
              </span>
              <ChevronRight size={16} aria-hidden />
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

/** Before there is any server: two ways in. */
export function NoServer({ onConnect, onCreate }: { onConnect: () => void; onCreate?: () => void }) {
  return (
    <div className="overview no-server">
      <div className="no-server-copy">
        <h1>Серверов пока нет</h1>
        <p>Зайди на сервер друга по ссылке или создай свой на {THIS_DEVICE}. Белый IP и открытые порты не нужны.</p>
      </div>
      <div className="no-server-ways">
        <button type="button" className="way primary" onClick={onConnect}>
          <span className="way-icon">
            <UserPlus size={22} aria-hidden />
          </span>
          <span className="way-title">Зайти к другу</span>
          <span className="way-text">Есть ссылка-приглашение</span>
        </button>
        {onCreate && (
          <button type="button" className="way" onClick={onCreate}>
            <span className="way-icon">
              <Plus size={22} aria-hidden />
            </span>
            <span className="way-title">Создать свой</span>
            <span className="way-text">Сервер на {THIS_DEVICE}</span>
          </button>
        )}
      </div>
    </div>
  );
}
