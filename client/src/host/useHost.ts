import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { CAN_HOST } from "../platform";
import type { HostConfig, HostView } from "./types";

/** A server can be hosted from here: the app on a PC or an Android phone. */
export const hostingSupported = isTauri() && CAN_HOST;

const POLL_MS = 2000;

/** The server hosted on this PC: its saved config, process state and live status. */
export function useHost() {
  const [view, setView] = useState<HostView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hostingSupported) return;
    try {
      setView(await invoke<HostView>("host_view"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Runs `action` with the busy flag; true when it went through, its error kept otherwise. */
  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [refresh],
  );

  const start = () => run(() => invoke("host_start"));
  const stop = () => run(() => invoke("host_stop"));
  // A restart is not the owner turning it off: should the start fail, it still comes back with the program.
  const restart = () =>
    run(async () => {
      await invoke("host_stop", { keepOn: true });
      await invoke("host_start");
    });
  /** Saves `config`; a running server restarts with it (settings are read at the start). */
  const apply = (config: HostConfig) => run(() => applyHostConfig(config));

  return { view, busy, error, start, stop, restart, apply };
}

export async function applyHostConfig(config: HostConfig): Promise<void> {
  const wasRunning = (await invoke<HostView>("host_view")).running;
  if (wasRunning) await invoke("host_stop", { keepOn: true });
  await invoke("host_save", { config });
  if (wasRunning) await invoke("host_start");
}

export type HostControls = ReturnType<typeof useHost>;
