import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, AtSign, BarChart3, Lock, Search as SearchIcon } from "lucide-react";
import { chatTyping, type Attachment, type FileView, type GroupStatus, type ItemView, type HistoryNote } from "../../chat/api";
import { markRead } from "../../chat/unread";
import { useChat } from "../../chat/useChat";
import { displayName, hasPermission, type ChannelView, type ServerStateView, type MemberView } from "../../server/session";
import { IconButton } from "../../ui/IconButton";
import { notify } from "../../ui/toasts";
import { Composer } from "./Composer";
import { Lightbox } from "./MessageFile";
import { MessageList, nameOf } from "./MessageList";
import { PollCard } from "./PollCard";
import { PollDialog } from "./PollDialog";
import { Search } from "./Search";
import { Typing } from "./Typing";

/** We tell the others we type at most this often. */
const TYPING_EVERY_MS = 3000;
/** How long a message found by search stays lit. */
const FOUND_MS = 2000;
import "./chat.css";

export const INTRO = "Сообщения зашифрованы, сервер их не видит";

/** What a newcomer is told of the history before their entry. */
export function historyText(note: HistoryNote, members: Map<string, MemberView>): string {
  switch (note.state) {
    case "passed":
      return `Сообщения до твоего входа передал(а) ${nameOf(members, note.from)}`;
    case "loading":
      return "Загружаю историю до твоего входа…";
    case "failed":
      return "История до твоего входа не загрузилась";
    case "off":
      return "Владелец не передаёт новичкам историю";
  }
}
/** What the head of a closed channel's chat says. */
export const CLOSED = "Закрытый чат: его ключи только у тех, кто его видит";
/** What the head of direct messages says. */
export const DM = "Личные сообщения: ключи только у вас двоих";
export const STATUS_TEXT: Record<Exclude<GroupStatus, "ready">, string> = {
  joining: "Подключаю шифрование чата…",
  waiting: "Ждём кого-нибудь из участников: он добавит тебя в шифрование",
  failed: "Шифрование чата не подключилось, пробую снова",
};

type Props = {
  address: string;
  channel: ChannelView;
  state: ServerStateView;
  /** The panel beside a call's stage, not the whole window. */
  compact?: boolean;
  /** The way back to the list of chats. */
  onBack?: () => void;
  /** More buttons for the head (the panel's pin and close). */
  actions?: ReactNode;
};

/** The chat of one channel: the feed, read up to its end while it is open, and the field to write in. */
export function ChatView({ address, channel, state, compact, onBack, actions }: Props) {
  const chat = useChat(address, channel.id);
  const dm = channel.id.startsWith("dm.");
  const [replyTo, setReplyTo] = useState<ItemView | null>(null);
  const [editing, setEditing] = useState<ItemView | null>(null);
  const [polling, setPolling] = useState(false);
  const [viewing, setViewing] = useState<FileView | null>(null);
  const [searching, setSearching] = useState(false);
  const typedAt = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const members = new Map(state.members.map((m) => [m.user_id, m]));
  const names = new Map(state.members.map((m) => [m.user_id, displayName(m)]));
  const me = state.me.user_id;
  const items = chat.chat?.items ?? [];
  const lastSeq = chat.chat?.last_seq ?? 0;

  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
  }, [address, channel.id]);
  // Open means read.
  useEffect(() => {
    if (lastSeq > 0) markRead(address, channel.id, lastSeq);
  }, [address, channel.id, lastSeq]);
  // The newest message stays in sight.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [items.length]);

  const head = (
    <header className="chat-head">
      {onBack && (
        <IconButton label="Назад к чатам" onClick={onBack}>
          <ArrowLeft size={18} />
        </IconButton>
      )}
      {dm && <AtSign size={16} aria-hidden />}
      <h2 className="chat-title">{channel.name}</h2>
      {(channel.closed || dm) && (
        <span className="chat-lock" title={dm ? DM : CLOSED}>
          <Lock size={13} aria-label={dm ? DM : CLOSED} />
        </span>
      )}
      <span className="chat-head-actions">
        <IconButton label="Поиск" active={searching} onClick={() => setSearching((open) => !open)}>
          <SearchIcon size={16} />
        </IconButton>
        {actions}
      </span>
    </header>
  );
  const className = compact ? "chat-view compact" : "chat-view";

  const editLast = () => {
    const last = [...items].reverse().find((item) => item.author === me && !item.deleted && !item.poll);
    if (last) {
      setReplyTo(null);
      setEditing(last);
    }
  };
  const submit = async (text: string, files: Attachment[]) => {
    if (editing) {
      // Nothing changed: nothing to send.
      if (text === editing.text) {
        setEditing(null);
        return null;
      }
      const error = await chat.edit(editing.id, text);
      if (!error) setEditing(null);
      return error;
    }
    const error = await chat.send(text, replyTo?.id ?? null, files);
    if (!error) setReplyTo(null);
    return error;
  };
  const shout = (error: string | null) => {
    if (error) notify.error(error);
  };
  const banner = editing ? "Изменение сообщения" : replyTo ? `Ответ: ${nameOf(members, replyTo.author)}` : null;
  const typing = () => {
    const now = Date.now();
    if (now - typedAt.current < TYPING_EVERY_MS) return;
    typedAt.current = now;
    void chatTyping(address, channel.id).catch(() => {});
  };
  const jump = (id: string) => {
    const found = scroller.current?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!found) return;
    found.scrollIntoView({ block: "center" });
    found.classList.add("found");
    setTimeout(() => found.classList.remove("found"), FOUND_MS);
  };

  return (
    <section
      className={className}
      aria-label={`Чат «${channel.name}»`}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setSearching(true);
        }
      }}
    >
      {head}
      {searching && <Search items={items} names={names} onJump={jump} onClose={() => setSearching(false)} />}
      <div className="chat-scroll" ref={scroller}>
        <p className="chat-intro">
          <Lock size={13} aria-hidden /> {INTRO}
        </p>
        {chat.chat?.history && <p className={`chat-history ${chat.chat.history.state}`}>{historyText(chat.chat.history, members)}</p>}
        <MessageList
          address={address}
          items={items}
          members={members}
          me={me}
          canManage={hasPermission(state.me, "manage_channels")}
          onReply={(item) => {
            setEditing(null);
            setReplyTo(item);
          }}
          onEdit={(item) => {
            setReplyTo(null);
            setEditing(item);
          }}
          onDelete={(item) => void chat.remove(item.id).then(shout)}
          onReact={(item, emoji, on) => void chat.react(item.id, emoji, on).then(shout)}
          onOpenFile={setViewing}
          renderPoll={(item) => (
            <PollCard
              item={item}
              me={me}
              members={members}
              onVote={(choice) => void chat.vote(item.id, choice).then(shout)}
              onClose={() => void chat.closePoll(item.id).then(shout)}
            />
          )}
        />
      </div>
      <Typing address={address} channel={channel.id} names={names} />
      <Composer
        disabledText={chat.status === "ready" ? null : STATUS_TEXT[chat.status]}
        placeholder={dm ? `Сообщение для ${channel.name}` : `Написать в «${channel.name}»`}
        banner={banner}
        editText={editing?.text ?? null}
        onSubmit={submit}
        onCancel={() => {
          setReplyTo(null);
          setEditing(null);
        }}
        onEditLast={editLast}
        names={names}
        me={me}
        onTyping={typing}
        onError={(text) => notify.error(text)}
        extra={
          <IconButton label="Голосование" disabled={chat.status !== "ready"} onClick={() => setPolling(true)}>
            <BarChart3 size={18} />
          </IconButton>
        }
      />
      {viewing && <Lightbox address={address} file={viewing} onClose={() => setViewing(null)} />}
      <PollDialog open={polling} onClose={() => setPolling(false)} onCreate={chat.poll} onError={(text) => notify.error(text)} />
    </section>
  );
}
