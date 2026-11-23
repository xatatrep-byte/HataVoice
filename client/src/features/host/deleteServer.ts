import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { HostView } from "../../host/types";
import { useServers } from "../../state/servers";
import { hostView, localAddress } from "./createServer";

/**
 * Deletes the server hosted on this PC for good: it stops, its folder and this PC's copy of its chat go, and it leaves
 * the list. The saved key lets the chat go even when the server is not open now.
 */
export async function deleteHostedServer(address: string): Promise<void> {
  const servers = useServers.getState();
  const saved = servers.servers.find((s) => s.address === address);
  const key = await invoke<string | null>("host_delete", { serverKey: saved?.serverKey ?? null });
  // The same server added by another address too (its internet address, the LAN, a tunnel): it is gone everywhere.
  const keys = new Set([key, saved?.serverKey].filter((k): k is string => !!k));
  for (const other of servers.servers) {
    if (other.address === address || (other.serverKey && keys.has(other.serverKey))) useServers.getState().remove(other.address);
  }
}

/** The address this PC reaches its own server by; none when there is no server here. */
export function hostedAddress(view: HostView): string | null {
  return view.config ? localAddress(view.config) : null;
}

/** The server hosted on this PC: the address it is reached by here, whether it runs, and why it stopped if it crashed. */
export type HostedServer = { address: string | null; running: boolean; crash: string | null };

/** How often the shell looks whether the server of this PC still runs. */
export const HOSTED_CHECK_MS = 5000;

/**
 * The server hosted on this PC, looked up again whenever `key` changes and every few seconds: null outside the app,
 * undefined until it is known.
 */
export function useHostedServer(key: unknown): HostedServer | null | undefined {
  const [hosted, setHosted] = useState<HostedServer | null | undefined>(isTauri() ? undefined : null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const look = () =>
      void hostView()
        .then((view) => live && setHosted({ address: hostedAddress(view), running: view.running, crash: view.crash }))
        .catch(() => live && setHosted({ address: null, running: false, crash: null }));
    look();
    const timer = setInterval(look, HOSTED_CHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key]);
  return hosted;
}

/**
 * The address of the server hosted on this PC, looked up again whenever `key` changes: null when there is none (or
 * outside the app), undefined until it is known.
 */
export function useHostedAddress(key: unknown): string | null | undefined {
  const [address, setAddress] = useState<string | null | undefined>(isTauri() ? undefined : null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void hostView()
      .then((view) => live && setAddress(hostedAddress(view)))
      .catch(() => live && setAddress(null));
    return () => {
      live = false;
    };
  }, [key]);
  return address;
}
