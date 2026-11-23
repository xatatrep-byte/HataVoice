import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { chatDms, onChatRooms, type DmView } from "./api";
import { useEvent } from "./useChat";

/** The direct messages of `address`, newest first; read again when their rooms change. */
export function useDms(address: string | null): DmView[] {
  const [dms, setDms] = useState<DmView[]>([]);
  const read = useCallback(() => {
    if (!address || !isTauri()) return setDms([]);
    void chatDms(address)
      .then(setDms)
      .catch(() => setDms([]));
  }, [address]);
  useEffect(read, [read]);
  useEvent(onChatRooms, (changed) => {
    if (changed === address) read();
  });
  return dms;
}
