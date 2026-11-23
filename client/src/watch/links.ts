/**
 * What a link plays: a video of YouTube, Rutube or VK Video (by its id, from `start` seconds), a video file, or any other
 * site («page»), opened in a window of its own where each picks the player and the dub; `stream` when the one who started
 * it shows that window to the others instead (the link then ends in `#hv-stream`).
 */
export type WatchLink =
  | { kind: "youtube"; id: string; start: number }
  | { kind: "rutube"; id: string; start: number }
  | { kind: "vk"; oid: string; id: string; hash: string | null; start: number }
  | { kind: "file"; url: string }
  | { kind: "page"; url: string; stream: boolean };

export const UNSUPPORTED = "Нужна ссылка на страницу с видео, которая начинается с https://";

/** The end of a link that is shown as a stream of the starter's window. */
const STREAM_MARK = "#hv-stream";

/** The link of a page, said as a stream of the starter's window or not. */
export function pageLink(url: string, stream: boolean): string {
  const plain = url.endsWith(STREAM_MARK) ? url.slice(0, -STREAM_MARK.length) : url;
  return stream ? plain.replace(/#.*$/, "") + STREAM_MARK : plain;
}

const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"];
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const RUTUBE_HOSTS = ["rutube.ru", "www.rutube.ru", "m.rutube.ru"];
const RUTUBE_ID = /^[0-9a-f]{32}$/;
const VK_HOSTS = ["vkvideo.ru", "www.vkvideo.ru", "m.vkvideo.ru", "vk.com", "www.vk.com", "m.vk.com", "vk.ru", "www.vk.ru", "m.vk.ru"];
/** `video-123_456` or `clip-123_456`, anywhere in the path or in `z=`: the owner and the video. */
const VK_VIDEO = /(?:^|\/|=)(?:video|clip)(-?\d+)_(\d+)(?:$|[/?&%])/;

/** `t=90`, `t=1m30s`, `start=90`: seconds. */
function seconds(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** What `text` plays, or null when it is not a link we can play together. */
export function parseWatchLink(text: string): WatchLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const start = seconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return VIDEO_ID.test(id) ? { kind: "youtube", id, start } : null;
  }
  if (YOUTUBE_HOSTS.includes(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[0] === "watch" ? url.searchParams.get("v") ?? "" : ["shorts", "live", "embed"].includes(parts[0] ?? "") ? parts[1] ?? "" : "";
    return VIDEO_ID.test(id) ? { kind: "youtube", id, start } : null;
  }
  if (RUTUBE_HOSTS.includes(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = ["video", "shorts"].includes(parts[0] ?? "") ? parts[1] : parts[0] === "play" && parts[1] === "embed" ? parts[2] : "";
    return id && RUTUBE_ID.test(id) ? { kind: "rutube", id, start } : page(url);
  }
  if (VK_HOSTS.includes(host)) return vkLink(url, start) ?? page(url);
  if (/\.(mp4|webm)$/i.test(url.pathname)) return { kind: "file", url: url.href };
  return page(url);
}

/** Any other site: opened in a window of its own; never the program's own addresses. */
function page(url: URL): WatchLink | null {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || !host.includes(".")) return null;
  const stream = url.hash === STREAM_MARK;
  const href = url.href;
  return { kind: "page", url: stream ? href.slice(0, -STREAM_MARK.length) : href, stream };
}

function vkLink(url: URL, start: number): WatchLink | null {
  if (url.pathname === "/video_ext.php") {
    const oid = url.searchParams.get("oid") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const hash = url.searchParams.get("hash");
    if (!/^-?\d+$/.test(oid) || !/^\d+$/.test(id) || (hash !== null && !/^[0-9a-zA-Z]+$/.test(hash))) return null;
    return { kind: "vk", oid, id, hash, start };
  }
  const m = VK_VIDEO.exec(url.pathname) ?? VK_VIDEO.exec(`=${url.searchParams.get("z") ?? ""}`);
  return m ? { kind: "vk", oid: m[1], id: m[2], hash: null, start } : null;
}

/** Where watching `url` together starts, ms: the time in the link (`t=`), or the beginning. */
export function startPosition(url: string): number {
  const link = parseWatchLink(url);
  return link && link.kind !== "file" && link.kind !== "page" ? link.start * 1000 : 0;
}

/** The player of a YouTube video, without YouTube's cookies, ready to be told what to do by messages. */
export function youtubeEmbed(id: string, origin: string): string {
  // fs=0: no full screen of its own (in the window its state got stuck: no way out, no way back); the call's is used.
  const query = new URLSearchParams({ enablejsapi: "1", autoplay: "1", playsinline: "1", rel: "0", fs: "0", origin });
  return `https://www.youtube-nocookie.com/embed/${id}?${query}`;
}

/** What to show as the title of a link. */
export function linkTitle(link: WatchLink): string {
  if (link.kind === "page") {
    try {
      return new URL(link.url).hostname.replace(/^www\./, "");
    } catch {
      return "Сайт";
    }
  }
  if (link.kind === "youtube") return "YouTube";
  if (link.kind === "rutube") return "Rutube";
  if (link.kind === "vk") return "VK Видео";
  try {
    const url = new URL(link.url);
    return decodeURIComponent(url.pathname.split("/").pop() ?? url.hostname);
  } catch {
    return "Видео";
  }
}
