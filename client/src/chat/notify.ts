import type { ChatMessage } from "./api";

// When a new message of the chat earns a Windows notification, and what it says. Decided in the window: only it
// knows the nicknames, the settings, whether it is in front, and which channel is open.

export type NotifyMode = "mentions" | "all" | "off";
export const NOTIFY_MODES: readonly NotifyMode[] = ["mentions", "all", "off"];

/** One notification per channel this often; the ones in between are folded into the next. */
export const THROTTLE_MS = 2000;
const BODY_CHARS = 120;

type Place = { address: string; channel: string };

/**
 * «Все» — any message of a text channel, and a mention anywhere; «Упоминания» — a mention of us; «Выключены» —
 * nothing. Never about the channel that is open in a window in front.
 */
export function shouldNotify(input: {
  mode: NotifyMode;
  mentionsMe: boolean;
  textChannel: boolean;
  focused: boolean;
  open: Place | null;
  here: Place;
}): boolean {
  const { mode, mentionsMe, textChannel, focused, open, here } = input;
  if (mode === "off") return false;
  if (focused && open?.address === here.address && open.channel === here.channel) return false;
  return mode === "all" ? textChannel || mentionsMe : mentionsMe;
}

/** At most one notification per key every [`THROTTLE_MS`]. */
export class Throttle {
  private last = new Map<string, number>();
  private skipped = new Map<string, number>();

  /** How many were folded in since the last one, when this one may show; null when it waits. */
  take(key: string, now: number): number | null {
    const last = this.last.get(key);
    if (last !== undefined && now - last < THROTTLE_MS) {
      this.skipped.set(key, (this.skipped.get(key) ?? 0) + 1);
      return null;
    }
    this.last.set(key, now);
    const more = this.skipped.get(key) ?? 0;
    this.skipped.delete(key);
    return more;
  }
}

function cut(text: string): string {
  const chars = [...text];
  return chars.length <= BODY_CHARS ? text : chars.slice(0, BODY_CHARS - 1).join("") + "…";
}

/** «Аня · #Общий» and the text, with mentions by nickname, or «Новое сообщение» when the text is hidden. */
export function notificationText(
  message: ChatMessage,
  options: { names: Map<string, string>; channel: string | null; showText: boolean; more: number },
): { title: string; body: string } {
  const { names, channel, showText, more } = options;
  const author = names.get(message.author) ?? "Кто-то";
  const title = message.channel.startsWith("dm.") ? `${author} · личное сообщение` : channel ? `${author} · #${channel}` : `${author} · новое сообщение`;
  let body: string;
  if (!showText) body = "Новое сообщение";
  else if (message.poll) body = `📊 ${cut(message.text)}`;
  else if (message.text.trim()) body = cut(message.text.replace(/<@([a-z0-9]+)>/g, (_, id: string) => `@${names.get(id) ?? "кто-то"}`));
  else body = `📎 ${message.files.join(", ")}`;
  return { title, body: more > 0 ? `${body} (и ещё ${more})` : body };
}
