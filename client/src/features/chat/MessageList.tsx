import { useState, type ReactNode } from "react";
import { CornerUpLeft, Pencil, SmilePlus, Trash2 } from "lucide-react";
import type { FileView, ItemView } from "../../chat/api";
import { portraitFor } from "../../characters/members";
import { displayName, type MemberView } from "../../server/session";
import { Avatar, avatarFill } from "../../ui/Avatar";
import { IconButton } from "../../ui/IconButton";
import { MessageFile } from "./MessageFile";
import { MessageText, plainMentions } from "./MessageText";
import { Emoji } from "../../ui/Emoji";

/** The eight reactions a click away. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👀", "✅"];
/** Messages of one author this close in time share one header. */
const GROUP_SECONDS = 5 * 60;

type Props = {
  /** The server, for its files. */
  address: string;
  items: ItemView[];
  members: Map<string, MemberView>;
  me: string;
  /** May delete others' messages (`manage_channels`). */
  canManage: boolean;
  onReply: (item: ItemView) => void;
  onEdit: (item: ItemView) => void;
  onDelete: (item: ItemView) => void;
  onReact: (item: ItemView, emoji: string, on: boolean) => void;
  /** How a poll is shown in place of a text. */
  renderPoll: (item: ItemView) => ReactNode;
  /** A picture opened on the whole window. */
  onOpenFile: (file: FileView) => void;
};

export function nameOf(members: Map<string, MemberView>, userId: string): string {
  const member = members.get(userId);
  return member ? displayName(member) : "Без ника";
}

function time(at: number): string {
  const date = new Date(at * 1000);
  const clock = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === date.toDateString();
  return today ? clock : `${date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${clock}`;
}

/** A new header: another author, a pause of more than five minutes, or a reply (its quote goes on top). */
function startsGroup(item: ItemView, previous: ItemView | undefined): boolean {
  return !previous || previous.author !== item.author || item.at - previous.at > GROUP_SECONDS || item.reply !== null;
}

function Message({ item, head, props }: { item: ItemView; head: boolean; props: Props }) {
  const { members, me, canManage } = props;
  const names = new Map([...members.values()].map((m) => [m.user_id, displayName(m)]));
  const [picking, setPicking] = useState(false);
  const member = members.get(item.author);
  const name = nameOf(members, item.author);
  const mine = item.author === me;
  const react = (emoji: string) => {
    const on = !item.reactions.some((r) => r.emoji === emoji && r.users.includes(me));
    props.onReact(item, emoji, on);
    setPicking(false);
  };
  return (
    <li className={["msg", head ? "first" : "", item.mentions_me ? "mentioned" : ""].filter(Boolean).join(" ")} data-id={item.id}>
      {item.reply && (
        <div className="msg-quote">
          <CornerUpLeft size={13} aria-hidden />
          <span className="msg-quote-author">{nameOf(members, item.reply.author)}</span>
          <span className="msg-quote-text">{item.reply.text ? plainMentions(item.reply.text, names) : "Сообщение удалено"}</span>
        </div>
      )}
      {head && (
        <div className="msg-head">
          <Avatar name={name} color={member?.color ?? "blue"} size={36} frame={member?.frame} picture={portraitFor(member?.character, item.author)} />
          <span className="msg-author" style={{ color: avatarFill(member?.color ?? "blue") }}>
            {name}
          </span>
        </div>
      )}
      {head && (
        <time className="msg-time" dateTime={new Date(item.at * 1000).toISOString()}>
          {time(item.at)}
        </time>
      )}
      <div className="msg-body">
        {item.deleted ? (
          <p className="msg-deleted">Сообщение удалено</p>
        ) : item.poll ? (
          props.renderPoll(item)
        ) : (
          <>
            {(item.text || item.edited) && (
              <MessageText text={item.text} names={names} me={me} after={item.edited && <span className="msg-edited"> (изменено)</span>} />
            )}
            {item.files.length > 0 && (
              <div className="msg-files">
                {item.files.map((file) => (
                  <MessageFile key={file.blob} address={props.address} file={file} onOpen={props.onOpenFile} />
                ))}
              </div>
            )}
          </>
        )}
        {item.reactions.length > 0 && (
          <div className="msg-reactions">
            {item.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={r.users.includes(me) ? "reaction mine" : "reaction"}
                aria-pressed={r.users.includes(me)}
                aria-label={`${r.emoji} ${r.users.length}`}
                title={r.users.map((user) => nameOf(members, user)).join(", ")}
                onClick={() => react(r.emoji)}
              >
                <Emoji kind="char" id={r.emoji} size={18} /> <span className="reaction-count">{r.users.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!item.deleted && (
        <div className="msg-actions">
          <IconButton label="Ответить" onClick={() => props.onReply(item)}>
            <CornerUpLeft size={15} />
          </IconButton>
          <IconButton label="Реакция" active={picking} onClick={() => setPicking((open) => !open)}>
            <SmilePlus size={15} />
          </IconButton>
          {mine && !item.poll && (
            <IconButton label="Изменить" onClick={() => props.onEdit(item)}>
              <Pencil size={15} />
            </IconButton>
          )}
          {(mine || canManage) && (
            <IconButton label="Удалить" tone="danger" onClick={() => props.onDelete(item)}>
              <Trash2 size={15} />
            </IconButton>
          )}
          {picking && (
            <div className="reaction-picker" role="group" aria-label="Реакции">
              {QUICK_REACTIONS.map((emoji) => (
                <button key={emoji} type="button" aria-label={emoji} onClick={() => react(emoji)}>
                  <Emoji kind="char" id={emoji} size={24} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The feed: messages and polls by number, grouped by author. */
export function MessageList(props: Props) {
  return (
    <ol className="msg-list" aria-label="Сообщения">
      {props.items.map((item, index) => (
        <Message key={item.id} item={item} head={startsGroup(item, props.items[index - 1])} props={props} />
      ))}
    </ol>
  );
}
