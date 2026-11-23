import { EyeOff, Hash, Lock, Plus, SquarePen, Volume2 } from "lucide-react";
import type { DmView } from "../../chat/api";
import { portraitFor } from "../../characters/members";
import { displayName, hasPermission, type Body, type ChannelView, type ServerStateView } from "../../server/session";
import { Avatar } from "../../ui/Avatar";
import { IconButton } from "../../ui/IconButton";
import { NameInput, Unread, useChannelEdit } from "../home/rooms";

type Props = {
  state: ServerStateView;
  /** The room we are in: its chat comes first. */
  callChannel: ChannelView | null;
  dms: DmView[];
  unread: Record<string, number>;
  mentions: Record<string, number>;
  onOpen: (channel: string) => void;
  /** Writes a journal entry (chats added, renamed, moved, deleted). */
  onPost: (body: Body) => Promise<void>;
  /** «Написать другу»: to the people, to pick whom. */
  onWrite: () => void;
};

/** The panel's «Чаты»: the chat of the room we are in, the house's chats, and direct messages. */
export function ChatList({ state, callChannel, dms, unread, mentions, onOpen, onPost, onWrite }: Props) {
  const channels = state.channels;
  const chats = channels.filter((c) => c.kind === "text");
  const canEdit = hasPermission(state.me, "manage_channels");
  const edit = useChannelEdit(channels, canEdit, onPost);
  const nothing = chats.length === 0 && dms.length === 0 && !callChannel;

  const chat = (channel: ChannelView, index: number) => {
    const hidden = !channel.access.view;
    const news = !!(unread[channel.id] || mentions[channel.id]);
    const changing = edit.changing(channel);
    return (
      <li key={channel.id} className={["drawer-row", news ? "news" : "", hidden ? "hidden-room" : ""].filter(Boolean).join(" ")}>
        {changing ?? (
          <>
            <button
              type="button"
              className="row-open"
              title={hidden ? "Скрыт правами. Ты видишь его, потому что управляешь комнатами" : channel.name}
              disabled={hidden}
              onClick={() => onOpen(channel.id)}
            >
              {hidden ? <EyeOff size={16} aria-hidden /> : channel.closed ? <Lock size={16} aria-label="Закрытый чат" /> : <Hash size={16} aria-hidden />}
              <span className="row-name">{channel.name}</span>
              <Unread count={unread[channel.id]} mentions={mentions[channel.id]} />
            </button>
            {edit.tools(channel, index, chats)}
          </>
        )}
      </li>
    );
  };

  return (
    <div className="chat-list-panel">
      <div className="drawer-scroll">
        {callChannel && (
          <section className="drawer-section" aria-label="Комната, где ты сейчас">
            <h3 className="drawer-label">Комната, где ты сейчас</h3>
            <ul className="drawer-rows">
              <li className="drawer-row call-chat">
                <button type="button" className="row-open" onClick={() => onOpen(callChannel.id)}>
                  <Volume2 size={16} aria-hidden />
                  <span className="row-name">
                    {callChannel.name}
                    <small>чат звонка</small>
                  </span>
                  <Unread count={unread[callChannel.id]} mentions={mentions[callChannel.id]} />
                </button>
              </li>
            </ul>
          </section>
        )}

        {(chats.length > 0 || canEdit) && (
          <section className="drawer-section" aria-label="Чаты сервера">
            <h3 className="drawer-label">
              Чаты сервера
              {canEdit && edit.adding !== "text" && (
                <IconButton label="Новый чат" className="drawer-add" onClick={() => edit.setAdding("text")}>
                  <Plus size={15} />
                </IconButton>
              )}
            </h3>
            <ul className="drawer-rows">
              {chats.map(chat)}
              {edit.adding === "text" && (
                <li className="drawer-row">
                  <NameInput initial="" onCancel={() => edit.setAdding(null)} onSubmit={(name) => edit.create(name, "text")} />
                </li>
              )}
            </ul>
          </section>
        )}

        {dms.length > 0 && (
          <section className="drawer-section" aria-label="Личные">
            <h3 className="drawer-label">Личные</h3>
            <ul className="drawer-rows">
              {dms.map((dm) => {
                const peer = state.members.find((m) => m.user_id === dm.peer);
                const name = peer ? displayName(peer) : "Бывший участник";
                const news = !!(unread[dm.channel] || mentions[dm.channel]);
                return (
                  <li key={dm.channel} className={news ? "drawer-row dm news" : "drawer-row dm"}>
                    <button type="button" className="row-open" title={`Личные сообщения: ${name}`} onClick={() => onOpen(dm.channel)}>
                      <Avatar name={name} color={peer?.color ?? "blue"} size={32} frame={peer?.frame} picture={portraitFor(peer?.character, dm.peer)} />
                      <span className="row-name">{name}</span>
                      <Unread count={unread[dm.channel]} mentions={mentions[dm.channel]} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {nothing && <p className="drawer-empty">Чатов пока нет</p>}
      </div>
      <div className="drawer-foot">
        <button type="button" className="btn drawer-write" onClick={onWrite}>
          <SquarePen size={16} aria-hidden /> Написать другу
        </button>
      </div>
    </div>
  );
}
