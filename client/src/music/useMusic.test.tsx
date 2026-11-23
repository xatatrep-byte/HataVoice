// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useToasts } from "../ui/toasts";
import { fitText, MUSIC_POLL_MS, MUSIC_RESEND_MS, resendDue, sameTrack } from "./nowPlaying";
import { useMusic, type MusicProps } from "./useMusic";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  now: { title: "Ночной трамвай", artist: "Город спит", playing: true, cover: null as string | null },
  gone: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (command: string, args: unknown) => {
    if (command === "music_now") return mocks.gone ? Promise.reject("Программа с музыкой закрылась") : Promise.resolve({ ...mocks.now });
    return mocks.invoke(command, args);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("./cover", () => ({ coverToJpeg: async () => null }));

const sent = () => mocks.invoke.mock.calls.filter(([command]) => command === "chat_music").map(([, args]) => (args as { word: Record<string, unknown> }).word);

function props(over: Partial<MusicProps> = {}): MusicProps {
  return {
    address: "a",
    channel: "c",
    me: "me",
    nameOf: (id) => (id === "anna" ? "Аня" : id),
    participants: ["me", "anna"],
    players: [],
    musicOn: false,
    startMusic: vi.fn(async () => null),
    stopMusic: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => {
  mocks.invoke.mockClear();
  mocks.now = { title: "Ночной трамвай", artist: "Город спит", playing: true, cover: null };
  mocks.gone = false;
  useToasts.setState({ toasts: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("what is playing", () => {
  it("is the same track by title, artist and program", () => {
    const word = { on: true, take: false, title: "А", artist: "Б", app: "Spotify", cover: null };
    expect(sameTrack(word, { ...word })).toBe(true);
    expect(sameTrack(word, { ...word, title: "В" })).toBe(false);
    expect(sameTrack(null, word)).toBe(false);
    expect(resendDue(0, MUSIC_RESEND_MS - 1)).toBe(false);
    expect(resendDue(0, MUSIC_RESEND_MS)).toBe(true);
  });

  it("carries texts within Rust's limits, without control characters", () => {
    expect(fitText("я".repeat(250), 200)).toHaveLength(200);
    expect(fitText("a\nb", 200)).toBe("a b");
    expect(fitText("   ", 200)).toBeNull();
    expect(fitText(null, 200)).toBeNull();
  });
});

describe("music played together", () => {
  it("tells the call what plays: once per track, again a minute later, and when someone joins", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const start = props();
    const { result, rerender } = renderHook((p: MusicProps) => useMusic(p), { initialProps: start });
    await act(async () => void (await result.current.start({ pid: 7, name: "Яндекс Музыка", exe: "Яндекс Музыка.exe", level: 0.5, active: true })));
    expect(start.startMusic).toHaveBeenCalledWith(7);
    rerender({ ...start, musicOn: true, players: ["me"] });
    await act(async () => void (await vi.advanceTimersByTimeAsync(MUSIC_POLL_MS)));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ on: true, take: false, title: "Ночной трамвай", artist: "Город спит", app: "Яндекс Музыка" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(MUSIC_POLL_MS * 3)));
    expect(sent(), "the same track is not sent again").toHaveLength(1);
    mocks.now = { ...mocks.now, title: "Утро" };
    await act(async () => void (await vi.advanceTimersByTimeAsync(MUSIC_POLL_MS)));
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.title).toBe("Утро");
    await act(async () => void (await vi.advanceTimersByTimeAsync(MUSIC_RESEND_MS)));
    expect(sent().length, "again a minute later").toBeGreaterThanOrEqual(3);
    const before = sent().length;
    rerender({ ...start, musicOn: true, players: ["me"], participants: ["me", "anna", "boris"] });
    await act(async () => void (await vi.advanceTimersByTimeAsync(MUSIC_POLL_MS)));
    expect(sent().length, "a newcomer hears what plays").toBe(before + 1);
  });

  it("a player closed while it played stops the music for everyone, and says so", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const start = props();
    const { result, rerender } = renderHook((p: MusicProps) => useMusic(p), { initialProps: start });
    await act(async () => void (await result.current.start({ pid: 7, name: "Spotify", exe: "Spotify.exe", level: 0.5, active: true })));
    rerender({ ...start, musicOn: true, players: ["me"] });
    mocks.gone = true;
    await act(async () => void (await vi.advanceTimersByTimeAsync(MUSIC_POLL_MS)));
    expect(start.stopMusic).toHaveBeenCalled();
    expect(sent()[sent().length - 1]).toMatchObject({ on: false });
    const texts = (useToasts.getState() as unknown as { toasts: { text: string }[] }).toasts.map((t) => t.text);
    expect(texts.some((t) => t.includes("закрылась"))).toBe(true);
  });

  it("knows a closed player by the very words Rust says", async () => {
    const { MUSIC_GONE } = await import("./api");
    const rust = (await import("../../src-tauri/src/music.rs?raw")).default as string;
    expect(rust).toContain(`pub const MUSIC_GONE: &str = "${MUSIC_GONE}";`);
  });

  it("stopping tells the call", async () => {
    const p = props({ musicOn: true, players: ["me"] });
    const { result } = renderHook(() => useMusic(p));
    await act(async () => void (await result.current.stop()));
    expect(p.stopMusic).toHaveBeenCalled();
    expect(sent()[sent().length - 1]).toMatchObject({ on: false, take: false });
  });

  it("starting while a friend plays takes over: the friend's music stops there", async () => {
    const p = props({ players: ["anna"] });
    const { result } = renderHook(() => useMusic(p));
    await act(async () => void (await result.current.start({ pid: 3, name: "Spotify", exe: "Spotify.exe", level: 0.1, active: true })));
    expect(sent()[0]).toMatchObject({ take: true });
    expect(p.startMusic).toHaveBeenCalledWith(3);
  });

  it("another one taking over stops ours and says who", async () => {
    const p = props({ musicOn: true, players: ["me"] });
    renderHook(() => useMusic(p));
    await waitFor(() => expect(mocks.listeners.has("chat-music")).toBe(true));
    act(() => mocks.listeners.get("chat-music")!({ payload: { address: "a", channel: "c", user: "anna", on: false, take: true, title: null, artist: null, app: null, cover: null } }));
    await waitFor(() => expect(p.stopMusic).toHaveBeenCalled());
    const texts = (useToasts.getState() as unknown as { toasts: { text: string }[] }).toasts.map((t) => t.text);
    expect(texts.some((t) => t.includes("Аня"))).toBe(true);
  });

  it("shows a friend's music with what they say plays, only while their track is there", async () => {
    const p = props({ players: [] });
    const { result, rerender } = renderHook((q: MusicProps) => useMusic(q), { initialProps: p });
    await waitFor(() => expect(mocks.listeners.has("chat-music")).toBe(true));
    act(() => mocks.listeners.get("chat-music")!({ payload: { address: "a", channel: "c", user: "anna", on: true, take: false, title: "Утро", artist: "Лес", app: "Spotify", cover: null } }));
    expect(result.current.playing, "no track yet").toBeNull();
    rerender({ ...p, players: ["anna"] });
    expect(result.current.playing).toMatchObject({ identity: "anna", title: "Утро", app: "Spotify" });
    act(() => mocks.listeners.get("chat-music")!({ payload: { address: "x", channel: "c", user: "anna", on: true, take: false, title: "Чужое", artist: null, app: null, cover: null } }));
    expect(result.current.playing?.title, "another server's word is not ours").toBe("Утро");
    rerender({ ...p, players: [] });
    expect(result.current.playing).toBeNull();
  });
});
