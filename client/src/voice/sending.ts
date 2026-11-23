import type { ActivationMode } from "../audio/settings";

/**
 * Whether our mic track should be live: in a call, mic button on, not deafened, not muted by a
 * moderator, and with push-to-talk only while the key is held.
 */
export function isSending(s: {
  connected: boolean;
  micOn: boolean;
  deafened: boolean;
  serverMuted: boolean;
  mode: ActivationMode;
  pttOpen: boolean;
}): boolean {
  return s.connected && s.micOn && !s.deafened && !s.serverMuted && (s.mode === "ptt" ? s.pttOpen : true);
}
