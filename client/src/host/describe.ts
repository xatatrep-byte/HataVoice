import type { HostView, VirtualNet } from "./types";

export type HostPhase = "none" | "stopped" | "starting" | "running" | "failed";
export type HostNote = { level: "ok" | "warn" | "error"; text: string };

export type HostSummary = {
  phase: HostPhase;
  shareAddress: string | null;
  /** Reachable by key from anywhere, public address or not. */
  p2pAddress: string | null;
  /** Whether the public address really works: a public IP with every port open. */
  publicWorks: boolean;
  lanAddress: string | null;
  /** Addresses for friends in the same virtual LAN, e.g. "Radmin VPN: 26.10.20.30:7350". */
  virtualAddresses: { label: string; address: string }[];
  /** The virtual LANs this PC is in now: one not in `virtualAddresses` was joined after the start (restart). */
  virtualNow: { label: string; address: string }[];
  notes: HostNote[];
};

export const VIRTUAL_NET_LABELS: Record<VirtualNet, string> = {
  radmin: "Radmin VPN",
  zerotier: "ZeroTier",
  hamachi: "Hamachi",
  tailscale: "Tailscale",
};

const portName = (p: { protocol: string; port: number }) => `${p.protocol.toUpperCase()} ${p.port}`;

/** Turns the raw host view into what the UI says: phase, addresses and plain-language notes. */
export function describeHost(view: HostView): HostSummary {
  const summary: HostSummary = {
    phase: "none",
    shareAddress: null,
    p2pAddress: null,
    publicWorks: false,
    lanAddress: null,
    virtualAddresses: [],
    virtualNow: [],
    notes: [],
  };
  if (!view.config) return summary;

  if (!view.running) {
    if (view.crash !== null) {
      summary.phase = "failed";
      summary.notes.push({ level: "error", text: `Сервер остановился: ${view.crash}` });
    } else {
      summary.phase = "stopped";
    }
    return summary;
  }

  const status = view.status;
  if (!status) {
    summary.phase = "starting";
    return summary;
  }
  if (status.livekit.state === "failed") {
    summary.phase = "failed";
    summary.notes.push({ level: "error", text: `LiveKit не запустился: ${status.livekit.detail ?? ""}` });
    return summary;
  }
  summary.phase = status.livekit.state === "running" ? "running" : "starting";
  summary.shareAddress = status.share_address;
  summary.p2pAddress = status.p2p_address ?? null;
  summary.publicWorks =
    !!status.share_address &&
    status.network.router_ip_kind !== "cgnat" &&
    status.network.router_ip_kind !== "private" &&
    status.network.ports.length > 0 &&
    status.network.ports.every((p) => p.open);
  summary.lanAddress = status.lan_address;
  summary.virtualAddresses = (status.virtual_addresses ?? []).map((v) => ({
    label: VIRTUAL_NET_LABELS[v.kind] ?? v.kind,
    address: v.address,
  }));
  // An older server does not say: what it saw at the start is all we know.
  summary.virtualNow = status.virtual_addresses_now
    ? status.virtual_addresses_now.map((v) => ({ label: VIRTUAL_NET_LABELS[v.kind] ?? v.kind, address: v.address }))
    : summary.virtualAddresses;

  const net = status.network;
  const allPorts = net.ports.map(portName).join(", ");
  const target = net.local_ip ?? "этот ПК";
  switch (net.upnp.state) {
    case "disabled":
      summary.notes.push({ level: "warn", text: `UPnP выключен. Открой на роутере порты ${allPorts} на адрес ${target}` });
      break;
    case "unavailable":
      summary.notes.push({
        level: "warn",
        text: `${net.upnp.detail ?? "UPnP недоступен"}. Открой на роутере порты ${allPorts} на адрес ${target} вручную`,
      });
      break;
    case "done": {
      const failed = net.ports.filter((p) => !p.open);
      if (failed.length === 0) {
        summary.notes.push({ level: "ok", text: "Порты открыты на роутере" });
      } else {
        const list = failed.map((p) => `${portName(p)}${p.error ? ` (${p.error})` : ""}`).join(", ");
        summary.notes.push({ level: "warn", text: `Роутер не открыл: ${list}. Открой вручную` });
      }
      break;
    }
    case "searching":
      break;
  }

  // With a tunnel nothing on the router matters any more, whatever it says.
  if (summary.p2pAddress && !summary.publicWorks) {
    summary.notes.length = 0;
    summary.notes.push({ level: "ok", text: "Друзья подключатся откуда угодно: порты открывать не нужно, ссылка сама найдёт путь" });
    return summary;
  }

  if (net.router_ip_kind === "cgnat") {
    const lan = summary.virtualAddresses[0];
    summary.notes.push(
      lan
        ? {
            level: "warn",
            text: `У провайдера серый IP (CGNAT): из интернета напрямую не подключиться, но друзья в ${lan.label} подключатся по адресу ниже`,
          }
        : {
            level: "error",
            text: "У провайдера серый IP (CGNAT): из интернета к этому ПК не подключиться. Нужен белый IP или общая сеть с друзьями (Radmin VPN, ZeroTier)",
          },
    );
  } else if (net.router_ip_kind === "private") {
    summary.notes.push({
      level: "error",
      text: `Роутер сам стоит за другим роутером (адрес ${net.router_ip}): порты нужно открыть и на верхнем`,
    });
  } else if (!net.public_ip) {
    summary.notes.push({
      level: "warn",
      text: "Внешний IP неизвестен: укажи его в настройках сервера, иначе друзья из интернета не подключатся",
    });
  }
  return summary;
}
