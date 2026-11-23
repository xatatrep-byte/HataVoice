import { youtubeEmbed, type WatchLink } from "./links";

/** What a player in its frame said: where it is (ms), whether it plays, that it is ready, whether an advert runs. */
export type PlayerNews = { pos?: number; playing?: boolean; ready?: boolean; ad?: boolean };

/**
 * How to run one site's player in a frame: its address, what to post to it and how to read what it posts back.
 * No script of the site runs in the window; commands go to `origin` only, and only its answers are read.
 */
export type PlayerProtocol = {
  /** The site, as the note under the player names it. */
  name: string;
  origin: string;
  /** The frame's address; `start` (seconds) is used where the player takes it. */
  src: (start: number) => string;
  /** Said once the frame loaded, for players that need a word first. */
  hello: () => unknown;
  play: () => unknown;
  pause: () => unknown;
  seek: (ms: number) => unknown;
  /** What a message of the frame means at `now` (ms), or null when it says nothing about the video. */
  read: (data: unknown, now: number) => PlayerNews | null;
};

const YOUTUBE = "https://www.youtube-nocookie.com";
const RUTUBE = "https://rutube.ru";
const VK = "https://vkvideo.ru";
/** An advert that said nothing for this long is over, or stuck: the player is the viewer's again. */
const RUTUBE_AD_MS = 20_000;
const VK_AD_MS = 60_000;

function parsed(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value * 1000 : undefined);

function youtube(id: string, page: string): PlayerProtocol {
  const command = (func: string, args: unknown[] = []) => JSON.stringify({ event: "command", func, args });
  return {
    name: "YouTube",
    origin: YOUTUBE,
    src: (start) => `${youtubeEmbed(id, page)}&start=${Math.floor(start)}`,
    hello: () => JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
    play: () => command("playVideo"),
    pause: () => command("pauseVideo"),
    seek: (ms) => command("seekTo", [ms / 1000, true]),
    read: (data) => {
      const message = parsed(data);
      if (!message) return null;
      if (message.event === "onReady") return { ready: true };
      const info = message.info;
      const state = typeof info === "number" ? info : typeof info === "object" && info ? (info as { playerState?: unknown }).playerState : undefined;
      const news: PlayerNews = {};
      if (typeof info === "object" && info) news.pos = seconds((info as { currentTime?: unknown }).currentTime);
      // 1 plays, 2 is paused; buffering, cued and ended say nothing about what the viewer wants.
      if (state === 1) news.playing = true;
      if (state === 2) news.playing = false;
      return news;
    },
  };
}

function rutube(id: string): PlayerProtocol {
  const command = (type: string, data: object = {}) => JSON.stringify({ type, data });
  // Rutube plays an advert first, pausing around it by itself: those pauses are not the viewer's.
  let adUntil = 0;
  return {
    name: "Rutube",
    origin: RUTUBE,
    src: () => `${RUTUBE}/play/embed/${id}`,
    hello: () => null,
    play: () => command("player:play"),
    pause: () => command("player:pause"),
    seek: (ms) => command("player:setCurrentTime", { time: ms / 1000 }),
    read: (data, now) => {
      const message = parsed(data);
      if (!message || typeof message.type !== "string") return null;
      const body = (typeof message.data === "object" && message.data ? message.data : {}) as { time?: unknown; state?: unknown };
      switch (message.type) {
        case "player:ready":
          return { ready: true };
        case "player:currentTime":
          return { pos: seconds(body.time), ad: now < adUntil };
        case "player:playStart":
          adUntil = 0;
          return { ad: false };
        case "player:changeState":
          if (body.state === "advert") {
            adUntil = now + RUTUBE_AD_MS;
            return { ad: true };
          }
          if (body.state === "playing") {
            adUntil = 0;
            return { playing: true, ad: false };
          }
          if (now < adUntil) return { ad: true };
          return body.state === "pause" || body.state === "paused" ? { playing: false, ad: false } : { ad: false };
        default:
          return null;
      }
    },
  };
}

function vk(oid: string, id: string, hash: string | null): PlayerProtocol {
  let adUntil = 0;
  return {
    name: "VK Видео",
    origin: VK,
    src: () => `${VK}/video_ext.php?${new URLSearchParams({ oid, id, ...(hash ? { hash } : {}), js_api: "1" })}`,
    hello: () => ({ method: "init" }),
    play: () => ({ method: "play" }),
    pause: () => ({ method: "pause" }),
    seek: (ms) => ({ method: "seek", time: ms / 1000 }),
    read: (data, now) => {
      if (typeof data !== "object" || data === null) return null;
      const message = data as { event?: unknown; time?: unknown };
      if (typeof message.event !== "string") return null;
      const pos = seconds(message.time);
      if (message.event === "adStarted") adUntil = now + VK_AD_MS;
      if (message.event === "adCompleted") adUntil = 0;
      if (now < adUntil) return { ad: true, pos };
      const news: PlayerNews = { pos, ad: false };
      if (message.event === "inited") news.ready = true;
      if (message.event === "started" || message.event === "resumed") news.playing = true;
      if (message.event === "paused") news.playing = false;
      return news;
    },
  };
}

/** How to run the player of `link` in a frame of the page at `page`; null for a video file, which has its own element. */
export function playerProtocol(link: WatchLink, page: string): PlayerProtocol | null {
  switch (link.kind) {
    case "youtube":
      return youtube(link.id, page);
    case "rutube":
      return rutube(link.id);
    case "vk":
      return vk(link.oid, link.id, link.hash);
    case "file":
    case "page":
      return null;
  }
}
