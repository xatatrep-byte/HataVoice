import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { notify } from "../../ui/toasts";
import { android } from "../../platform/android";

export type UpdateOffer = { version: string; size: number };

const ASK_EVERY_MS = 30 * 60_000;

/** A newer version the server has for us, and the one click that puts it on. */
export function useUpdate(address: string | null, connected: boolean) {
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    if (!isTauri() || !address || !connected) return;
    let alive = true;
    const ask = () =>
      void invoke<UpdateOffer | null>("update_check", { address })
        .then((next) => alive && setOffer(next ?? null))
        .catch(() => {});
    ask();
    const timer = setInterval(ask, ASK_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [address, connected]);
  const install = useCallback(() => {
    if (!address) return;
    setInstalling(true);
    // On success the program quits here, and the installer opens the new version. On a phone the checked package goes to
    // Android's installer, which asks the person.
    void invoke("update_install", { address })
      .then(() => {
        const bridge = android();
        if (!bridge) return;
        bridge.send({ op: "install-update" });
        setInstalling(false);
        notify.info("Android спросит, поставить ли обновление. Если попросит — разреши ХатаВойсу устанавливать приложения");
      })
      .catch((e: unknown) => {
        notify.error(String(e));
        setInstalling(false);
      });
  }, [address]);
  return { offer, installing, install };
}
