import { useEffect, useRef } from "react";

type Listener = (link: string) => void;

const listeners = new Set<Listener>();

/** An invite the person clicked inside the app (a message in the chat): the same screen as a link opened from outside. */
export function openInvite(link: string): void {
  for (const listener of listeners) listener(link);
}

export function useInviteRequests(onLink: Listener): void {
  const handler = useRef(onLink);
  handler.current = onLink;
  useEffect(() => {
    const listener: Listener = (link) => handler.current(link);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
