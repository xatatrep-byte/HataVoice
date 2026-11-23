import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, Pencil, Trash2, X } from "lucide-react";
import type { Body, ChannelKind, ChannelView } from "../../server/session";
import { IconButton } from "../../ui/IconButton";
import { Segmented } from "../../ui/Segmented";
import { notify } from "../../ui/toasts";
import { makeChannelId } from "../channels/templates";

/** What the rooms and chats of a house share: words, the name field, the order of channels and their editing. */

export const MAX_NAME = 32;

const KINDS: { value: ChannelKind; label: string }[] = [
  { value: "voice", label: "Комната" },
  { value: "text", label: "Чат" },
];

/** "3 человека", "1 человек", "5 человек"; nobody is "пусто". */
export function peopleLabel(count: number): string {
  if (count === 0) return "пусто";
  const mod10 = count % 10;
  const mod100 = count % 100;
  const few = mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14);
  return `${count} ${few ? "человека" : "человек"}`;
}

/** How long a call has been going, as «12:40» or «1:02:07». */
export function callTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** The time since `since` (ms), going on by itself; null while there is no `since`. */
export function useSince(since: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : callTime((Math.max(now, since) - since) / 1000);
}

export function NameInput({ initial, kind, onSubmit, onCancel }: {
  initial: string;
  /** Asked for a new room: what kind it is. */
  kind?: ChannelKind;
  onSubmit: (name: string, kind: ChannelKind) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [chosen, setChosen] = useState<ChannelKind>(kind ?? "voice");
  const submit = () => {
    const name = value.trim();
    if (name) onSubmit(name, chosen);
  };
  return (
    <div className="room-edit">
      {kind && <Segmented label="Что это" value={chosen} options={KINDS} onChange={setChosen} />}
      <div className="room-edit-row">
        <input
          className="input"
          autoFocus
          value={value}
          maxLength={MAX_NAME}
          placeholder="Как назвать"
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
        <IconButton label="Сохранить" onClick={submit}>
          <Check size={16} />
        </IconButton>
        <IconButton label="Отмена" onClick={onCancel}>
          <X size={16} />
        </IconButton>
      </div>
    </div>
  );
}

/** The channel as a journal entry, so an edit keeps its kind, limit and role rules. */
export const channelBody = (c: ChannelView, change: Partial<ChannelView>) => {
  const next = { ...c, ...change };
  return { id: next.id, name: next.name, user_limit: next.user_limit, overrides: next.overrides, kind: next.kind };
};

/** The order of all channels with `id` swapped with its neighbour of the same kind (rooms and chats are shown apart). */
export function moveWithin(channels: ChannelView[], id: string, delta: -1 | 1): string[] {
  const ids = channels.map((c) => c.id);
  const kind = channels.find((c) => c.id === id)?.kind;
  const same = channels.filter((c) => c.kind === kind);
  const neighbour = same[same.findIndex((c) => c.id === id) + delta];
  if (!neighbour) return ids;
  const [from, to] = [ids.indexOf(id), ids.indexOf(neighbour.id)];
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}

export function Unread({ count, mentions }: { count: number | undefined; mentions: number | undefined }) {
  if (mentions) {
    return (
      <span className="unread mention" aria-label={`Упоминаний: ${mentions}`}>
        @{mentions > 99 ? "99+" : mentions}
      </span>
    );
  }
  if (!count) return null;
  return (
    <span className="unread" aria-label={`Непрочитанных: ${count}`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Editing the house's channels where they are listed (rooms on the home page, chats in the panel): the tools that
 * show on hover, what a channel turns into while renamed or deleted, and a new one.
 */
export function useChannelEdit(channels: ChannelView[], canEdit: boolean, onPost: (body: Body) => Promise<void>) {
  const [adding, setAdding] = useState<ChannelKind | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const post = async (body: Body) => {
    try {
      await onPost(body);
    } catch (e) {
      notify.error(String(e));
    }
  };
  const order = (ids: string[]) => void post({ type: "channel_order", ids });
  const create = (name: string, kind: ChannelKind) => {
    setAdding(null);
    const id = makeChannelId(name, channels.map((c) => c.id));
    void post({ type: "channel_create", id, name, user_limit: 0, overrides: [], kind });
  };

  const tools = (channel: ChannelView, index: number, list: ChannelView[]): ReactNode =>
    canEdit && (
      <span className="room-tools">
        <IconButton label={`Поднять «${channel.name}»`} disabled={index === 0} onClick={() => order(moveWithin(channels, channel.id, -1))}>
          <ArrowUp size={14} />
        </IconButton>
        <IconButton label={`Опустить «${channel.name}»`} disabled={index === list.length - 1} onClick={() => order(moveWithin(channels, channel.id, 1))}>
          <ArrowDown size={14} />
        </IconButton>
        <IconButton label={`Переименовать «${channel.name}»`} onClick={() => setRenaming(channel.id)}>
          <Pencil size={14} />
        </IconButton>
        <IconButton label={`Удалить «${channel.name}»`} disabled={channels.length <= 1} onClick={() => setConfirmDelete(channel.id)}>
          <Trash2 size={14} />
        </IconButton>
      </span>
    );

  /** What a channel shows instead of itself while being renamed or deleted. */
  const changing = (channel: ChannelView): ReactNode => {
    if (renaming === channel.id) {
      return (
        <NameInput
          initial={channel.name}
          onCancel={() => setRenaming(null)}
          onSubmit={(name) => {
            setRenaming(null);
            void post({ type: "channel_update", ...channelBody(channel, { name }) });
          }}
        />
      );
    }
    if (confirmDelete === channel.id) {
      return (
        <div className="room-confirm">
          <span>Удалить «{channel.name}»?</span>
          <span className="room-confirm-actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirmDelete(null);
                void post({ type: "channel_delete", id: channel.id });
              }}
            >
              Удалить
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>
              Отмена
            </button>
          </span>
        </div>
      );
    }
    return null;
  };

  return { adding, setAdding, create, tools, changing };
}
