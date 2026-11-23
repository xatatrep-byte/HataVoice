import { BaseKeyProvider, createKeyMaterialFromBuffer } from "livekit-client";
import type { CallKey } from "../server/session";
import { ENCRYPTION_FAILED } from "./callSecurity";

/**
 * How long our own new key waits. Setting a key in LiveKit also makes it the one we encrypt with,
 * so the others get theirs first (they are set at once) and only then do we start sending with
 * the new one.
 */
export const OWN_KEY_DELAY_MS = 250;

const KEY_BYTES = 32;
const KEY_ERROR = ENCRYPTION_FAILED;

/** base64url without padding → bytes; anything but exactly 32 bytes is refused. */
function decodeKey(text: string): ArrayBuffer {
  let raw: string;
  try {
    raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new Error(KEY_ERROR);
  }
  if (raw.length !== KEY_BYTES) throw new Error(KEY_ERROR);
  const bytes = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

type Prepared = { identity: string; index: number; material: CryptoKey };

/**
 * Feeds LiveKit's frame encryption with the per-sender keys the Rust call engine derives from the
 * MLS group. Nothing is shared, ratcheted or derived here: a key is imported and handed over.
 *
 * One provider per call: `getKeys()` (which LiveKit reads when a room connects) keeps every key
 * ever applied, `reset()` only stops what is still waiting.
 */
export class CallKeyProvider extends BaseKeyProvider {
  private ownSet = false;
  private pendingOwn: ReturnType<typeof setTimeout> | null = null;
  private waiters: (() => void)[] = [];
  /** Bumped by `reset()` so that an `apply` still importing keys sets nothing afterwards. */
  private generation = 0;
  /** `apply` calls run one after another, so keys for one identity never swap places. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: 16, keySize: 256 });
  }

  /** Our own key is set: from here on the microphone may send. */
  get ready(): boolean {
    return this.ownSet;
  }

  whenReady(): Promise<void> {
    if (this.ownSet) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Other people's keys are set at once, ours after OWN_KEY_DELAY_MS (the very first one at once,
   * so the call can start). Resolves when the others' keys are set and ours is set or scheduled.
   */
  apply(keys: CallKey[], localIdentity: string): Promise<void> {
    const generation = this.generation;
    const run = this.queue.then(() => this.applyNow(keys, localIdentity, generation));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Forgets that our key was set and cancels the one that is waiting. */
  reset(): void {
    this.generation++;
    if (this.pendingOwn !== null) clearTimeout(this.pendingOwn);
    this.pendingOwn = null;
    this.ownSet = false;
  }

  private async applyNow(keys: CallKey[], localIdentity: string, generation: number): Promise<void> {
    const prepared: Prepared[] = await Promise.all(
      keys.map(async ({ identity, index, key }) => ({
        identity,
        index,
        material: await createKeyMaterialFromBuffer(decodeKey(key)),
      })),
    );
    if (generation !== this.generation) return;

    for (const { identity, index, material } of prepared) {
      if (identity !== localIdentity) this.onSetEncryptionKey(material, identity, index);
    }
    // Only the newest own key counts: one that is still waiting was never used, drop it.
    const ours = prepared.filter((key) => key.identity === localIdentity);
    const own = ours[ours.length - 1];
    if (!own) return;
    if (this.pendingOwn !== null) clearTimeout(this.pendingOwn);
    this.pendingOwn = null;
    if (!this.ownSet) {
      this.setOwn(own);
    } else {
      this.pendingOwn = setTimeout(() => {
        this.pendingOwn = null;
        this.setOwn(own);
      }, OWN_KEY_DELAY_MS);
    }
  }

  private setOwn({ identity, index, material }: Prepared): void {
    this.onSetEncryptionKey(material, identity, index);
    this.ownSet = true;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }
}
