import { describe, expect, it } from "vitest";
import tauriConf from "../../src-tauri/tauri.conf.json";
import { parseWatchLink, type WatchLink } from "./links";
import { playerProtocol } from "./players";

const PAGE = "http://tauri.localhost";
const protocol = (url: string) => playerProtocol(parseWatchLink(url) as WatchLink, PAGE)!;
const youtube = () => protocol("https://youtu.be/dQw4w9WgXcQ");
const rutube = () => protocol("https://rutube.ru/video/5e847ce59e3475e7e03043ee0afd6e57/");
const vk = () => protocol("https://vkvideo.ru/video-26493942_456416616");

describe("the players in frames", () => {
  it("a video file has its own element, not a frame", () => {
    expect(playerProtocol({ kind: "file", url: "https://f.example/a.mp4" }, PAGE)).toBeNull();
  });

  it("YouTube: no cookies, the start in the address, commands as its widget wants them", () => {
    const p = youtube();
    expect(p.origin).toBe("https://www.youtube-nocookie.com");
    const src = new URL(p.src(42));
    expect(src.pathname).toBe("/embed/dQw4w9WgXcQ");
    expect(src.searchParams.get("start")).toBe("42");
    expect(src.searchParams.get("origin")).toBe(PAGE);
    expect(JSON.parse(p.hello() as string)).toEqual({ event: "listening", id: 1, channel: "widget" });
    expect(JSON.parse(p.seek(90_500) as string)).toEqual({ event: "command", func: "seekTo", args: [90.5, true] });
    expect(JSON.parse(p.play() as string)).toMatchObject({ func: "playVideo" });
    expect(JSON.parse(p.pause() as string)).toMatchObject({ func: "pauseVideo" });
  });

  it("YouTube: reads its time, its state and that it is ready", () => {
    const p = youtube();
    expect(p.read(JSON.stringify({ event: "onReady" }), 0)).toMatchObject({ ready: true });
    expect(p.read(JSON.stringify({ event: "infoDelivery", info: { currentTime: 12.5, playerState: 1 } }), 0)).toMatchObject({ pos: 12_500, playing: true });
    expect(p.read(JSON.stringify({ event: "onStateChange", info: 2 }), 0)).toMatchObject({ playing: false });
    expect(p.read(JSON.stringify({ event: "onStateChange", info: 3 }), 0)?.playing, "buffering says nothing").toBeUndefined();
    expect(p.read("not json", 0)).toBeNull();
    expect(p.read({ event: "onReady" }, 0), "YouTube speaks in strings").toBeNull();
  });

  it("Rutube: its own embed, seeked after it is ready since it ignores a start in the address", () => {
    const p = rutube();
    expect(p.origin).toBe("https://rutube.ru");
    expect(p.src(42)).toBe("https://rutube.ru/play/embed/5e847ce59e3475e7e03043ee0afd6e57");
    expect(p.hello()).toBeNull();
    expect(JSON.parse(p.seek(120_000) as string)).toEqual({ type: "player:setCurrentTime", data: { time: 120 } });
    expect(JSON.parse(p.play() as string)).toEqual({ type: "player:play", data: {} });
    expect(JSON.parse(p.pause() as string)).toEqual({ type: "player:pause", data: {} });
    const say = (type: string, data: object, now = 0) => p.read(JSON.stringify({ type, data }), now);
    expect(say("player:ready", { videoId: "x" })).toMatchObject({ ready: true });
    expect(say("player:currentTime", { time: 0.9 })).toMatchObject({ pos: 900 });
    expect(say("player:changeState", { state: "playing", isPlaying: true })).toMatchObject({ playing: true, ad: false });
    expect(say("player:changeState", { state: "pause", isPlaying: false })).toMatchObject({ playing: false, ad: false });
    expect(say("player:changeState", { state: "seeking" })?.playing).toBeUndefined();
  });

  it("Rutube: the pauses around an advert are not the viewer's, and a stuck advert lets go", () => {
    const p = rutube();
    const state = (s: string, now: number) => p.read(JSON.stringify({ type: "player:changeState", data: { state: s } }), now);
    expect(state("advert", 1_000)).toEqual({ ad: true });
    expect(state("pause", 1_010)).toEqual({ ad: true });
    expect(state("advert", 3_000)).toEqual({ ad: true });
    expect(state("playing", 8_000)).toEqual({ playing: true, ad: false });
    expect(state("pause", 9_000), "a pause after the film started is the viewer's").toEqual({ playing: false, ad: false });
    state("advert", 10_000);
    expect(state("pause", 31_000), "20 s after the last advert word").toEqual({ playing: false, ad: false });
  });

  it("VK Video: its embed with the API on, commands as objects", () => {
    const p = vk();
    expect(p.origin).toBe("https://vkvideo.ru");
    expect(p.src(42)).toBe("https://vkvideo.ru/video_ext.php?oid=-26493942&id=456416616&js_api=1");
    expect(new URL(protocol("https://vk.com/video_ext.php?oid=-1&id=2&hash=ab12").src(0)).searchParams.get("hash")).toBe("ab12");
    expect(p.hello()).toEqual({ method: "init" });
    expect(p.seek(120_000)).toEqual({ method: "seek", time: 120 });
    expect(p.play()).toEqual({ method: "play" });
    expect(p.pause()).toEqual({ method: "pause" });
  });

  it("VK Video: reads what it says, and keeps quiet during its adverts", () => {
    const p = vk();
    const say = (event: string, data: object = {}, now = 0) => p.read({ event, state: "unstarted", time: 0, ...data }, now);
    expect(say("inited", { time: 0 })).toMatchObject({ ready: true, pos: 0 });
    expect(say("started", { state: "playing", time: 0.2 })).toMatchObject({ playing: true, pos: 200, ad: false });
    expect(say("timeupdate", { state: "playing", time: 120 })).toMatchObject({ pos: 120_000 });
    expect(say("paused", { state: "paused", time: 122.5 })).toMatchObject({ playing: false, pos: 122_500 });
    expect(say("adStarted", {}, 1_000)).toEqual({ ad: true, pos: 0 });
    expect(say("paused", { state: "paused" }, 2_000)).toEqual({ ad: true, pos: 0 });
    expect(say("adCompleted", {}, 9_000)).toMatchObject({ ad: false });
    expect(p.read("a string", 0)).toBeNull();
    expect(p.read({ nothing: true }, 0)).toBeNull();
  });

  it("every site a frame comes from is allowed in the window's CSP, and nothing else is", () => {
    const csp: string = tauriConf.app.security.csp;
    const frameSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src "))!.split(/\s+/).slice(1);
    const origins = [youtube(), rutube(), vk()].map((p) => p.origin);
    expect(frameSrc.sort()).toEqual([...origins].sort());
    for (const p of [youtube(), rutube(), vk()]) expect(new URL(p.src(0)).origin).toBe(p.origin);
  });
});
