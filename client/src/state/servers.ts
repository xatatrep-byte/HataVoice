import { create } from "zustand";
import { isRecord, loadJson, saveJson } from "./persist";
import { AVATAR_COLORS, type AvatarColor } from "./prefs";

/**
 * `serverKey` is the server's key pinned on first contact (base64url); `bannedUntil` marks a server
 * that banned us (unix seconds, null for forever); `tunnel` is its address in the P2P tunnel, for a day its own address
 * stops answering.
 */
export type SavedServer = {
  address: string;
  name: string;
  color: AvatarColor;
  serverKey?: string;
  bannedUntil?: number | null;
  tunnel?: string;
};

const STORAGE_KEY = "hatavoice.servers";

export function parseServers(raw: unknown): SavedServer[] {
  if (!Array.isArray(raw)) return [];
  const servers: SavedServer[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.address !== "string" || item.address.trim() === "") continue;
    const address = item.address.trim();
    const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : address;
    const color = AVATAR_COLORS.includes(item.color as AvatarColor) ? (item.color as AvatarColor) : "blue";
    const serverKey = typeof item.serverKey === "string" && item.serverKey !== "" ? item.serverKey : undefined;
    const server: SavedServer = { address, name, color };
    if (serverKey) server.serverKey = serverKey;
    if (typeof item.bannedUntil === "number" || item.bannedUntil === null) server.bannedUntil = item.bannedUntil;
    if (typeof item.tunnel === "string" && item.tunnel.endsWith(".p2p")) server.tunnel = item.tunnel;
    servers.push(server);
  }
  return servers;
}

function load(): { servers: SavedServer[]; selected: string | null } {
  const stored = loadJson(STORAGE_KEY);
  const servers = parseServers(isRecord(stored) ? stored.servers : null);
  const wanted = isRecord(stored) && typeof stored.selected === "string" ? stored.selected : null;
  const selected = servers.some((s) => s.address === wanted) ? wanted : (servers[0]?.address ?? null);
  return { servers, selected };
}

type ServersState = {
  servers: SavedServer[];
  selected: string | null;
  /** Adds a server or replaces the one with the same address. */
  add: (server: SavedServer) => void;
  /** Changes a saved server; unknown addresses are ignored. */
  update: (address: string, change: Partial<Omit<SavedServer, "address">>) => void;
  remove: (address: string) => void;
  select: (address: string) => void;
  /** A known server moved: its place in the list and the selection go with it. */
  move: (from: string, to: string) => void;
};

export const useServers = create<ServersState>((set) => ({
  ...load(),
  add: (server) =>
    set((s) => {
      const exists = s.servers.some((x) => x.address === server.address);
      const servers = exists
        ? s.servers.map((x) => (x.address === server.address ? server : x))
        : [...s.servers, server];
      return { servers, selected: s.selected ?? server.address };
    }),
  update: (address, change) =>
    set((s) => ({ servers: s.servers.map((x) => (x.address === address ? { ...x, ...change } : x)) })),
  remove: (address) =>
    set((s) => {
      const servers = s.servers.filter((x) => x.address !== address);
      const selected = s.selected === address ? (servers[0]?.address ?? null) : s.selected;
      return { servers, selected };
    }),
  select: (address) => set((s) => (s.servers.some((x) => x.address === address) ? { selected: address } : {})),
  move: (from, to) =>
    set((s) => {
      if (from === to || !s.servers.some((x) => x.address === from)) return {};
      const servers = s.servers.filter((x) => x.address !== to).map((x) => (x.address === from ? { ...x, address: to } : x));
      return { servers, selected: s.selected === from ? to : s.selected };
    }),
}));

useServers.subscribe(({ servers, selected }) => saveJson(STORAGE_KEY, { servers, selected }));

/** A color for a newly added server's icon. */
export const randomServerColor = (): AvatarColor => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
