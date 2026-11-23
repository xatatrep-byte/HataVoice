import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { loadJson, saveJson } from "../../state/persist";
import { notify } from "../../ui/toasts";
import { CHANGELOG, isNewerRelease } from "./changelog";

const SEEN_KEY = "hatavoice.seenVersion";

/** After an update, once: says the new number and what came with it. */
export function useWhatsNew(): void {
  useEffect(() => {
    if (!isTauri()) return;
    void getVersion()
      .then((version) => {
        const stored = loadJson(SEEN_KEY);
        const seen = typeof stored === "string" ? stored : null;
        if (seen === version) return;
        saveJson(SEEN_KEY, version);
        if (!isNewerRelease(version, seen)) return;
        const first = CHANGELOG.find((r) => r.version === version)?.changes[0];
        notify.info(first ? `Версия ${version}. ${first}` : `Версия ${version}`);
      })
      .catch(() => {});
  }, []);
}
