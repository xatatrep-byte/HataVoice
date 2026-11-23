import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// The server chat as the Rust side keeps it: views to show, commands that send, events that say what changed.
// Every byte of it is end-to-end encrypted; the window never sees anything else.

/** The keys of the chat: `waiting` — nobody of the group is online to add us. */
export type GroupStatus = "ready" | "joining" | "waiting" | "failed";

/** The message a reply quotes; `text` is empty when that message was deleted. */
export type ReplyView = { id: string; author: string; text: string };
export type ReactionView = { emoji: string; users: string[] };
export type PollOption = { text: string; voters: string[] };
export type PollView = { question: string; options: PollOption[]; multi: boolean; closed: boolean };
/** A file of a message: `blob` names it for `hvmedia` and «Сохранить»; its key never leaves Rust. A `big` one (over
 * 25 MB, in parts) is only ever saved. */
export type FileView = { blob: string; size: number; name: string; mime: string; big?: boolean };

/** How far a big send (`up:{channel}`, all files of the message) or a save (`down:{blob}`) is, in bytes. */
export type FileProgress = { address: string; key: string; done: number; total: number };

export function onFileProgress(handler: (progress: FileProgress) => void): Promise<() => void> {
  return listen<FileProgress>("chat-file-progress", (event) => handler(event.payload));
}

/** A message or a poll; `author` and every user are user ids. A deleted one keeps its place, empty. */
export type ItemView = {
  id: string;
  seq: number;
  /** Unix seconds, as the server logged it. */
  at: number;
  author: string;
  text: string;
  reply: ReplyView | null;
  edited: boolean;
  deleted: boolean;
  reactions: ReactionView[];
  poll: PollView | null;
  files: FileView[];
  /** Someone else mentions us in it. */
  mentions_me: boolean;
};

/** Others' messages in a channel (the newest 100) and those of them that mention us, by number. */
export type UnreadBase = { seqs: number[]; mentions: number[] };

/**
 * For a newcomer: the history before their entry was `passed` by `from` (its messages are numbered below `before`),
 * is `loading`, `failed` to come, or is `off` (the owner gives newcomers none).
 */
export type HistoryNote = { state: "passed" | "loading" | "failed" | "off"; from: string; before: number };
export type ChannelChat = { channel: string; items: ItemView[]; last_seq: number; history?: HistoryNote };
export type ChatChanged = { address: string; channels: string[] };
/** A new message or poll from someone else (`text` is a poll's question). */
export type ChatMessage = {
  address: string;
  channel: string;
  id: string;
  author: string;
  text: string;
  files: string[];
  mentions_me: boolean;
  poll: boolean;
};
export type ChatTyping = { address: string; channel: string; user: string };
export type ChatStatusEvent = { address: string; status: GroupStatus };

export function chatView(address: string, channel: string): Promise<ChannelChat> {
  return invoke<ChannelChat>("chat_view", { address, channel });
}

export function chatStatus(address: string): Promise<GroupStatus> {
  return invoke<GroupStatus>("chat_status", { address });
}

/** What each channel's unread counts are made of. */
export function chatUnreadBase(address: string): Promise<Record<string, UnreadBase>> {
  return invoke<Record<string, UnreadBase>>("chat_unread_base", { address });
}

/** A file to send: one the person picked or dropped (a token, see files/pick.ts), or the bytes of a pasted picture. */
export type Attachment = { token: string | null; data: number[] | null; name: string };

export function chatSend(address: string, channel: string, text: string, reply: string | null, files: Attachment[] = []): Promise<void> {
  return invoke("chat_send", { address, channel, text, reply, files });
}

/** Writes a file of the chat, opened, where the person chose (`token` from the program's own save dialog). */
export function chatFileSave(address: string, blob: string, token: string): Promise<void> {
  return invoke("chat_file_save", { address, blob, token });
}

/** A file's SHA-256 (of its opened bytes), the fingerprint antivirus sites look files up by. */

/** Where the window takes a file of the chat from: Rust opens it on the way. */
export function chatFileUrl(address: string, blob: string): string {
  // A page in a browser (Linux) has it elsewhere.
  const base = (globalThis as { __HV_MEDIA__?: string }).__HV_MEDIA__ ?? "http://hvmedia.localhost";
  return `${base}/chat/${encodeURIComponent(address)}/${blob}`;
}

export function chatEdit(address: string, id: string, text: string): Promise<void> {
  return invoke("chat_edit", { address, id, text });
}

export function chatDelete(address: string, id: string): Promise<void> {
  return invoke("chat_delete", { address, id });
}

export function chatReact(address: string, id: string, emoji: string, on: boolean): Promise<void> {
  return invoke("chat_react", { address, id, emoji, on });
}

export function chatPoll(address: string, channel: string, question: string, options: string[], multi: boolean): Promise<void> {
  return invoke("chat_poll", { address, channel, question, options, multi });
}

/** An empty `choice` takes the vote back. */
export function chatVote(address: string, poll: string, choice: number[]): Promise<void> {
  return invoke("chat_vote", { address, poll, choice });
}

export function chatPollClose(address: string, poll: string): Promise<void> {
  return invoke("chat_poll_close", { address, poll });
}

/** The owner starts the server's encryption group over. */
export function chatReset(address: string): Promise<void> {
  return invoke("chat_reset", { address });
}

export function onChatChanged(handler: (event: ChatChanged) => void): Promise<() => void> {
  return listen<ChatChanged>("chat-changed", ({ payload }) => handler(payload));
}

export function onChatStatus(handler: (event: ChatStatusEvent) => void): Promise<() => void> {
  return listen<ChatStatusEvent>("chat-status", ({ payload }) => handler(payload));
}

export function onChatMessage(handler: (event: ChatMessage) => void): Promise<() => void> {
  return listen<ChatMessage>("chat-message", ({ payload }) => handler(payload));
}

export function onChatTyping(handler: (event: ChatTyping) => void): Promise<() => void> {
  return listen<ChatTyping>("chat-typing", ({ payload }) => handler(payload));
}

/** What `user` watches with the call in voice channel `channel`: no `url` — they stopped it for everyone. `picks`: the site's player, season, episode and dub everyone watches. */
export type ChatWatch = { address: string; channel: string; user: string; url: string | null; playing: boolean; pos: number; at: number; picks?: Record<string, string> };

export function onChatWatch(handler: (event: ChatWatch) => void): Promise<() => void> {
  return listen<ChatWatch>("chat-watch", ({ payload }) => handler(payload));
}

/** Tells the call what we watch together: the link, playing or not, at `pos` ms as of `at` (the server's clock, ms), and on a site, which player, season, episode and dub. */
export function chatWatch(address: string, channel: string, url: string | null, playing: boolean, pos: number, at: number, picks: Record<string, string> = {}): Promise<void> {
  return invoke("chat_watch", { address, channel, url, playing, pos, at, picks });
}

/** What someone plays for the call (music together), or that they stopped (`on: false`) or take over (`take`). */
export type ChatMusic = {
  address: string;
  channel: string;
  user: string;
  on: boolean;
  take: boolean;
  title: string | null;
  artist: string | null;
  app: string | null;
  cover: string | null;
};

/** The word itself, as sent. */
export type MusicWord = Omit<ChatMusic, "address" | "channel" | "user">;

export function onChatMusic(handler: (event: ChatMusic) => void): Promise<() => void> {
  return listen<ChatMusic>("chat-music", ({ payload }) => handler(payload));
}

/** Tells the call what we play for it, through the server's group (see `music_word.rs` for the limits). */
export function chatMusic(address: string, channel: string, word: MusicWord): Promise<void> {
  return invoke("chat_music", { address, channel, word });
}

/** A room of direct messages: its channel (`dm.<a>.<b>`) and the other one. */
export type DmView = { channel: string; peer: string; last: number };

export function chatDms(address: string): Promise<DmView[]> {
  return invoke("chat_dms", { address });
}

/** Our direct messages with `user`: their room opened (started if new). Its channel. */
export function chatDmOpen(address: string, user: string): Promise<string> {
  return invoke("chat_dm_open", { address, user });
}

/** The rooms of direct messages of a server changed (`address`). */
export function onChatRooms(handler: (address: string) => void): Promise<() => void> {
  return listen<string>("chat-rooms", ({ payload }) => handler(payload));
}

/** A channel of direct messages. */
export const isDm = (channel: string) => channel.startsWith("dm.");

/** `user`'s 3D character in voice channel `channel` did `act`, alone or to `to`. */
export type ChatAct = { address: string; channel: string; user: string; act: string; to: string | null };

export function onChatAct(handler: (event: ChatAct) => void): Promise<() => void> {
  return listen<ChatAct>("chat-act", ({ payload }) => handler(payload));
}

/** Our character does `act` (to `to`, if anyone) for everyone in the call. */
export function chatAct(address: string, channel: string, act: string, to: string | null): Promise<void> {
  return invoke("chat_act", { address, channel, act, to });
}

/** We are typing in `channel` (Rust sends it at most every 3 s). */
export function chatTyping(address: string, channel: string): Promise<void> {
  return invoke("chat_typing", { address, channel });
}
