/**
 * The call's frame keys as the call engine last gave them (each member's, by key index), for what else is sealed with
 * them (the drawing board). The engine sends them only when they change: one who looks later finds them here.
 */
import type { CallKeysEvent } from "../server/session";

type Keys = { address: string; channel: string; byIdentity: Map<string, Map<number, string>>; latest: Map<string, number> };

let keys: Keys | null = null;
const listeners = new Set<() => void>();

/** The call's keys now (kept from earlier epochs too, so a packet still in flight opens); null: out of the call. */
export function setCallKeys(event: CallKeysEvent | null): void {
  if (!event) keys = null;
  else {
    const same = keys && keys.address === event.address && keys.channel === event.channel;
    const byIdentity = same ? keys!.byIdentity : new Map<string, Map<number, string>>();
    const latest = new Map<string, number>();
    for (const key of event.keys) {
      const ring = byIdentity.get(key.identity) ?? new Map<number, string>();
      ring.set(key.index, key.key);
      byIdentity.set(key.identity, ring);
      latest.set(key.identity, key.index);
    }
    keys = { address: event.address, channel: event.channel, byIdentity, latest };
  }
  for (const listener of listeners) listener();
}

/** `identity`'s frame key of index `index` (base64url), if the call gave one. */
export function callKeyOf(identity: string, index: number): string | null {
  return keys?.byIdentity.get(identity)?.get(index) ?? null;
}

/** `identity`'s key of the latest epoch: its index and the key. */
export function latestCallKey(identity: string): { index: number; key: string } | null {
  const index = keys?.latest.get(identity);
  if (index === undefined) return null;
  const key = callKeyOf(identity, index);
  return key ? { index, key } : null;
}

/** Hears every change of the keys; returns the stop. */
export function onCallKeysChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
