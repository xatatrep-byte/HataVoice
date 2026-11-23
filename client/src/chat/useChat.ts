import { useCallback, useEffect, useRef, useState } from "react";
import { serverErrorText } from "../server/session";
import {
  chatDelete,
  chatEdit,
  chatPoll,
  chatPollClose,
  chatReact,
  chatSend,
  chatStatus,
  chatView,
  chatVote,
  onChatChanged,
  onChatStatus,
  type Attachment,
  type ChannelChat,
  type GroupStatus,
} from "./api";

const NO_CHAT = "Чат этого сервера ещё не открыт";

/** Runs a chat command: null when it went, the reason in words when it did not. */
async function attempt(run: () => Promise<void>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return serverErrorText(e);
  }
}

/** Subscribes to a Tauri event for as long as the component lives. */
export function useEvent<T>(subscribe: (handler: (event: T) => void) => Promise<() => void>, handler: (event: T) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    subscribe((event) => latest.current(event))
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [subscribe]);
}

/**
 * The chat of one channel of the server at `address`: the view, read again whenever the Rust side says that
 * channel changed, the state of its keys, and the actions. Each action resolves to null when it went, or the
 * reason it did not, in words.
 */
export function useChat(address: string | null, channel: string | null) {
  const [chat, setChat] = useState<ChannelChat | null>(null);
  const [status, setStatus] = useState<GroupStatus>("joining");
  const target = useRef({ address, channel });
  target.current = { address, channel };

  const read = useCallback(async () => {
    const { address: from, channel: of } = target.current;
    if (!from || !of) return;
    try {
      const view = await chatView(from, of);
      // The window may have moved on while it was read.
      if (target.current.address === from && target.current.channel === of) setChat(view);
    } catch {
      // The chat is not open yet: the next change brings it.
    }
  }, []);

  useEffect(() => {
    setChat(null);
    if (!address || !channel) return;
    void read();
  }, [address, channel, read]);

  useEffect(() => {
    if (!address) return;
    let live = true;
    chatStatus(address)
      .then((current) => live && setStatus(current))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);

  useEvent(onChatChanged, (event) => {
    const { address: current, channel: open } = target.current;
    if (event.address === current && open && event.channels.includes(open)) void read();
  });
  useEvent(onChatStatus, (event) => {
    if (event.address === target.current.address) setStatus(event.status);
  });

  const run = useCallback(
    (action: (address: string, channel: string) => Promise<void>) => {
      if (!address || !channel) return Promise.resolve(NO_CHAT);
      return attempt(() => action(address, channel));
    },
    [address, channel],
  );

  return {
    chat,
    status,
    send: (text: string, reply?: string | null, files: Attachment[] = []) => run((a, c) => chatSend(a, c, text, reply ?? null, files)),
    edit: (id: string, text: string) => run((a) => chatEdit(a, id, text)),
    remove: (id: string) => run((a) => chatDelete(a, id)),
    react: (id: string, emoji: string, on: boolean) => run((a) => chatReact(a, id, emoji, on)),
    poll: (question: string, options: string[], multi: boolean) => run((a, c) => chatPoll(a, c, question, options, multi)),
    vote: (poll: string, choice: number[]) => run((a) => chatVote(a, poll, choice)),
    closePoll: (poll: string) => run((a) => chatPollClose(a, poll)),
  };
}
