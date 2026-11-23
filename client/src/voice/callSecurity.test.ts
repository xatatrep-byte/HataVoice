import { describe, expect, it } from "vitest";
import type { CallStateEvent } from "../server/session";
import {
  createKeyWaits,
  EncryptionError,
  isEncryptionMessage,
  mayHear,
  NO_CALL,
  nextSecurity,
  presentIdentities,
  type CallSecurity,
} from "./callSecurity";

const event = (over: Partial<CallStateEvent> = {}): CallStateEvent => ({
  address: "1.2.3.4:7350",
  channel: "general",
  state: "pending",
  code: null,
  members: [],
  error: null,
  ...over,
});

describe("nextSecurity", () => {
  const call = ["1.2.3.4:7350", "general"] as const;

  it("follows the state of the current call", () => {
    const pending = nextSecurity(NO_CALL, event(), ...call);
    expect(pending).toEqual({ state: "pending", code: null, members: [], error: null });

    const secure = nextSecurity(
      pending,
      event({ state: "secure", code: "03817 55920 11111 22222 33333 44444", members: ["a", "b"] }),
      ...call,
    );
    expect(secure).toEqual({
      state: "secure",
      code: "03817 55920 11111 22222 33333 44444",
      members: ["a", "b"],
      error: null,
    });

    const failed = nextSecurity(secure, event({ state: "failed", error: "Не удалось зашифровать звонок" }), ...call);
    expect(failed).toEqual({ state: "failed", code: null, members: [], error: "Не удалось зашифровать звонок" });
  });

  it("starts as no call at all", () => {
    expect(NO_CALL).toEqual({ state: "off", code: null, members: [], error: null });
  });

  it("ignores events of another server or channel", () => {
    const current = nextSecurity(NO_CALL, event({ state: "secure", code: "1", members: ["a"] }), ...call);
    expect(nextSecurity(current, event({ address: "5.6.7.8:7350", state: "failed", error: "x" }), ...call)).toBe(current);
    expect(nextSecurity(current, event({ channel: "music", state: "failed", error: "x" }), ...call)).toBe(current);
  });

  it("ignores every event when there is no call", () => {
    expect(nextSecurity(NO_CALL, event({ state: "secure" }), null, null)).toBe(NO_CALL);
    expect(nextSecurity(NO_CALL, event({ state: "secure" }), call[0], null)).toBe(NO_CALL);
    expect(nextSecurity(NO_CALL, event({ state: "secure" }), null, call[1])).toBe(NO_CALL);
  });
});

describe("presentIdentities", () => {
  it("lists ourselves and everyone LiveKit shows", () => {
    expect(presentIdentities({ identity: "me" }, [{ identity: "a" }, { identity: "b" }])).toEqual(["me", "a", "b"]);
  });

  it("lists ourselves when the room is empty", () => {
    expect(presentIdentities({ identity: "me" }, [])).toEqual(["me"]);
  });

  it("does not list anyone twice", () => {
    expect(presentIdentities({ identity: "me" }, [{ identity: "a" }, { identity: "me" }, { identity: "a" }])).toEqual([
      "me",
      "a",
    ]);
  });
});

describe("key waits", () => {
  it("ends when the keys are ready", async () => {
    const waits = createKeyWaits();
    let ready!: () => void;
    const keys = new Promise<void>((resolve) => (ready = resolve));
    let done = false;
    const wait = waits.wait(keys).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    ready();
    await wait;
    expect(done).toBe(true);
  });

  it("fails every wait in progress when the call fails", async () => {
    const waits = createKeyWaits();
    const never = new Promise<void>(() => {});
    const first = waits.wait(never);
    const second = waits.wait(never);
    waits.fail(new EncryptionError());
    await expect(first).rejects.toThrow("Не удалось зашифровать звонок");
    await expect(second).rejects.toBeInstanceOf(EncryptionError);
  });

  it("does not remember a failure for the waits that come later", async () => {
    const waits = createKeyWaits();
    waits.fail(new EncryptionError());
    // The call may recover (the engine keeps trying): a later wait is a fresh one.
    let ready!: () => void;
    const wait = waits.wait(new Promise<void>((resolve) => (ready = resolve)));
    ready();
    await expect(wait).resolves.toBeUndefined();
  });

  it("is not failed by a wait that already ended", async () => {
    const waits = createKeyWaits();
    await waits.wait(Promise.resolve());
    expect(() => waits.fail(new EncryptionError())).not.toThrow();
  });
});

describe("mayHear", () => {
  const call = (state: CallSecurity["state"], members: string[]): CallSecurity => ({
    state,
    code: state === "secure" ? "03817 55920 11111 22222 33333 44444" : null,
    members,
    error: null,
  });
  const encrypted = { isEncrypted: true };
  const NO_TAINT = new Set<string>();

  it("never plays a track that is not encrypted, even of a member of a secure call", () => {
    expect(mayHear({ isEncrypted: false }, "anya", call("secure", ["me", "anya"]), NO_TAINT)).toBe(false);
  });

  it("does not play an encrypted track of someone outside the group", () => {
    expect(mayHear(encrypted, "ghost", call("secure", ["me", "anya"]), NO_TAINT)).toBe(false);
  });

  it("does not play a member while the call is pending, failed or not a call", () => {
    for (const state of ["off", "pending", "failed"] as const) {
      expect(mayHear(encrypted, "anya", call(state, ["me", "anya"]), NO_TAINT)).toBe(false);
    }
  });

  it("plays an encrypted track of a member of a secure call", () => {
    expect(mayHear(encrypted, "anya", call("secure", ["me", "anya"]), NO_TAINT)).toBe(true);
  });

  it("never plays an identity that showed an unencrypted track, whatever its other tracks say", () => {
    // LiveKit switches decryption per identity, so one such track puts all of the person's frames in doubt.
    const tainted = new Set(["anya"]);
    expect(mayHear(encrypted, "anya", call("secure", ["me", "anya"]), tainted)).toBe(false);
    expect(mayHear(encrypted, "boris", call("secure", ["me", "anya", "boris"]), tainted)).toBe(true);
  });

  it("stops playing a member who is removed from the group later", () => {
    expect(mayHear(encrypted, "anya", call("secure", ["me", "anya"]), NO_TAINT)).toBe(true);
    expect(mayHear(encrypted, "anya", call("secure", ["me"]), NO_TAINT)).toBe(false);
  });
});

describe("isEncryptionMessage", () => {
  it("knows the generic text and the one with a reason", () => {
    expect(isEncryptionMessage("Не удалось зашифровать звонок")).toBe(true);
    expect(isEncryptionMessage("Не удалось зашифровать звонок: Сервер недоступен")).toBe(true);
  });

  it("does not take other errors for it", () => {
    expect(isEncryptionMessage("Микрофон занят другой программой")).toBe(false);
    expect(isEncryptionMessage("Не удалось зашифровать звонок иначе")).toBe(false);
  });
});
