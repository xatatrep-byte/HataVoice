import { useEffect, useRef } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { isInviteLink } from "../../server/session";

/**
 * Calls `onLink` with each hatavoice:// invite opened from outside: the link that started the
 * app and every one clicked while it runs (a second launch forwards it here).
 */
export function useInviteLinks(onLink: (link: string) => void): void {
  const handler = useRef(onLink);
  handler.current = onLink;
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    const take = (urls: string[] | null) => {
      const link = urls?.find(isInviteLink);
      if (link && !disposed) handler.current(link);
    };
    // Outside the desktop app (plain `pnpm dev`) the plugin is missing: nothing to listen to.
    getCurrent().then(take, () => {});
    onOpenUrl(take)
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
