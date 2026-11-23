import { describe, expect, it } from "vitest";
import { member } from "../server/testState";
import type { CallSecurity } from "./callSecurity";
import { toParticipantViews, withEncryption, withMemberNames } from "./participants";

const p = (over: Partial<Parameters<typeof toParticipantViews>[0][number]>) => ({
  identity: "id",
  name: "",
  isSpeaking: false,
  isMicrophoneEnabled: true,
  isLocal: false,
  ...over,
});

describe("toParticipantViews", () => {
  it("puts the local participant first, then sorts others by name", () => {
    const views = toParticipantViews([
      p({ identity: "b", name: "Яша" }),
      p({ identity: "me", name: "Петя", isLocal: true }),
      p({ identity: "a", name: "Аня" }),
    ]);
    expect(views.map((v) => v.identity)).toEqual(["me", "a", "b"]);
  });

  it("maps speaking and muted state", () => {
    const [view] = toParticipantViews([
      p({ identity: "x", name: "Вася", isSpeaking: true, isMicrophoneEnabled: false }),
    ]);
    expect(view).toEqual({
      identity: "x",
      name: "Вася",
      speaking: true,
      muted: true,
      isLocal: false,
      quality: "unknown",
      level: 0,
      deafened: false,
      color: "blue",
      encrypted: false,
    });
  });

  it("reads deafen, connection quality and level from LiveKit, never a color", () => {
    const [view] = toParticipantViews([
      p({
        identity: "x",
        name: "Аня",
        attributes: { color: "pink", deafened: "1" },
        connectionQuality: "poor",
        audioLevel: 0.4,
      }),
    ]);
    // The color is in the person's profile, in the server's group: what LiveKit says does not count.
    expect(view).toMatchObject({ color: "blue", deafened: true, quality: "poor", level: 0.4 });
  });

  it("ignores unknown colors and qualities, and uses the local mic level for yourself", () => {
    const [me, other] = toParticipantViews(
      [
        p({ identity: "me", name: "Я", isLocal: true, audioLevel: 0.9 }),
        p({ identity: "o", name: "Он", attributes: { color: "black" }, connectionQuality: "superb" }),
      ],
      { local: { speaking: false, level: 0.25 } },
    );
    expect(me.level).toBe(0.25);
    expect(other).toMatchObject({ color: "blue", quality: "unknown", deafened: false });
  });

  it("has no name of its own: LiveKit is told none", () => {
    const [view] = toParticipantViews([p({ identity: "dev-42", name: undefined })]);
    expect(view.name).toBe("Без ника");
  });

  it("shows you speaking from what you actually send, not from the server", () => {
    const me = (isSpeaking: boolean, speaking: boolean) =>
      toParticipantViews([p({ identity: "me", isLocal: true, isSpeaking })], { local: { speaking, level: 0.5 } })[0];
    expect(me(false, true).speaking).toBe(true);
    expect(me(true, false).speaking).toBe(false);
  });

  it("shows others speaking from their voice as heard on this PC", () => {
    const [view] = toParticipantViews([p({ identity: "o", isSpeaking: false, audioLevel: 0.01 })], {
      remote: (id) => (id === "o" ? { speaking: true, level: 0.6 } : undefined),
    });
    expect(view).toMatchObject({ speaking: true, level: 0.6 });
  });

  it("falls back to the server for someone not measured yet", () => {
    const [view] = toParticipantViews([p({ identity: "o", isSpeaking: true, audioLevel: 0.3 })], {
      remote: () => undefined,
    });
    expect(view).toMatchObject({ speaking: true, level: 0.3 });
  });
});

describe("withMemberNames", () => {
  it("names people on the stage from the signed journal, not from what their client claims", () => {
    const views = toParticipantViews([p({ identity: "petya", name: "Аня" }), p({ identity: "stranger", name: "Вася" })]);
    const named = withMemberNames(views, [member("petya", "Петя", { color: "teal" })]);
    expect(named.find((v) => v.identity === "petya")).toMatchObject({ name: "Петя", color: "teal" });
    // Someone the journal does not know keeps the name LiveKit has.
    expect(named.find((v) => v.identity === "stranger")!.name).toBe("Вася");
  });

  it("puts the stage in the order of the nicknames the group gives", () => {
    const views = toParticipantViews([p({ identity: "me", isLocal: true }), p({ identity: "b" }), p({ identity: "a" })]);
    const named = withMemberNames(views, [member("a", "Яна"), member("b", "Аня"), member("me", "Я")]);
    expect(named.map((v) => v.name)).toEqual(["Я", "Аня", "Яна"]);
  });

  it("shows the fingerprint when two members share a nickname", () => {
    const views = toParticipantViews([p({ identity: "a000", name: "Петя" })]);
    const named = withMemberNames(views, [member("a000", "Петя", { name_clash: true, fingerprint: "k7q3" })]);
    expect(named[0]!.name).toBe("Петя · k7q3");
  });
});

describe("withEncryption", () => {
  const people = () =>
    toParticipantViews([
      p({ identity: "me", name: "Я", isLocal: true }),
      p({ identity: "anya", name: "Аня" }),
      p({ identity: "ghost", name: "Яша" }),
    ]);
  const call = (state: CallSecurity["state"], members: string[]): CallSecurity => ({
    state,
    code: state === "secure" ? "03817 55920 11111 22222 33333 44444" : null,
    members,
    error: state === "failed" ? "Не удалось зашифровать звонок" : null,
  });
  const marks = (views: ReturnType<typeof people>) => views.map((v) => [v.identity, v.encrypted]);

  it("marks people outside the call group as not encrypted", () => {
    const views = withEncryption(people(), call("secure", ["me", "anya"]));
    expect(marks(views)).toEqual([
      ["me", true],
      ["anya", true],
      ["ghost", false],
    ]);
  });

  it("marks us encrypted only once the call is secure", () => {
    for (const state of ["off", "pending", "failed"] as const) {
      const [me] = withEncryption(people(), call(state, []));
      expect(me).toMatchObject({ identity: "me", encrypted: false });
    }
    const [me] = withEncryption(people(), call("secure", ["me"]));
    expect(me.encrypted).toBe(true);
  });

  it("marks an identity that showed an unencrypted track as not encrypted, even inside the group", () => {
    const views = withEncryption(people(), call("secure", ["me", "anya", "ghost"]), new Set(["anya"]));
    expect(marks(views)).toEqual([
      ["me", true],
      ["anya", false],
      ["ghost", true],
    ]);
  });

  it("marks nobody while the group is not there yet", () => {
    expect(withEncryption(people(), call("pending", [])).map((v) => v.encrypted)).toEqual([false, false, false]);
  });

  it("keeps everything else and the order", () => {
    const before = people();
    const after = withEncryption(before, call("secure", ["me"]));
    expect(after.map((v) => v.identity)).toEqual(before.map((v) => v.identity));
    expect(after.map((v) => ({ ...v, encrypted: false }))).toEqual(before);
  });
});
