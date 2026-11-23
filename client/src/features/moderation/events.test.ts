import { describe, expect, it } from "vitest";
import { moderationAction } from "./events";

const media = { sha256: "ab", mime: "image/gif", size: 1 };

describe("moderationAction", () => {
  it("events addressed to me become actions", () => {
    expect(moderationAction({ type: "moved", channel: "games", by: "mod0" }, "me00")).toEqual({ kind: "moved", channel: "games", by: "mod0" });
    expect(moderationAction({ type: "disconnected", by: "mod0" }, "me00")).toEqual({ kind: "disconnected", by: "mod0" });
    expect(moderationAction({ type: "kicked", by: "mod0", reason: "Хватит", media }, "me00")).toEqual({
      kind: "punished",
      punishment: "kick",
      by: "mod0",
      reason: "Хватит",
      media,
      until: null,
    });
    expect(moderationAction({ type: "banned", by: "mod0", until: 5, reason: "", media: null }, "me00")).toMatchObject({
      kind: "punished",
      punishment: "ban",
      until: 5,
    });
  });

  it("mutes and notices about others are told apart from mine", () => {
    expect(moderationAction({ type: "mute", user: "me00", until: 9, by: "mod0", reason: "Шум" }, "me00")).toEqual({
      kind: "muted",
      by: "mod0",
      until: 9,
      reason: "Шум",
    });
    expect(moderationAction({ type: "mute", user: "v000", until: 9, by: "mod0", reason: "" }, "me00")).toBeNull();
    expect(moderationAction({ type: "unmute", user: "me00" }, "me00")).toEqual({ kind: "unmuted" });
    expect(moderationAction({ type: "moderation_notice", user: "v000", kind: "kick", reason: "спам", media }, "me00")).toEqual({
      kind: "notice",
      user: "v000",
      punishment: "kick",
      reason: "спам",
      media,
    });
    expect(moderationAction({ type: "moderation_notice", user: "me00", kind: "kick", reason: "", media: null }, "me00")).toBeNull();
    expect(moderationAction({ type: "roster", seq: 3 }, "me00")).toBeNull();
  });
});

import { muteSpan } from "./events";

describe("muteSpan", () => {
  it("says how long in words", () => {
    expect([300, 900, 3600, 86_400, null].map(muteSpan)).toEqual(["на 5 минут", "на 15 минут", "на 1 час", "на 1 день", "до снятия"]);
    expect(muteSpan(895)).toBe("на 15 минут");
    expect(muteSpan(120)).toBe("на 2 минуты");
  });
});
