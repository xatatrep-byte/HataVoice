import { useEffect, useState } from "react";
import { hostView } from "../host/createServer";
import { describeHost } from "../../host/describe";
import { createInvite, hasPermission, serverErrorText, type ServerStateView } from "../../server/session";
import { notify } from "../../ui/toasts";
import { isRecord, loadJson, saveJson } from "../../state/persist";

export type ShareOption = { label: string; address: string; /** Not on this PC yet: listed, so it is clear where it will be, but not picked. */ missing?: string };

/** The shared networks the guide explains, listed even when this PC is not in them. */
const KNOWN_NETS = ["Radmin VPN", "ZeroTier"];

/**
 * Where friends reach this server. For the server on this PC: the internet address, any virtual
 * LAN (Radmin VPN, ZeroTier…) and the home network; for anyone else's — the address we use.
 */
export function useShareOptions(address: string, tunnel?: string | null): ShareOption[] {
  const [options, setOptions] = useState<ShareOption[]>(() => someoneElses(address, tunnel));
  useEffect(() => {
    setOptions(someoneElses(address, tunnel));
    if (!address.startsWith("127.0.0.1:")) return;
    let alive = true;
    hostView()
      .then((view) => {
        const summary = describeHost(view);
        const internet = summary.shareAddress ? [{ label: "Интернет", address: summary.shareAddress }] : [];
        const byKey = summary.p2pAddress ? [{ label: "Откуда угодно, без белого IP", address: summary.p2pAddress }] : [];
        // What surely works goes first: the first option is what «Пригласить друга» gives out.
        const found: ShareOption[] = [
          ...(summary.publicWorks ? [...internet, ...byKey] : [...byKey, ...internet]),
          ...summary.virtualAddresses,
          ...(summary.lanAddress ? [{ label: "Wi-Fi и домашняя сеть", address: summary.lanAddress }] : []),
        ];
        const missing: ShareOption[] = KNOWN_NETS.filter((label) => !summary.virtualAddresses.some((v) => v.label === label)).map((label) => ({
          label,
          address: "",
          missing: summary.virtualNow.some((v) => v.label === label)
            ? "включён, перезапусти сервер в «Мой сервер»"
            : "не найден на этом ПК — сначала поставь и включи его",
        }));
        if (alive && found.length > 0) setOptions([...found, ...missing]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [address, tunnel]);
  return options;
}

function someoneElses(address: string, tunnel?: string | null): ShareOption[] {
  const own = { label: "Адрес сервера", address };
  return tunnel && tunnel !== address ? [own, { label: "Откуда угодно, без белого IP", address: tunnel }] : [own];
}

const STORE_KEY = "hatavoice.permanentInvites";

function stored(): Record<string, string> {
  const raw = loadJson(STORE_KEY);
  return isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
}

/** Whether we have a live invite without a limit: the server knows of it, though not of its secret. */
export function hasPermanentInvite(state: Pick<ServerStateView, "invites" | "me">): boolean {
  return state.invites.some((invite) => invite.by === state.me.user_id && invite.max_uses === null && invite.expires_at === null);
}

/**
 * One link to give to anyone, at any time: made once, kept on this PC, good until it is revoked in the server's
 * settings, and made anew after that or when the address it names changed.
 */
export async function permanentInvite(address: string, shareAddress: string, state: Pick<ServerStateView, "invites" | "me">): Promise<string> {
  const links = stored();
  const key = `${address}|${shareAddress}`;
  const kept = links[key];
  if (kept && hasPermanentInvite(state)) return kept;
  const link = await createInvite(address, { shareAddress, roles: [], maxUses: null, expiresMinutes: null });
  saveJson(STORE_KEY, { ...links, [key]: link });
  return link;
}

/**
 * «Позвать друга»: the house's lasting invite on the clipboard, and a word on how a friend uses it. Null for those who
 * may not make one.
 */
export function useInvite(server: { address: string; tunnel?: string } | null, state: ServerStateView | null): (() => void) | null {
  const shareOptions = useShareOptions(server?.address ?? "", server?.tunnel);
  if (!server || !state || !hasPermission(state.me, "create_invites")) return null;
  return () => {
    const shareAddress = (shareOptions.find((o) => !o.missing) ?? { address: server.address }).address;
    void permanentInvite(server.address, shareAddress, state)
      .then((link) => navigator.clipboard.writeText(link))
      .then(() => notify.info("Ссылка скопирована. Другу достаточно скопировать её и открыть ХатаВойс"))
      .catch((e: unknown) => notify.error(`Не получилось: ${serverErrorText(e)}`));
  };
}
