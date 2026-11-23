import { useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { displayName, type ServerStateView } from "../server/session";
import { onChatMessage } from "./api";
import { notificationText, shouldNotify, Throttle, type NotifyMode } from "./notify";
import { useEvent } from "./useChat";

type Options = {
  mode: NotifyMode;
  showText: boolean;
  /** The server shown and its state: names and channels are known for it alone. */
  state: ServerStateView | null;
  /** The chat open in the window, if any. */
  open: { address: string; channel: string } | null;
};

async function permitted(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

/** Windows notifications for new chat messages, by the settings and what the window shows now. */
export function useChatNotifications(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const throttle = useRef(new Throttle());

  useEvent(onChatMessage, (message) => {
    const { mode, showText, state, open } = latest.current;
    const known = state && state.address === message.address ? state : null;
    const channel = known?.channels.find((c) => c.id === message.channel) ?? null;
    const notify = shouldNotify({
      mode,
      mentionsMe: message.mentions_me,
      // A channel of another server: what it is is not known here; a mention still comes through.
      textChannel: channel?.kind === "text" || message.channel.startsWith("dm."),
      focused: typeof document !== "undefined" && document.hasFocus(),
      open,
      here: { address: message.address, channel: message.channel },
    });
    if (!notify || !isTauri()) return;
    const more = throttle.current.take(`${message.address}/${message.channel}`, Date.now());
    if (more === null) return;
    const names = new Map((known?.members ?? []).map((m) => [m.user_id, displayName(m)]));
    const text = notificationText(message, { names, channel: channel?.name ?? null, showText, more });
    void permitted()
      .then((granted) => granted && sendNotification(text))
      .catch(() => {});
  });
}
