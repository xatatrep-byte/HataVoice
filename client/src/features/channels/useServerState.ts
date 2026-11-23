import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectServer,
  isUnreachable,
  onServerEvent,
  routeThroughTunnel,
  serverErrorText,
  serverState,
  type ServerStateView,
} from "../../server/session";
import { useBackupPrompt } from "../../state/backup";
import { useServers } from "../../state/servers";
import { useToasts } from "../../ui/toasts";

export const RETRY_MS = 5000;
const OFFLINE_TEXT = "Нет связи с сервером. Пробую подключиться снова";
/** The Rust side forgot the session (identity imported, say): open it again. */
const NOT_OPEN_TEXT = "Сервер ещё не открыт. Выбери его в списке";

/**
 * Everything about the server at `address`: opened through the Rust side, then reloaded on each
 * of its live events. While it is unreachable the last state stays, `offline` turns on, one
 * notification is shown and it retries every `RETRY_MS`. A refusal (not a member, banned, key
 * changed) stops and lands in `error`.
 */
export function useServerState(address: string | null) {
  const [state, setState] = useState<ServerStateView | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Server clock minus ours, seconds: mute timers and ban ends run on the server's clock.
  const [clockOffset, setClockOffset] = useState(0);
  const current = useRef(address);
  current.current = address;
  const opened = useRef(false);
  const busy = useRef(false);
  const dirty = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offlineToast = useRef<string | null>(null);
  // The server this session has already sent through its tunnel.
  const tunneled = useRef<string | null>(null);

  const loadOnce = useCallback(async (target: string, refresh: () => Promise<void>) => {
    const stale = () => current.current !== target;
    try {
      if (!opened.current) {
        const saved = useServers.getState().servers.find((s) => s.address === target);
        const result = await connectServer(target, saved?.serverKey);
        if (stale()) return;
        opened.current = true;
        if (!saved?.serverKey) useServers.getState().update(target, { serverKey: result.serverKey });
        if (result.backupSuggested) useBackupPrompt.getState().show();
      }
      const view = await serverState(target);
      if (stale()) return;
      setState(view);
      setClockOffset(view.server_time - Date.now() / 1000);
      setOffline(false);
      setError(null);
      const saved = useServers.getState().servers.find((s) => s.address === target);
      if (saved && view.profile.name && saved.name !== view.profile.name) {
        useServers.getState().update(target, { name: view.profile.name });
      }
      if (saved && view.tunnel && saved.tunnel !== view.tunnel) {
        useServers.getState().update(target, { tunnel: view.tunnel });
      }
      if (offlineToast.current) {
        useToasts.getState().dismiss(offlineToast.current);
        offlineToast.current = null;
      }
    } catch (e) {
      if (stale()) return;
      if (serverErrorText(e) === NOT_OPEN_TEXT && opened.current) {
        opened.current = false;
        dirty.current = true;
      } else if (isUnreachable(e)) {
        // Its own address does not answer. If it has a tunnel, that one is tried at once, unnoticed.
        const saved = useServers.getState().servers.find((s) => s.address === target);
        if (saved?.tunnel && tunneled.current !== target && (await routeThroughTunnel(target, saved.tunnel).catch(() => false))) {
          tunneled.current = target;
          dirty.current = true;
          return;
        }
        setOffline(true);
        offlineToast.current ??= useToasts.getState().push({ kind: "error", text: OFFLINE_TEXT });
        if (retry.current) clearTimeout(retry.current);
        retry.current = setTimeout(() => void refresh(), RETRY_MS);
      } else {
        // Not a member any more (kicked, banned, left): nothing of the old state stays on screen.
        setState(null);
        setOffline(false);
        setError(serverErrorText(e));
      }
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!address) return;
    // Events can come in bursts: one load at a time, and one more if any came meanwhile.
    if (busy.current) {
      dirty.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        dirty.current = false;
        await loadOnce(address, refresh);
      } while (dirty.current && current.current === address);
    } finally {
      busy.current = false;
    }
  }, [address, loadOnce]);

  useEffect(() => {
    setState(null);
    setOffline(false);
    setError(null);
    opened.current = false;
    offlineToast.current = null;
    if (!address) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onServerEvent((from) => {
      if (from === address) void refresh();
    })
      .then((stop) => (disposed ? stop() : (unlisten = stop)))
      .catch(() => {});
    void refresh();
    return () => {
      disposed = true;
      unlisten?.();
      if (retry.current) clearTimeout(retry.current);
      retry.current = null;
    };
  }, [address, refresh]);

  return { state, offline, error, clockOffset, refresh };
}
