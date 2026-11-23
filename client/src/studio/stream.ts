import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadJson, saveJson } from "../state/persist";
import { useStreaming } from "../state/streamer";
import { toB64 } from "../remote/api";
import { studio, useStudio } from "./engine";
import type { StreamPacket } from "./protocol";

export type StreamService = "twitch" | "youtube" | "tiktok" | "vk" | "rutube" | "kick" | "trovo" | "facebook" | "custom" | "custom2";

export type ServiceInfo = {
  id: StreamService;
  name: string;
  /** Where it takes streams, where that does not change; empty: the service gives the address with the key. */
  url: string;
  /** What it says about bitrate and frame, for the person choosing. */
  advice: string;
  /** Where the key is found. */
  keyFrom: string;
  /** A tall frame suits it best. */
  vertical?: boolean;
  /** The most video it takes, kbit/s: above it viewers who get the stream as sent keep buffering. */
  maxKbps?: number;
};

export const SERVICES: ServiceInfo[] = [
  { id: "twitch", name: "Twitch", url: "rtmps://live.twitch.tv:443/app", advice: "1080p60 до 6000 кбит/с, ключевой кадр раз в 2 с", keyFrom: "Панель автора → Настройки → Трансляция", maxKbps: 6000 },
  { id: "youtube", name: "YouTube", url: "rtmps://a.rtmps.youtube.com:443/live2", advice: "1080p60 до 12000 кбит/с, 1440p до 24000, 4K до 45000", keyFrom: "Творческая студия → Начать трансляцию", maxKbps: 45000 },
  { id: "tiktok", name: "TikTok", url: "", advice: "Вертикальный 1080×1920, 30–60 к/с, 4000–6000 кбит/с", keyFrom: "TikTok LIVE Studio или ключ от TikTok: там и адрес, и ключ", vertical: true, maxKbps: 6000 },
  { id: "vk", name: "VK Видео", url: "rtmp://ovsu.okcdn.ru/input/", advice: "1080p60 до 8000 кбит/с", keyFrom: "VK Видео → Начать трансляцию", maxKbps: 8000 },
  { id: "rutube", name: "Rutube", url: "", advice: "1080p до 8000 кбит/с", keyFrom: "Rutube Студия → Трансляции: там и адрес, и ключ", maxKbps: 8000 },
  { id: "kick", name: "Kick", url: "", advice: "1080p60 до 8000 кбит/с", keyFrom: "Настройки канала → Stream URL и Stream Key", maxKbps: 8000 },
  { id: "trovo", name: "Trovo", url: "rtmp://livepush.trovo.live/live/", advice: "1080p60 до 9000 кбит/с", keyFrom: "Панель автора Trovo", maxKbps: 9000 },
  { id: "facebook", name: "Facebook", url: "rtmps://live-api-s.facebook.com:443/rtmp/", advice: "1080p60 до 9000 кбит/с", keyFrom: "Facebook Live Producer", maxKbps: 9000 },
  { id: "custom", name: "Свой сервер", url: "", advice: "Любой адрес rtmp:// или rtmps://", keyFrom: "У владельца сервера" },
  { id: "custom2", name: "Ещё один сервер", url: "", advice: "Любой адрес rtmp:// или rtmps://", keyFrom: "У владельца сервера" },
];

/**
 * The place that takes the least video among those chosen, when the stream sends more than it takes: one picture goes
 * to all of them, so the strictest decides. Null when every chosen place takes it.
 */
export function tightestPlace(destinations: Destination[], kbps: number): { name: string; max: number } | null {
  let tightest: { name: string; max: number } | null = null;
  for (const d of destinations) {
    const max = d.on ? serviceInfo(d.service).maxKbps : undefined;
    if (max !== undefined && kbps > max && (!tightest || max < tightest.max)) tightest = { name: serviceInfo(d.service).name, max };
  }
  return tightest;
}

export function serviceInfo(id: StreamService): ServiceInfo {
  return SERVICES.find((s) => s.id === id)!;
}

/** What Rust says of one destination (`stream`). */
export type StreamStatus =
  | { status: "off"; error?: string | null }
  | { status: "connecting" }
  | { status: "live"; kbps: number }
  | { status: "reconnecting"; error: string };

export type Destination = { service: StreamService; on: boolean; url: string };

type StreamStore = {
  destinations: Destination[];
  /** A key is saved for these services (the key itself never comes back). */
  saved: Partial<Record<StreamService, boolean>>;
  states: Partial<Record<StreamService, StreamStatus>>;
  since: number | null;
  error: string | null;
};

const DESTINATIONS_KEY = "hatavoice.studio.destinations";

function loadDestinations(): Destination[] {
  const raw = loadJson(DESTINATIONS_KEY);
  const known = Array.isArray(raw) ? raw : [];
  return SERVICES.map((s) => {
    const stored = known.find((d) => d?.service === s.id) as Partial<Destination> | undefined;
    return { service: s.id, on: stored?.on === true, url: typeof stored?.url === "string" && stored.url ? stored.url : s.url };
  });
}

export const useStream = create<StreamStore>(() => ({ destinations: loadDestinations(), saved: {}, states: {}, since: null, error: null }));

useStream.subscribe((s) => saveJson(DESTINATIONS_KEY, s.destinations));

/** Whether the stream runs anywhere. */
export function isLive(states: StreamStore["states"]): boolean {
  return Object.values(states).some((state) => state && state.status !== "off");
}

let queue: Promise<unknown> = Promise.resolve();

/** One packet of the encoders to Rust, in order. */
function sendPacket(packet: StreamPacket) {
  const headers: Record<string, string> = { "x-kind": packet.kind, "x-ts": String(Math.max(0, Math.round(packet.timestamp))), "x-key": packet.key ? "1" : "0" };
  if (packet.config) headers["x-config"] = toB64(packet.config);
  queue = queue.then(() => invoke("stream_packet", packet.data, { headers })).catch(() => {});
}

let listening = false;
function listenOnce() {
  if (listening || !isTauri()) return;
  listening = true;
  void listen<StreamStatus & { service: StreamService }>("stream", ({ payload }) => {
    useStream.setState((s) => {
      const states = { ...s.states, [payload.service]: payload };
      const live = isLive(states);
      useStreaming.getState().setStudio(live);
      if (!live) studio.setPacketSink(null);
      return {
        states,
        since: live ? (s.since ?? Date.now()) : null,
        error: payload.status === "off" && payload.error ? `${serviceInfo(payload.service).name}: ${payload.error}` : s.error,
      };
    });
  });
}

export const streaming = {
  async refreshSaved() {
    listenOnce();
    const entries = await Promise.all(SERVICES.map(async (s) => [s.id, await invoke<boolean>("stream_key_has", { service: s.id }).catch(() => false)] as const));
    useStream.setState({ saved: Object.fromEntries(entries) });
  },

  async saveKey(service: StreamService, key: string) {
    await invoke("stream_key_set", { service, key });
    await streaming.refreshSaved();
  },

  async forgetKey(service: StreamService) {
    await invoke("stream_key_forget", { service });
    await streaming.refreshSaved();
  },

  setDestination(service: StreamService, change: Partial<Destination>) {
    useStream.setState((s) => ({ destinations: s.destinations.map((d) => (d.service === service ? { ...d, ...change } : d)) }));
  },

  /** Starts the stream on every destination that is on and has a key. */
  async start() {
    listenOnce();
    const { destinations, saved } = useStream.getState();
    const going = destinations.filter((d) => d.on && saved[d.service]);
    if (going.length === 0) {
      useStream.setState({ error: "Отметь площадку и сохрани её ключ" });
      return;
    }
    const output = useStudio.getState().output;
    const connecting = Object.fromEntries(going.map((d) => [d.service, { status: "connecting" } as StreamStatus]));
    useStream.setState({ error: null, states: connecting, since: Date.now() });
    try {
      await invoke("stream_start", {
        destinations: going.map((d) => ({ service: d.service, url: d.url.trim() })),
        width: output.width,
        height: output.height,
        fps: output.fps,
        kbps: output.kbps,
        audioKbps: output.audioKbps,
        av1: output.codec === "av1",
      });
      studio.setPacketSink(sendPacket);
    } catch (e) {
      useStream.setState({ error: String(e), states: {}, since: null });
    }
  },

  stop() {
    studio.setPacketSink(null);
    void invoke("stream_stop").catch(() => {});
  },
};
