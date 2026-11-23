import { useServers } from "../../state/servers";

/**
 * After «Понятно» on the kick or ban card: a kicked person loses the server from the list; a
 * banned one keeps it marked «Ты забанен до …».
 */
export function afterPunishment(address: string, kind: "kick" | "ban", until: number | null): void {
  const servers = useServers.getState();
  if (kind === "kick") servers.remove(address);
  else servers.update(address, { bannedUntil: until });
}
