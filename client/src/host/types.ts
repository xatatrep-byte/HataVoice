// Mirrors hv_host::HostConfig and the JSON of hatavoice-server's /api/host/status.

export type HostConfig = {
  name: string;
  api_port: number;
  rtc_tcp_port: number;
  rtc_udp_port: number;
  livekit_port: number;
  upnp: boolean;
  external_ip: string | null;
  /** Friends reach the server by its key, without a public address. */
  p2p?: boolean;
};

export type PortStatus = { protocol: "tcp" | "udp"; port: number; open: boolean; error: string | null };

export type AddressKind = "public" | "cgnat" | "private" | "loopback" | "other";

export type HostStatus = {
  name: string;
  livekit: { state: "starting" | "running" | "restarting" | "failed"; detail?: string };
  network: {
    upnp: { state: "disabled" | "searching" | "unavailable" | "done"; detail?: string };
    ports: PortStatus[];
    router_ip: string | null;
    router_ip_kind: AddressKind | null;
    public_ip: string | null;
    local_ip: string | null;
  };
  share_address: string | null;
  /** The server's address in the P2P tunnel; absent when it does not answer there. */
  p2p_address?: string | null;
  /** The version of the program this server hands out to its members. */
  update_version?: string | null;
  lan_address: string | null;
  /** Absent from servers older than this field. */
  virtual_addresses?: VirtualShare[];
  /** The networks this PC is in now; one missing from `virtual_addresses` was joined after the start (restart). */
  virtual_addresses_now?: VirtualShare[];
};

export type VirtualNet = "radmin" | "zerotier" | "hamachi" | "tailscale";
export type VirtualShare = { kind: VirtualNet; address: string };

export type HostView = {
  config: HostConfig | null;
  running: boolean;
  crash: string | null;
  status: HostStatus | null;
};

export const DEFAULT_HOST_CONFIG: HostConfig = {
  name: "Мой сервер",
  api_port: 7350,
  rtc_tcp_port: 7881,
  rtc_udp_port: 7882,
  livekit_port: 7880,
  upnp: true,
  external_ip: null,
};
