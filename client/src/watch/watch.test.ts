import { describe, expect, it } from "vitest";
import { linkTitle, pageLink, parseWatchLink, startPosition, UNSUPPORTED, youtubeEmbed, type WatchLink } from "./links";
import { expectedPosition, needsSeek } from "./sync";

describe("links to watch together", () => {
  it("knows every shape of a YouTube link", () => {
    const id = "dQw4w9WgXcQ";
    for (const link of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&list=x`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube.com/embed/${id}`,
    ]) {
      expect(parseWatchLink(link), link).toEqual({ kind: "youtube", id, start: 0 });
    }
    expect(parseWatchLink(`https://youtu.be/${id}?t=90`)).toEqual({ kind: "youtube", id, start: 90 });
    expect(parseWatchLink(`https://www.youtube.com/watch?v=${id}&t=1m30s`)).toEqual({ kind: "youtube", id, start: 90 });
  });

  it("takes video files over https, and nothing else", () => {
    expect(parseWatchLink("https://files.example/фильм.mp4")).toEqual({ kind: "file", url: "https://files.example/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC.mp4" });
    expect(parseWatchLink("https://cdn.example/a/clip.WEBM?x=1")).toMatchObject({ kind: "file" });
    for (const bad of ["http://files.example/a.mp4", "https://www.youtube.com/watch?v=short", "javascript:alert(1)", "просто текст", "https://localhost/x", "https://tauri.localhost/"]) {
      expect(parseWatchLink(bad), bad).toBeNull();
    }
    expect(UNSUPPORTED).toContain("https://");
  });

  it("opens any other site in a window of its own, plainly or as the starter's stream", () => {
    expect(parseWatchLink("https://example.com/serial/rick-and-morty/7-3")).toEqual({ kind: "page", url: "https://example.com/serial/rick-and-morty/7-3", stream: false });
    expect(parseWatchLink("https://example.com/serial/7-3#hv-stream")).toEqual({ kind: "page", url: "https://example.com/serial/7-3", stream: true });
    expect(pageLink("https://example.com/a#player", true)).toBe("https://example.com/a#hv-stream");
    expect(pageLink("https://example.com/a#hv-stream", false)).toBe("https://example.com/a");
    expect(linkTitle({ kind: "page", url: "https://www.example.com/a", stream: false })).toBe("example.com");
  });

  it("knows Rutube links", () => {
    const id = "5e847ce59e3475e7e03043ee0afd6e57";
    for (const link of [
      `https://rutube.ru/video/${id}/`,
      `https://rutube.ru/video/${id}`,
      `https://www.rutube.ru/video/${id}/?r=wd`,
      `https://m.rutube.ru/video/${id}/`,
      `https://rutube.ru/shorts/${id}/`,
      `https://rutube.ru/play/embed/${id}`,
    ]) {
      expect(parseWatchLink(link), link).toEqual({ kind: "rutube", id, start: 0 });
    }
    expect(parseWatchLink(`https://rutube.ru/video/${id}/?t=125`)).toEqual({ kind: "rutube", id, start: 125 });
    // Not a Rutube video: another page of the site, or another site that only looks like it — opened as a page.
    for (const other of ["https://rutube.ru/video/abc/", "https://rutube.ru/channel/123/", `https://rutube.ru.evil.example/video/${id}/`]) {
      expect(parseWatchLink(other)?.kind, other).toBe("page");
    }
    expect(linkTitle({ kind: "rutube", id, start: 0 })).toBe("Rutube");
  });

  it("knows VK Video links, on vkvideo.ru and on VK itself", () => {
    const video = { kind: "vk", oid: "-26493942", id: "456416616", hash: null, start: 0 };
    for (const link of [
      "https://vkvideo.ru/video-26493942_456416616",
      "https://www.vkvideo.ru/video-26493942_456416616?list=ln-abc",
      "https://m.vkvideo.ru/video-26493942_456416616",
      "https://vk.com/video-26493942_456416616",
      "https://vk.ru/video-26493942_456416616",
      "https://m.vk.com/video-26493942_456416616",
      "https://vk.com/video?z=video-26493942_456416616%2Fpl_cat_trends",
      "https://vkvideo.ru/playlist/-26493942_1/video-26493942_456416616",
      "https://vkvideo.ru/clip-26493942_456416616",
    ]) {
      expect(parseWatchLink(link), link).toEqual(video);
    }
    expect(parseWatchLink("https://vk.com/video12345_678?t=1m5s")).toEqual({ kind: "vk", oid: "12345", id: "678", hash: null, start: 65 });
    expect(parseWatchLink("https://vk.com/video_ext.php?oid=-1&id=2&hash=ab12cd&hd=2")).toEqual({ kind: "vk", oid: "-1", id: "2", hash: "ab12cd", start: 0 });
    for (const other of ["https://vk.com/id1", "https://vk.com/video_ext.php?oid=x&id=2", "https://vk.com.evil.example/video-1_2", "https://vk.com/video_ext.php?oid=-1&id=2&hash=a%22b"]) {
      expect(parseWatchLink(other)?.kind, other).toBe("page");
    }
    expect(linkTitle(video as WatchLink)).toBe("VK Видео");
  });

  it("starts where the link says, in ms", () => {
    expect(startPosition("https://youtu.be/dQw4w9WgXcQ?t=90")).toBe(90_000);
    expect(startPosition("https://rutube.ru/video/5e847ce59e3475e7e03043ee0afd6e57/?t=300")).toBe(300_000);
    expect(startPosition("https://vk.com/video-1_2?t=1m5s")).toBe(65_000);
    expect(startPosition("https://youtu.be/dQw4w9WgXcQ")).toBe(0);
    expect(startPosition("https://files.example/film.mp4")).toBe(0);
    expect(startPosition("не ссылка")).toBe(0);
  });

  it("plays YouTube without its cookies, told what to do by messages", () => {
    const embed = new URL(youtubeEmbed("dQw4w9WgXcQ", "http://tauri.localhost"));
    expect(embed.origin).toBe("https://www.youtube-nocookie.com");
    expect(embed.pathname).toBe("/embed/dQw4w9WgXcQ");
    expect(embed.searchParams.get("enablejsapi")).toBe("1");
    expect(embed.searchParams.get("origin")).toBe("http://tauri.localhost");
    // Its own full screen got stuck in the window (no way out, no way back): the call's own one is used instead.
    expect(embed.searchParams.get("fs")).toBe("0");
    expect(linkTitle({ kind: "file", url: "https://f.example/%D1%84.mp4" })).toBe("ф.mp4");
  });
});

describe("keeping players in step", () => {
  const state = { url: "u", playing: true, pos: 10_000, at: 1_000_000, by: "a", picks: {} };

  it("a playing video has moved on by the time since the word; a paused one has not", () => {
    expect(expectedPosition(state, 1_003_000)).toBe(13_000);
    expect(expectedPosition({ ...state, playing: false }, 1_003_000)).toBe(10_000);
    expect(expectedPosition(state, 999_000), "a word from the future does not rewind").toBe(10_000);
  });

  it("only players more than 1.5 s apart are moved", () => {
    expect(needsSeek(12_000, 13_000)).toBe(false);
    expect(needsSeek(11_000, 13_000)).toBe(true);
    expect(needsSeek(15_000, 13_000)).toBe(true);
  });
});
