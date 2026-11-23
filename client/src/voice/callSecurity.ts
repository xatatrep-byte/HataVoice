import type { CallLockState, CallStateEvent } from "../server/session";

// What the window knows about the encryption of the current call, kept apart from React so the
// rules can be tested without a room.

/** The text of every failure to key a call: there is no call without encryption. */
export const ENCRYPTION_FAILED = "Не удалось зашифровать звонок";

export class EncryptionError extends Error {
  constructor() {
    super(ENCRYPTION_FAILED);
    this.name = "EncryptionError";
  }
}

/** The lock: `off` outside a call; the rest is what the call engine reports. */
export type CallSecurity = {
  state: "off" | CallLockState;
  /** Six groups of five digits to compare out loud; known once we are in the group. */
  code: string | null;
  /** Identities of the people inside the encryption, by leaf. */
  members: string[];
  error: string | null;
};

export const NO_CALL: CallSecurity = { state: "off", code: null, members: [], error: null };

/** A call that has just been joined: the keys are on their way. */
export const CALL_STARTING: CallSecurity = { ...NO_CALL, state: "pending" };

/** An event for another call (another server or channel, or no call at all) changes nothing. */
export function nextSecurity(
  current: CallSecurity,
  event: CallStateEvent,
  address: string | null,
  channel: string | null,
): CallSecurity {
  if (address === null || channel === null || event.address !== address || event.channel !== channel) return current;
  return { state: event.state, code: event.code, members: event.members, error: event.error };
}

/**
 * Who LiveKit shows in the room, ourselves included: the call engine adds and removes people to
 * match, and a room without us in it would have it drop our own leaf.
 */
export function presentIdentities(local: { identity: string }, remote: Iterable<{ identity: string }>): string[] {
  const identities = new Set([local.identity]);
  for (const participant of remote) identities.add(participant.identity);
  return [...identities];
}

/** The generic text or the one with a reason after a colon: what any failure to key a call looks like. */
export function isEncryptionMessage(text: string): boolean {
  return text === ENCRYPTION_FAILED || text.startsWith(`${ENCRYPTION_FAILED}:`);
}

/**
 * Whether a remote track may be heard (spec §5.4). The publisher, or the server, decides whether a
 * track is marked encrypted, and an unmarked one is passed through undecrypted, so only an
 * encrypted track counts. Even then, a key alone is not enough: LiveKit keeps old keys, so someone
 * the group has dropped could still be decrypted. The call must be secure and the owner in it.
 *
 * `tainted` are the identities that showed an unencrypted track during this call. LiveKit switches
 * decryption per identity, by the latest publication, so after one such track the others of the
 * same identity may be passed through raw as well, and nothing of theirs is heard again.
 */
export function mayHear(
  publication: { isEncrypted: boolean },
  identity: string,
  security: CallSecurity,
  tainted: ReadonlySet<string>,
): boolean {
  return (
    publication.isEncrypted && security.state === "secure" && security.members.includes(identity) && !tainted.has(identity)
  );
}

/**
 * The mic's wait for the call's keys. A wait ends when its `ready` does, or fails when the call
 * does (its keys did not come, or it ended). One per call.
 */
export function createKeyWaits() {
  const rejects = new Set<(error: Error) => void>();
  return {
    wait(ready: Promise<void>): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        rejects.add(reject);
        ready.then(resolve, reject).finally(() => rejects.delete(reject));
      });
    },
    /** Fails every wait in progress. Waits that start later are not affected. */
    fail(error: Error): void {
      const waiting = [...rejects];
      rejects.clear();
      for (const reject of waiting) reject(error);
    },
  };
}
