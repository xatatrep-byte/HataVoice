import { invoke } from "@tauri-apps/api/core";
import { claimHost } from "../../server/session";
import { DEFAULT_HOST_CONFIG, type HostConfig, type HostView } from "../../host/types";
import type { ChannelDef } from "../channels/templates";

const START_TIMEOUT_MS = 30_000;
const POLL_MS = 500;

export function hostView(): Promise<HostView> {
  return invoke<HostView>("host_view");
}

/** Address this PC uses to reach its own server. */
export function localAddress(config: HostConfig): string {
  return `127.0.0.1:${config.api_port}`;
}

export type NewServer = {
  name: string;
  /** Its rooms, in order; a server it already owns keeps its own. */
  rooms: ChannelDef[];
  upnp: boolean;
  /** Friends without a public IP reach it by its key. */
  p2p: boolean;
  /** Ports, when changed from the usual. */
  ports?: Partial<Pick<HostConfig, "api_port" | "rtc_tcp_port" | "rtc_udp_port">>;
};

/**
 * Creates (or reconfigures) the server hosted on this PC, starts it, waits for LiveKit and makes this PC's identity its
 * owner with the rooms chosen (a server it already owns keeps its rooms).
 */
export async function createHostedServer({ name, rooms, upnp, p2p, ports }: NewServer): Promise<{ config: HostConfig; serverKey: string; backupSuggested: boolean }> {
  const current = (await hostView()).config;
  const config: HostConfig = { ...(current ?? DEFAULT_HOST_CONFIG), ...ports, name: name.trim(), upnp, p2p };
  await invoke("host_save", { config });
  await invoke("host_start");

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const view = await hostView();
    if (!view.running && view.crash !== null) throw `Сервер не запустился: ${view.crash}`;
    if (view.status?.livekit.state === "failed") throw `LiveKit не запустился: ${view.status.livekit.detail ?? ""}`;
    if (view.status?.livekit.state === "running") break;
    if (Date.now() > deadline) throw "Сервер запускается слишком долго. Его состояние видно в настройках";
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const claimed = await claimHost(config.name, rooms);
  return { config, serverKey: claimed.serverKey, backupSuggested: claimed.backupSuggested };
}
