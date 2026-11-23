import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./api";
import { notificationText, shouldNotify, Throttle, type NotifyMode } from "./notify";

const here = { address: "a:1", channel: "general" };

const decide = (mode: NotifyMode, over: Partial<Parameters<typeof shouldNotify>[0]> = {}) =>
  shouldNotify({ mode, mentionsMe: false, textChannel: true, focused: false, open: null, here, ...over });

describe("shouldNotify", () => {
  it("follows the mode when the window is away", () => {
    expect(decide("all")).toBe(true);
    expect(decide("all", { textChannel: false }), "a voice channel's chat only by mention").toBe(false);
    expect(decide("all", { textChannel: false, mentionsMe: true })).toBe(true);
    expect(decide("mentions")).toBe(false);
    expect(decide("mentions", { mentionsMe: true })).toBe(true);
    expect(decide("off", { mentionsMe: true })).toBe(false);
  });

  it("is quiet for the channel that is open in a focused window, and only for it", () => {
    expect(decide("all", { focused: true, open: here, mentionsMe: true })).toBe(false);
    expect(decide("all", { focused: true, open: { address: "a:1", channel: "games" } })).toBe(true);
    expect(decide("all", { focused: true, open: { address: "b:2", channel: "general" } })).toBe(true);
    expect(decide("all", { focused: false, open: here }), "minimized on that very channel").toBe(true);
  });
});

describe("Throttle", () => {
  it("lets one through every two seconds per channel and counts the rest", () => {
    const throttle = new Throttle();
    expect(throttle.take("a:1/general", 0)).toBe(0);
    expect(throttle.take("a:1/general", 500)).toBeNull();
    expect(throttle.take("a:1/general", 1500)).toBeNull();
    expect(throttle.take("a:1/games", 1600), "another channel").toBe(0);
    expect(throttle.take("a:1/general", 2100), "and two more were folded in").toBe(2);
    expect(throttle.take("a:1/general", 4200)).toBe(0);
  });
});

describe("notificationText", () => {
  const names = new Map([["u1", "Аня"], ["u2", "Боря"]]);
  const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    address: "a:1",
    channel: "general",
    id: "m1",
    author: "u1",
    text: "<@u2> глянь",
    files: [],
    mentions_me: true,
    poll: false,
    ...over,
  });

  it("names the author and the channel and shows mentions by nickname", () => {
    expect(notificationText(message(), { names, channel: "Общий", showText: true, more: 0 })).toEqual({ title: "Аня · #Общий", body: "@Боря глянь" });
  });

  it("says a direct message is one, without a channel", () => {
    expect(notificationText(message({ channel: "dm.u1.u2" }), { names, channel: null, showText: true, more: 0 }).title).toBe("Аня · личное сообщение");
  });

  it("hides the text when asked, and says what a file or a poll is", () => {
    expect(notificationText(message(), { names, channel: "Общий", showText: false, more: 0 }).body).toBe("Новое сообщение");
    expect(notificationText(message({ text: "", files: ["кот.gif", "a.pdf"] }), { names, channel: "Общий", showText: true, more: 0 }).body).toBe("📎 кот.gif, a.pdf");
    expect(notificationText(message({ text: "Идём?", poll: true }), { names, channel: "Общий", showText: true, more: 0 }).body).toBe("📊 Идём?");
  });

  it("cuts a long text, folds the ones skipped and knows nobody it can't name", () => {
    const long = notificationText(message({ text: "я".repeat(300), author: "u9" }), { names, channel: null, showText: true, more: 3 });
    expect(long.title).toBe("Кто-то · новое сообщение");
    expect(long.body.startsWith("я".repeat(119) + "…")).toBe(true);
    expect(long.body.endsWith("(и ещё 3)")).toBe(true);
  });
});
