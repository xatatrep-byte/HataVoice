// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { RemoteAskDialog } from "../features/remote/RemoteHost";
import { ScreenTile, type ScreenControl } from "../features/stage/ScreenTile";
import type { ScreenView } from "../voice/screen";
import { encodeRemoteNote, fromB64, heardRemoteNote, parseRemoteNote, toB64 } from "./api";
import { useToasts } from "../ui/toasts";
import { PING_MS, useRemote } from "./useRemote";
import { ASK_TTL_MS } from "./askExpiry";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, _args?: unknown): Promise<unknown> => (command === "remote_seal" ? { to: "anna", packet: "AQL_" } : null)),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: (command: string, args: unknown) => mocks.invoke(command, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.invoke.mockClear();
});

const shared = (): ScreenView => ({ identity: "anna", isLocal: false, track: { attach: vi.fn(), detach: vi.fn() } as never, watching: true, hasAudio: false });
const volume = { volume: 1, muted: false };

function tile(control: ScreenControl) {
  const view = render(
    <ScreenTile screen={shared()} name="Аня" volume={volume} expanded={false} onExpand={() => {}} onVolumeChange={() => {}} onClose={() => {}} control={control} />,
  );
  const video = view.container.querySelector("video") as HTMLVideoElement;
  Object.defineProperty(video, "videoWidth", { value: 1920 });
  Object.defineProperty(video, "videoHeight", { value: 1080 });
  video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1920, height: 1080 }) as DOMRect;
  return { ...view, video };
}

describe("remote control in the window", () => {
  it("keeps our own pointer over the picture, as a ring that moves at once, and gives it back after", () => {
    const control = { state: "active" as const, keyboard: false, onAsk: vi.fn(), onRelease: vi.fn(), send: vi.fn() };
    const { video, unmount } = tile(control);
    expect(video.style.cursor).toContain("data:image/svg+xml");
    expect(video.style.cursor).not.toBe("none");
    unmount();
    expect(video.style.cursor).toBe("");
  });

  it("sends a move as soon as the mouse gives it, the newest only, at most one each 4 ms", () => {
    const send = vi.fn();
    const { video } = tile({ state: "active", keyboard: false, onAsk: vi.fn(), onRelease: vi.fn(), send });
    vi.useFakeTimers();
    // The page hears the mouse as it reports (`pointerrawupdate`), not once a frame.
    const move = (clientX: number, clientY: number) => fireEvent(video, new MouseEvent("pointerrawupdate", { clientX, clientY }));
    move(960, 540);
    expect(send.mock.calls, "the first goes at once, not on the next frame").toEqual([[{ t: "move", x: 32768, y: 32768 }, true]]);
    move(0, 0);
    move(1920, 1080);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4);
    expect(send.mock.calls[1]).toEqual([{ t: "move", x: 65535, y: 65535 }, true]);
    expect(send).toHaveBeenCalledTimes(2);
    // The ordinary move of the same mouse right after adds nothing over the limit; later it goes too.
    fireEvent.pointerMove(video, { clientX: 960, clientY: 540 });
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4);
    expect(send).toHaveBeenCalledTimes(3);
    // Over the bars around the picture there is nothing to send.
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 3000, height: 1080 }) as DOMRect;
    vi.advanceTimersByTime(10);
    move(10, 100);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("controls a phone from a PC: letters go as letters, other keys as keys, and the phone's own keys are buttons", () => {
    const send = vi.fn();
    const { video } = tile({ state: "active", keyboard: true, onAsk: vi.fn(), onRelease: vi.fn(), send, phone: true });
    fireEvent.keyDown(video, { key: "ж", code: "Semicolon" });
    fireEvent.keyUp(video, { key: "ж", code: "Semicolon" });
    fireEvent.keyDown(video, { key: "Backspace", code: "Backspace" });
    expect(send.mock.calls.map((c) => c[0])).toEqual([{ t: "text", s: "ж" }, { t: "key", code: "Backspace", down: true }]);
    send.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Домой" }));
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { t: "key", code: "AndroidBack", down: true },
      { t: "key", code: "AndroidBack", down: false },
      { t: "key", code: "AndroidHome", down: true },
      { t: "key", code: "AndroidHome", down: false },
    ]);
  });

  it("asks from someone's screen, and waits for the answer", () => {
    const onAsk = vi.fn();
    const control = { state: "idle" as const, keyboard: false, onAsk, onRelease: vi.fn(), send: vi.fn() };
    const { rerender } = tile(control);
    fireEvent.click(screen.getByRole("button", { name: "Попросить управление" }));
    expect(onAsk).toHaveBeenCalled();
    rerender(<ScreenTile screen={shared()} name="Аня" volume={volume} expanded={false} onExpand={() => {}} onVolumeChange={() => {}} onClose={() => {}} control={{ ...control, state: "waiting" }} />);
    // Waiting, the hourglass asks again: the one asked may have missed it, or closed the app.
    fireEvent.click(screen.getByRole("button", { name: /Ждём ответа на просьбу об управлении/ }));
    expect(onAsk).toHaveBeenCalledTimes(2);
  });

  it("in control, sends clicks to their place, and keys only with the keyboard allowed", () => {
    const send = vi.fn();
    const { video, rerender } = tile({ state: "active", keyboard: false, onAsk: vi.fn(), onRelease: vi.fn(), send });
    fireEvent.pointerDown(video, { button: 0, clientX: 960, clientY: 540 });
    expect(send.mock.calls).toEqual([
      [{ t: "move", x: 32768, y: 32768 }, false],
      [{ t: "button", b: "left", down: true }, false],
    ]);
    send.mockClear();
    fireEvent.keyDown(video, { code: "KeyA" });
    expect(send).not.toHaveBeenCalled();
    rerender(
      <ScreenTile
        screen={shared()}
        name="Аня"
        volume={volume}
        expanded={false}
        onExpand={() => {}}
        onVolumeChange={() => {}}
        onClose={() => {}}
        control={{ state: "active", keyboard: true, onAsk: vi.fn(), onRelease: vi.fn(), send }}
      />,
    );
    // The keyboard came: what was held (the left button) was let go of on the way.
    expect(send).toHaveBeenCalledWith({ t: "button", b: "left", down: false }, false);
    send.mockClear();
    fireEvent.keyDown(video, { code: "KeyA" });
    fireEvent.wheel(video, { deltaY: 100, deltaMode: 0 });
    expect(send.mock.calls).toEqual([
      [{ t: "key", code: "KeyA", down: true }, false],
      [{ t: "wheel", dx: 0, dy: -120 }, false],
    ]);
    send.mockClear();
    fireEvent.blur(video);
    expect(send).toHaveBeenCalledWith({ t: "key", code: "KeyA", down: false }, false);
    fireEvent.click(screen.getByRole("button", { name: "Отпустить управление" }));
  });

  it("the host lets in with or without the keyboard, and closing it says no", () => {
    const onAnswer = vi.fn();
    render(<RemoteAskDialog ask={{ address: "a", channel: "c", user: "boris", at: 0 }} name="Борис" sharing={false} onAnswer={onAnswer} />);
    expect(screen.getByText(/Сначала покажи весь экран/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Разрешить мышь и клавиатуру" }));
    fireEvent.click(screen.getByRole("button", { name: "Только мышь" }));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onAnswer.mock.calls).toEqual([
      [true, true, null],
      [true, false, null],
      [false, false, null],
    ]);
  });

  it("keeps the asks and the session, pings while in control, and stops when the screen goes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sendData = vi.fn(async () => {});
    const props = { address: "a", channel: "c", sharing: false, sharers: ["anna"], nameOf: (id: string) => id, sendData };
    const { result, rerender } = renderHook((p) => useRemote(p), { initialProps: props });
    await waitFor(() => expect(mocks.listeners.has("remote")).toBe(true));
    const hear = (payload: object) => act(() => mocks.listeners.get("remote")!({ payload }));
    hear({ kind: "asked", address: "a", channel: "c", user: "boris" });
    expect(result.current.asks.map((a) => a.user)).toEqual(["boris"]);
    act(() => result.current.ask("anna"));
    expect(mocks.invoke).toHaveBeenCalledWith("remote_ask", { address: "a", channel: "c", host: "anna" });
    expect(result.current.waiting).toBe("anna");
    hear({ kind: "started", address: "a", channel: "c", peer: "anna", host: false, keyboard: true });
    expect(result.current.session).toMatchObject({ peer: "anna", host: false, keyboard: true });
    expect(result.current.waiting).toBeNull();
    act(() => vi.advanceTimersByTime(PING_MS));
    expect(mocks.invoke).toHaveBeenCalledWith("remote_seal", { input: { t: "ping" }, lossy: false });
    // waitFor polls with setInterval, which is fake here: let the sealing settle first.
    await act(async () => {});
    expect(sendData).toHaveBeenCalledWith(fromB64("AQL_"), "anna", true);
    rerender({ ...props, sharers: [] });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("remote_stop", undefined));
  });

  it("a phone tells the PC whether its accessibility service is on, and the PC says why clicks reach nothing", async () => {
    const sendNote = vi.fn(async () => {});
    const phone = { address: "a", channel: "c", sharing: true, sharers: [], nameOf: (id: string) => id, sendData: vi.fn(async () => {}), sendNote, phoneReady: false };
    const host = renderHook((p) => useRemote(p), { initialProps: phone });
    await waitFor(() => expect(mocks.listeners.has("remote")).toBe(true));
    act(() => mocks.listeners.get("remote")!({ payload: { kind: "started", address: "a", channel: "c", peer: "pc", host: true, keyboard: true } }));
    expect(sendNote).toHaveBeenLastCalledWith({ t: "phone-control", ready: false }, "pc");
    host.rerender({ ...phone, phoneReady: true });
    expect(sendNote).toHaveBeenLastCalledWith({ t: "phone-control", ready: true }, "pc");
    host.unmount();

    useToasts.setState({ toasts: [] } as never);
    const pc = { address: "a", channel: "c", sharing: false, sharers: ["anna"], nameOf: (id: string) => (id === "anna" ? "Аня" : id), sendData: vi.fn(async () => {}) };
    renderHook((p) => useRemote(p), { initialProps: pc });
    await waitFor(() => expect(mocks.listeners.has("remote")).toBe(true));
    act(() => mocks.listeners.get("remote")!({ payload: { kind: "started", address: "a", channel: "c", peer: "anna", host: false, keyboard: true } }));
    const texts = () => (useToasts.getState() as unknown as { toasts: { text: string }[] }).toasts.map((x) => x.text);
    act(() => heardRemoteNote("boris", encodeRemoteNote({ t: "phone-control", ready: false })));
    expect(texts().some((x) => x.includes("Нажатия не доходят")), "only the phone we control is heard").toBe(false);
    act(() => heardRemoteNote("anna", encodeRemoteNote({ t: "phone-control", ready: false })));
    act(() => heardRemoteNote("anna", encodeRemoteNote({ t: "phone-control", ready: false })));
    expect(texts().filter((x) => x.includes("Нажатия не доходят") && x.includes("Аня"))).toHaveLength(1);
    act(() => heardRemoteNote("anna", encodeRemoteNote({ t: "phone-control", ready: true })));
    expect(texts().some((x) => x.includes("управление включено"))).toBe(true);
  });

  it("an unanswered ask ends after it stops holding: the PC may ask again, and the one asked no longer sees it", async () => {
    const props = { address: "a", channel: "c", sharing: true, sharers: ["anna"], nameOf: (id: string) => id, sendData: vi.fn(async () => {}) };
    const { result } = renderHook((p) => useRemote(p), { initialProps: props });
    await waitFor(() => expect(mocks.listeners.has("remote")).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    act(() => result.current.ask("anna"));
    act(() => mocks.listeners.get("remote")!({ payload: { kind: "asked", address: "a", channel: "c", user: "boris" } }));
    expect(result.current.waiting).toBe("anna");
    expect(result.current.asks.map((a) => a.user)).toEqual(["boris"]);
    act(() => vi.advanceTimersByTime(ASK_TTL_MS - 1000));
    expect(result.current.waiting, "still holding").toBe("anna");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.waiting).toBeNull();
    expect(result.current.asks).toEqual([]);
    act(() => result.current.ask("anna"));
    expect(result.current.waiting, "asked again").toBe("anna");
  });

  it("reads only well-formed notes", () => {
    expect(parseRemoteNote(encodeRemoteNote({ t: "phone-control", ready: true }))).toEqual({ t: "phone-control", ready: true });
    expect(parseRemoteNote(new TextEncoder().encode('{"t":"phone-control","ready":"yes"}'))).toBeNull();
    expect(parseRemoteNote(new TextEncoder().encode("not json"))).toBeNull();
    expect(parseRemoteNote(new Uint8Array(300))).toBeNull();
  });

  it("speaks Rust's base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(toB64(bytes)).toBe("AAEC-vv8_f7_");
    expect([...fromB64(toB64(bytes))]).toEqual([...bytes]);
  });
});
