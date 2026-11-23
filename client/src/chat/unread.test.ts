// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { markRead, unreadCounts } from "./unread";

beforeEach(() => localStorage.clear());

describe("unread", () => {
  it("counts what came after the last read message, per channel", () => {
    const base = { general: [3, 5, 8], games: [4] };
    expect(unreadCounts("a:1", base)).toEqual({ general: 3, games: 1 });
    markRead("a:1", "general", 5);
    expect(unreadCounts("a:1", base)).toEqual({ general: 1, games: 1 });
    markRead("a:1", "games", 4);
    expect(unreadCounts("a:1", base)).toEqual({ general: 1 });
  });

  it("never moves the mark back and keeps servers apart", () => {
    markRead("a:1", "general", 8);
    markRead("a:1", "general", 3);
    expect(unreadCounts("a:1", { general: [5, 8, 9] })).toEqual({ general: 1 });
    expect(unreadCounts("b:2", { general: [5, 8, 9] })).toEqual({ general: 3 });
  });

  it("survives a reload and broken storage", () => {
    markRead("a:1", "general", 8);
    expect(JSON.parse(localStorage.getItem("hatavoice.chat.read") ?? "null")).toEqual({ "a:1": { general: 8 } });
    localStorage.setItem("hatavoice.chat.read", "{not json");
    expect(unreadCounts("a:1", { general: [1] })).toEqual({ general: 1 });
    localStorage.setItem("hatavoice.chat.read", JSON.stringify({ "a:1": { general: "x" }, "b:2": 7 }));
    expect(unreadCounts("a:1", { general: [1] })).toEqual({ general: 1 });
    markRead("a:1", "general", 2);
    expect(unreadCounts("a:1", { general: [1, 2, 3] })).toEqual({ general: 1 });
  });
});
