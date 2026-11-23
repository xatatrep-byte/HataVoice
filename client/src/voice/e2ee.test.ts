import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyProviderEvent, type KeyInfo } from "livekit-client";
import type { CallKey } from "../server/session";
import { CallKeyProvider, OWN_KEY_DELAY_MS } from "./e2ee";

/** 32 bytes filled with `byte`, as the base64url the Rust side sends (no padding). */
function b64url(byte: number, length = 32): string {
  return btoa(String.fromCharCode(...new Uint8Array(length).fill(byte)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const callKey = (identity: string, index: number, byte: number): CallKey => ({ identity, index, key: b64url(byte) });

/** A provider whose SetKey events land in an array, as `{ identity, index }`. */
function watched() {
  const provider = new CallKeyProvider();
  const set: { identity?: string; index?: number }[] = [];
  provider.on(KeyProviderEvent.SetKey, (info: KeyInfo) => {
    set.push({ identity: info.participantIdentity, index: info.keyIndex });
  });
  return { provider, set };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("call key provider", () => {
  it("is configured for per-sender keys that are never ratcheted", () => {
    expect(new CallKeyProvider().getOptions()).toMatchObject({
      sharedKey: false,
      ratchetWindowSize: 0,
      failureTolerance: -1,
      keyringSize: 16,
      keySize: 256,
    });
  });

  it("sets other people's keys at once and its own after 250 ms", async () => {
    const { provider, set } = watched();
    await provider.apply([callKey("A", 1, 1), callKey("B", 1, 2)], "A");
    set.length = 0;

    await provider.apply([callKey("A", 2, 3), callKey("B", 2, 4)], "A");
    expect(set).toEqual([{ identity: "B", index: 2 }]);

    vi.advanceTimersByTime(OWN_KEY_DELAY_MS - 1);
    expect(set).toEqual([{ identity: "B", index: 2 }]);
    vi.advanceTimersByTime(1);
    expect(set).toEqual([
      { identity: "B", index: 2 },
      { identity: "A", index: 2 },
    ]);
  });

  it("sets the very first own key at once", async () => {
    const { provider, set } = watched();
    expect(provider.ready).toBe(false);
    await provider.apply([callKey("A", 1, 1), callKey("B", 1, 2)], "A");
    expect(provider.ready).toBe(true);
    expect(set).toEqual([
      { identity: "B", index: 1 },
      { identity: "A", index: 1 },
    ]);
  });

  it("is not ready from other people's keys alone", async () => {
    const { provider, set } = watched();
    await provider.apply([callKey("B", 1, 2)], "A");
    expect(set).toEqual([{ identity: "B", index: 1 }]);
    expect(provider.ready).toBe(false);
  });

  it("whenReady resolves once the own key is set", async () => {
    const { provider } = watched();
    let ready = false;
    void provider.whenReady().then(() => {
      ready = true;
    });
    await provider.apply([callKey("B", 1, 2)], "A");
    await Promise.resolve();
    expect(ready).toBe(false);

    await provider.apply([callKey("A", 1, 1), callKey("B", 1, 2)], "A");
    await Promise.resolve();
    expect(ready).toBe(true);
    // Already ready: resolves at once.
    await provider.whenReady();
  });

  it("reset cancels a pending own key", async () => {
    const { provider, set } = watched();
    await provider.apply([callKey("A", 1, 1)], "A");
    await provider.apply([callKey("A", 2, 3)], "A");
    set.length = 0;

    provider.reset();
    expect(provider.ready).toBe(false);
    vi.advanceTimersByTime(OWN_KEY_DELAY_MS * 4);
    expect(set).toEqual([]);
    expect(provider.ready).toBe(false);
  });

  it("sets the first own key at once again after a reset", async () => {
    const { provider, set } = watched();
    await provider.apply([callKey("A", 1, 1)], "A");
    provider.reset();
    set.length = 0;

    await provider.apply([callKey("A", 5, 9)], "A");
    expect(provider.ready).toBe(true);
    expect(set).toEqual([{ identity: "A", index: 5 }]);
  });

  it("sets nothing from an apply that a reset overtook", async () => {
    const { provider, set } = watched();
    const pending = provider.apply([callKey("A", 1, 1), callKey("B", 1, 2)], "A");
    provider.reset();
    await pending;
    expect(set).toEqual([]);
    expect(provider.ready).toBe(false);
  });

  it("a newer own key replaces the one that is still waiting", async () => {
    const { provider, set } = watched();
    await provider.apply([callKey("A", 1, 1)], "A");
    set.length = 0;

    await provider.apply([callKey("A", 2, 2)], "A");
    vi.advanceTimersByTime(OWN_KEY_DELAY_MS / 2);
    await provider.apply([callKey("A", 3, 3)], "A");
    vi.advanceTimersByTime(OWN_KEY_DELAY_MS * 4);
    expect(set).toEqual([{ identity: "A", index: 3 }]);
  });

  it("uses the epoch index from the event", async () => {
    const { provider, set } = watched();
    await provider.apply([callKey("A", 15, 1), callKey("B", 0, 2)], "A");
    expect(set).toContainEqual({ identity: "A", index: 15 });
    expect(set).toContainEqual({ identity: "B", index: 0 });
    expect(provider.getKeys().map((k) => [k.participantIdentity, k.keyIndex]).sort()).toEqual([
      ["A", 15],
      ["B", 0],
    ]);
  });

  it("refuses a key that is not 32 bytes", async () => {
    const { provider, set } = watched();
    await expect(provider.apply([{ identity: "B", index: 1, key: b64url(1, 16) }], "A")).rejects.toThrow(
      "Не удалось зашифровать звонок",
    );
    expect(set).toEqual([]);
  });
});
