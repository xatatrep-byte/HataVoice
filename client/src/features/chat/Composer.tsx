import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { onFilesDropped, pickFiles, type Picked } from "../../files/pick";
import { onFileProgress } from "../../chat/api";
import { sizeLabel } from "./MessageFile";
import { FileText, Paperclip, PencilLine, Scissors, SendHorizontal, X } from "lucide-react";
import { kindOf } from "../../media/edit";
import { fromB64 } from "../../remote/api";
import { PhotoEditor } from "../photo/PhotoEditor";
import { VideoEditor } from "../video/VideoEditor";
import type { Attachment } from "../../chat/api";
import { IconButton } from "../../ui/IconButton";
import { VoiceNoteButton } from "./VoiceNoteButton";

/** A file from disk goes in parts up to this; bytes the window holds (pasted, changed here) go whole, up to 25 MB. */
export const MAX_FILE = 2 * 1024 ** 3;
export const MAX_HELD = 25 * 1024 * 1024;
export const MAX_FILES = 10;
export const TOO_BIG = "Файл больше 2 ГБ";
const TOO_BIG_PASTED = "Вставленный файл больше 25 МБ — прикрепи его скрепкой";
const TOO_MANY = "Не больше 10 файлов в одном сообщении";

/** A file waiting to go with the next message; `preview` — a pasted picture to show in the strip. */
type Pending = { attachment: Attachment; preview: string | null; size: number };
/** A picked video bigger than this is opened in the editor in pieces as it plays, not read whole. */
const READ_WHOLE = 32 * 1024 * 1024;
/** `@` and what follows it, typed just before the caret: `start..end` is what a pick replaces. */
type Query = { text: string; start: number; end: number };
const MAX_PICKS = 8;
const MENTION = /<@([a-z0-9]{1,64})>/g;

type Props = {
  /** Why the field is off (no keys yet, a closed channel); null when one may write. */
  disabledText: string | null;
  placeholder: string;
  /** What the next Enter does, above the field: replying to someone, editing a message. */
  banner: string | null;
  /** The text to edit: the field takes it whenever it changes. */
  editText: string | null;
  /** Sends (or saves the edit) with the files; resolves to null when it went, the reason when it did not. */
  onSubmit: (text: string, files: Attachment[]) => Promise<string | null>;
  /** Esc: the reply or the edit is off. */
  onCancel: () => void;
  /** ↑ in an empty field: edit our last message. */
  onEditLast: () => void;
  onError: (text: string) => void;
  /** We are typing (at every change of the text). */
  onTyping?: () => void;
  /** Nicknames by user id, for `@` and for the mentions of a message being edited; and our own id. */
  names?: Map<string, string>;
  me?: string;
  /** More buttons beside the field (polls). */
  extra?: ReactNode;
};

/** «C:\pics\кот.png» → «кот.png». */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function Composer(props: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  /** An attachment being changed before it goes: which, what it is, and its bytes to show. */
  const [editing, setEditing] = useState<{ index: number; kind: "photo" | "video"; src: string; name: string; size: number } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const onError = useRef(props.onError);
  onError.current = props.onError;
  const [query, setQuery] = useState<Query | null>(null);
  const [active, setActive] = useState(0);
  /** The mentions in the field, as shown («@Аня») and the id each stands for. */
  const mentioned = useRef(new Map<string, string>());
  const names = props.names ?? new Map<string, string>();

  useEffect(() => {
    if (props.editText === null) return;
    // The field shows mentions by nickname; they go back as ids.
    const shown = props.editText.replace(MENTION, (whole, id: string) => {
      const name = names.get(id);
      if (!name) return whole;
      mentioned.current.set(`@${name}`, id);
      return `@${name}`;
    });
    setText(shown);
    field.current?.focus();
  }, [props.editText]);

  const people = query
    ? [...names.entries()]
        .filter(([id, name]) => id !== props.me && name.toLowerCase().startsWith(query.text.toLowerCase()))
        .slice(0, MAX_PICKS)
    : [];
  const picking = people.length > 0;

  /** What the caret has just after `@`, if anything. */
  const look = (value: string, caret: number) => {
    const typed = /(?:^|\s)@([^\s@]{0,32})$/.exec(value.slice(0, caret));
    setQuery(typed ? { text: typed[1]!, start: caret - typed[1]!.length - 1, end: caret } : null);
    setActive(0);
  };

  const pick = ([id, name]: [string, string]) => {
    if (!query) return;
    const shown = `@${name}`;
    mentioned.current.set(shown, id);
    setText((now) => `${now.slice(0, query.start)}${shown} ${now.slice(query.end)}`);
    setQuery(null);
    field.current?.focus();
  };

  /** The text as it goes: each mention picked, as `<@id>`. */
  const outgoing = (value: string) =>
    [...mentioned.current.entries()]
      .sort(([a], [b]) => b.length - a.length)
      .reduce((out, [shown, id]) => out.split(shown).join(`<@${id}>`), value);

  const add = (files: Pending[]) =>
    setPending((now) => {
      const next = [...now, ...files];
      if (next.length > MAX_FILES) onError.current(TOO_MANY);
      return next.slice(0, MAX_FILES);
    });
  const addPicked = (files: Picked[]) => {
    const fitting = files.filter((file) => file.size <= MAX_FILE);
    if (fitting.length < files.length) onError.current(TOO_BIG);
    if (fitting.length > 0) add(fitting.map((file) => ({ attachment: { token: file.token, data: null, name: file.name }, preview: null, size: file.size })));
  };

  // Files dropped on the window: Rust tells which, by token (the page never gets their paths to use).
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    void onFilesDropped(addPicked)
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const choose = async () => {
    const chosen = await pickFiles("any", true, "Прикрепить файлы").catch(() => []);
    if (chosen.length > 0) addPicked(chosen);
  };

  const paste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    const read: Pending[] = [];
    for (const file of files) {
      if (file.size > MAX_HELD) {
        onError.current(TOO_BIG_PASTED);
        continue;
      }
      const data = Array.from(new Uint8Array(await file.arrayBuffer()));
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      read.push({ attachment: { token: null, data, name: file.name || "картинка.png" }, preview, size: file.size });
    }
    if (read.length > 0) add(read);
  };

  /** Opens the photo editor or the video trimmer on attachment `index`, with its bytes (Rust reads a picked one). */
  const edit = async (index: number) => {
    const item = pending[index];
    const kind = item && kindOf(item.attachment.name);
    if (!item || !kind) return;
    try {
      const name = item.attachment.name;
      if (kind === "video" && item.attachment.token && item.size > READ_WHOLE) {
        // A big video plays from the file itself, in pieces (Rust gives them by token).
        const base = (globalThis as { __HV_MEDIA__?: string }).__HV_MEDIA__ ?? "http://hvmedia.localhost";
        setEditing({ index, kind, src: `${base}/picked/${encodeURIComponent(item.attachment.token)}`, name, size: item.size });
        return;
      }
      const bytes = item.attachment.data ? new Uint8Array(item.attachment.data) : fromB64(await invoke<string>("picked_media", { token: item.attachment.token }));
      setEditing({ index, kind, src: URL.createObjectURL(new Blob([bytes])), name, size: bytes.length });
    } catch (e) {
      onError.current(String(e));
    }
  };
  /** The changed file goes instead of the one chosen: Rust keeps it on disk for the send, the page only its token. */
  const edited = async (bytes: Uint8Array, name: string) => {
    const now = editing;
    if (!now) return;
    try {
      const staged = await invoke<Picked>("stage_media", bytes, { headers: { "x-name": encodeURIComponent(name) } });
      if (staged.size > MAX_FILE) throw new Error(TOO_BIG);
      setPending((list) =>
        list.map((p, i) => {
          if (i !== now.index) return p;
          if (p.preview) URL.revokeObjectURL(p.preview);
          const preview = now.kind === "photo" ? URL.createObjectURL(new Blob([new Uint8Array(bytes)])) : null;
          return { attachment: { token: staged.token, data: null, name: staged.name }, preview, size: staged.size };
        }),
      );
    } catch (e) {
      onError.current(e instanceof Error ? e.message : String(e));
    }
    if (now.src.startsWith("blob:")) URL.revokeObjectURL(now.src);
    setEditing(null);
  };
  const stopEditing = () => {
    if (editing?.src.startsWith("blob:")) URL.revokeObjectURL(editing.src);
    setEditing(null);
  };

  const remove = (index: number) =>
    setPending((now) => {
      const gone = now[index];
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return now.filter((_, i) => i !== index);
    });

  // How far the files of the message being sent are (Rust says it for big ones, part by part).
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (!busy || !isTauri()) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void onFileProgress((progress) => {
      if (progress.key.startsWith("up:")) setSending({ done: progress.done, total: progress.total });
    })
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
      setSending(null);
    };
  }, [busy]);

  const submit = async () => {
    if (busy || (!text.trim() && pending.length === 0)) return;
    setBusy(true);
    const error = await props.onSubmit(outgoing(text), pending.map((p) => p.attachment));
    setBusy(false);
    if (error) return props.onError(error);
    for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
    setText("");
    setPending([]);
    mentioned.current.clear();
  };

  const disabled = props.disabledText !== null;
  return (
    <div className="composer">
      {editing?.kind === "photo" && <PhotoEditor src={editing.src} name={editing.name} onDone={edited} onClose={stopEditing} />}
      {editing?.kind === "video" && <VideoEditor src={editing.src} name={editing.name} size={editing.size} onDone={edited} onClose={stopEditing} />}
      {props.banner && (
        <div className="composer-banner">
          <span>{props.banner}</span>
          <IconButton
            label="Отменить"
            onClick={() => {
              props.onCancel();
              setText("");
            }}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}
      {sending && sending.total > MAX_HELD && (
        <div className="composer-progress" role="progressbar" aria-label="Отправка файлов" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((sending.done / sending.total) * 100)}>
          <span className="composer-progress-bar" style={{ width: `${(sending.done / sending.total) * 100}%` }} />
          <span className="composer-progress-text">
            Отправляется: {sizeLabel(sending.done)} из {sizeLabel(sending.total)} · {Math.round((sending.done / sending.total) * 100)}%
          </span>
        </div>
      )}
      {pending.length > 0 && (
        <ul className="composer-files" aria-label="Вложения">
          {pending.map((p, index) => (
            <li key={index} className="composer-file">
              {p.preview ? <img src={p.preview} alt={p.attachment.name} /> : <FileText size={16} aria-hidden />}
              <span className="composer-file-name">{p.attachment.name}</span>
              {kindOf(p.attachment.name) === "photo" && (
                <IconButton label={`Изменить «${p.attachment.name}»`} onClick={() => void edit(index)}>
                  <PencilLine size={12} />
                </IconButton>
              )}
              {kindOf(p.attachment.name) === "video" && (
                <IconButton label={`Монтаж «${p.attachment.name}»`} onClick={() => void edit(index)}>
                  <Scissors size={12} />
                </IconButton>
              )}
              <IconButton label={`Убрать «${p.attachment.name}»`} onClick={() => remove(index)}>
                <X size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {picking && (
        <ul className="mention-picker" role="listbox" aria-label="Упомянуть">
          {people.map((person, index) => (
            <li
              key={person[0]}
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(person);
              }}
            >
              {person[1]}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-row">
        <IconButton label="Прикрепить" disabled={busy} onClick={() => void choose()}>
          <Paperclip size={18} />
        </IconButton>
        {props.extra}
        <textarea
          ref={field}
          className="composer-field"
          rows={1}
          value={disabled ? "" : text}
          disabled={disabled || busy}
          placeholder={props.disabledText ?? props.placeholder}
          aria-label={props.disabledText ?? props.placeholder}
          maxLength={4000}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setText(value);
            look(value, e.currentTarget.selectionStart ?? value.length);
            if (value) props.onTyping?.();
          }}
          onPaste={(e) => void paste(e)}
          onKeyDown={(e) => {
            if (picking && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive((now) => (now + (e.key === "ArrowDown" ? 1 : people.length - 1)) % people.length);
            } else if (picking && (e.key === "Enter" || e.key === "Tab")) {
              e.preventDefault();
              pick(people[active] ?? people[0]!);
            } else if (picking && e.key === "Escape") {
              setQuery(null);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              props.onCancel();
              if (props.banner) setText("");
            } else if (e.key === "ArrowUp" && text === "") {
              e.preventDefault();
              props.onEditLast();
            }
          }}
        />
        <VoiceNoteButton
          disabled={disabled || busy}
          onError={(message) => onError.current(message)}
          onRecorded={(file) => {
            void file.arrayBuffer().then(async (bytes) => {
              const error = await props.onSubmit("", [{ token: null, data: Array.from(new Uint8Array(bytes)), name: file.name }]);
              if (error) onError.current(error);
            });
          }}
        />
        <IconButton label="Отправить" disabled={disabled || busy || (!text.trim() && pending.length === 0)} onClick={() => void submit()}>
          <SendHorizontal size={18} />
        </IconButton>
      </div>
    </div>
  );
}
