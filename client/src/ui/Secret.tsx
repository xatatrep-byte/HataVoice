import type { ReactNode } from "react";
import { useStreamerActive } from "../state/streamer";

/** What a stream must not show — an address, an invite: hidden while the streamer mode is on. */
export function Secret({ children }: { children: ReactNode }) {
  const hidden = useStreamerActive();
  return hidden ? <span className="secret">скрыто · режим стримера</span> : <>{children}</>;
}
