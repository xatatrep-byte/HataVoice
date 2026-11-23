import { describe, expect, it } from "vitest";
import { channelStillExists, makeChannelId, moveChannel, roomsFromNames, type ChannelDef } from "./templates";
import { peopleLabel } from "../home/rooms";

describe("rooms of a new server", () => {
  it("come from the names typed: the first is «general», blanks and repeats are dropped", () => {
    expect(roomsFromNames(["Общий", "Игры", "  ", "игры", "Кино и музыка"])).toEqual([
      { id: "general", name: "Общий" },
      { id: "igry", name: "Игры" },
      { id: "kino-i-muzyka", name: "Кино и музыка" },
    ]);
    expect(roomsFromNames(["Болталка"])).toEqual([{ id: "general", name: "Болталка" }]);
    expect(roomsFromNames(["x".repeat(40)])[0]!.name).toHaveLength(32);
    expect(roomsFromNames(Array.from({ length: 60 }, (_, i) => `Комната ${i}`))).toHaveLength(50);
  });
});

describe("makeChannelId", () => {
  it("transliterates names into short latin ids", () => {
    expect(makeChannelId("Кино и музыка", [])).toBe("kino-i-muzyka");
    expect(makeChannelId("Щука ЁЖ  2024!", [])).toBe("shchuka-ezh-2024");
  });

  it("adds a number when the id is taken and has a fallback for symbols", () => {
    expect(makeChannelId("Общий", ["obshchiy"])).toBe("obshchiy-2");
    expect(makeChannelId("Общий", ["obshchiy", "obshchiy-2"])).toBe("obshchiy-3");
    expect(makeChannelId("!!!", [])).toBe("channel");
  });

  it("never exceeds 64 characters", () => {
    expect(makeChannelId("очень ".repeat(30), []).length).toBeLessThanOrEqual(64);
  });
});

describe("peopleLabel", () => {
  it("declines the word for Russian numbers", () => {
    expect([0, 1, 2, 4, 5, 11, 12, 21, 22, 25, 101].map(peopleLabel)).toEqual([
      "пусто",
      "1 человек",
      "2 человека",
      "4 человека",
      "5 человек",
      "11 человек",
      "12 человек",
      "21 человек",
      "22 человека",
      "25 человек",
      "101 человек",
    ]);
  });
});

describe("channelStillExists", () => {
  it("is false once the channel you are in disappears", () => {
    const channels = [{ id: "general", name: "Общий" }];
    expect(channelStillExists(channels, "games")).toBe(false);
    expect(channelStillExists(channels, "general")).toBe(true);
    expect(channelStillExists(channels, null)).toBe(true);
  });
});

describe("moveChannel", () => {
  const list: ChannelDef[] = [
    { id: "general", name: "Общий" },
    { id: "meeting", name: "Встреча" },
    { id: "quiet", name: "Тихая комната" },
  ];

  it("moves a channel one place up or down", () => {
    expect(moveChannel(list, "meeting", -1).map((c) => c.id)).toEqual(["meeting", "general", "quiet"]);
    expect(moveChannel(list, "meeting", 1).map((c) => c.id)).toEqual(["general", "quiet", "meeting"]);
  });

  it("leaves the list as is at the edges or for an unknown channel", () => {
    expect(moveChannel(list, "general", -1)).toEqual(list);
    expect(moveChannel(list, "quiet", 1)).toEqual(list);
    expect(moveChannel(list, "nope", 1)).toEqual(list);
  });
});
