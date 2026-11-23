import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { usePrefs } from "../../state/prefs";
import { useServers, type SavedServer } from "../../state/servers";

export type FoundInvite = { link: string; address: string; server_key: string };

export type InviteAction = { kind: "offer"; link: string } | { kind: "move"; from: string; to: string } | { kind: "nothing" };

/**
 * What an invite found in the clipboard means. A new server: offer to join, one click instead of pasting. A server we
 * are on, at a new address: its key is pinned, so the new address is safe to take at once, and nobody has to do a
 * thing. The same server at the same address: nothing, which is also the owner who just copied a link to send it on.
 */
export function inviteAction(found: FoundInvite, servers: SavedServer[]): InviteAction {
  const known = servers.find((s) => s.serverKey === found.server_key);
  if (!known) return servers.some((s) => s.address === found.address) ? { kind: "nothing" } : { kind: "offer", link: found.link };
  return known.address === found.address ? { kind: "nothing" } : { kind: "move", from: known.address, to: found.address };
}

/** Looks for an invite when the window comes back to the front, and at the start; each link is offered once a run. */
export function useClipboardInvite(onOffer: (link: string) => void): void {
  const handler = useRef(onOffer);
  handler.current = onOffer;
  const enabled = usePrefs((s) => s.clipboardInvites);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const offered = new Set<string>();
    const look = () => {
      void invoke<FoundInvite | null>("invite_from_clipboard")
        .then((found) => {
          if (!found || offered.has(found.link)) return;
          offered.add(found.link);
          const { servers, move } = useServers.getState();
          const action = inviteAction(found, servers);
          if (action.kind === "offer") handler.current(action.link);
          else if (action.kind === "move") move(action.from, action.to);
        })
        .catch(() => {});
    };
    look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [enabled]);
}
