import { useEffect, useState } from "react";
import { onChatMessage, onChatTyping } from "../../chat/api";
import { useEvent } from "../../chat/useChat";

/** «печатает…» lasts this long after the last signal. */
export const TYPING_SHOWN_MS = 6000;

/** «Аня печатает…», «Аня и Боря печатают…», «Несколько человек печатают…». */
export function typingText(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} печатает…`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`;
  return "Несколько человек печатают…";
}

/** Who is typing in `channel` of `address` now (user ids), by the signals that came. */
export function useTyping(address: string, channel: string): string[] {
  const [until, setUntil] = useState<Map<string, number>>(new Map());

  useEffect(() => setUntil(new Map()), [address, channel]);
  useEvent(onChatTyping, (event) => {
    if (event.address !== address || event.channel !== channel) return;
    setUntil((now) => new Map(now).set(event.user, Date.now() + TYPING_SHOWN_MS));
  });
  // Their message came: they are done typing it.
  useEvent(onChatMessage, (event) => {
    if (event.address !== address || event.channel !== channel) return;
    setUntil((now) => {
      if (!now.has(event.author)) return now;
      const next = new Map(now);
      next.delete(event.author);
      return next;
    });
  });
  useEffect(() => {
    if (until.size === 0) return;
    const next = Math.min(...until.values());
    const timer = setTimeout(() => setUntil((now) => new Map([...now].filter(([, at]) => at > Date.now()))), Math.max(0, next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [until]);

  return [...until.keys()];
}

export function Typing({ address, channel, names }: { address: string; channel: string; names: Map<string, string> }) {
  const users = useTyping(address, channel);
  return (
    <div className="chat-typing" aria-live="polite">
      {typingText(users.map((user) => names.get(user) ?? "Кто-то"))}
    </div>
  );
}
