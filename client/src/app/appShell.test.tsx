// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChannelView } from "../server/session";
import { channel, serverState } from "../server/testState";
import { usePrefs } from "../state/prefs";
import { useServers } from "../state/servers";
import { useToasts } from "../ui/toasts";
import { NO_CALL, type CallSecurity } from "../voice/callSecurity";
import type { ParticipantView } from "../voice/participants";
import { AppShell } from "./AppShell";

const mocks = vi.hoisted(() => ({
  voice: {} as Record<string, unknown>,
  channels: [] as ChannelView[],
  refresh: vi.fn(async () => {}),
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  startUrls: null as string[] | null,
  onOpenUrl: null as ((urls: string[]) => void) | null,
  tauri: false,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.tauri, invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: async () => mocks.startUrls,
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    mocks.onOpenUrl = handler;
    return () => {};
  },
}));

// What every call has, even when a test leaves it out: no screens, nothing sent.
const VOICE_BASE = { screens: [], sharing: false, sendRemote: async () => {}, lowLatency: () => {}, participants: [], musicPlayers: [], musicOn: false, startMusic: async () => null, stopMusic: async () => {}, musicTrackOf: () => null };
vi.mock("../voice/useVoice", () => ({ useVoice: () => ({ ...VOICE_BASE, ...mocks.voice }) }));
vi.mock("../features/channels/useServerState", () => ({
  useServerState: () => ({ state: serverState({ channels: mocks.channels }), offline: false, error: null, clockOffset: 0, refresh: mocks.refresh }),
}));
vi.mock("../host/useHost", () => ({
  hostingSupported: false,
  useHost: () => ({ view: { config: null, running: false, crash: null, status: null }, busy: false, error: null }),
}));
// The real loopback loads the noise-suppression worklet, which jsdom does not have.
vi.mock("../audio/useMicLoopback", () => ({ useMicLoopback: () => ({ error: null }) }));
vi.mock("../audio/usePtt", () => ({
  pttSupported: false,
  pttPhone: false,
  pttAvailable: false,
  phoneKeyLabel: (key: string | null) => key ?? "Не назначена",
  usePtt: () => ({ open: false, error: null, capturing: false, startCapture: vi.fn(), cancelCapture: vi.fn(), press: vi.fn(), release: vi.fn() }),
}));

const SECURE: CallSecurity = { state: "secure", code: "12345 67890 00042 99999 01234 55555", members: ["me00"], error: null };

function connectedVoice(channelId: string, leave: () => Promise<void>) {
  mocks.voice = {
    status: "connected",
    error: null,
    address: "a:1",
    channelId,
    participants: [],
    micOn: true,
    deafened: false,
    transmitting: false,
    micLevel: 0,
    security: SECURE,
    retryEncryption: vi.fn(async () => {}),
    inputs: [],
    outputs: [],
    join: vi.fn(),
    // Like the real hook: leaving ends the call state.
    leave: vi.fn(async () => {
      await leave();
      mocks.voice = { ...mocks.voice, status: "idle", channelId: null, address: null };
    }),
    toggleMic: vi.fn(),
    toggleDeafen: vi.fn(),
    selectOutput: vi.fn(),
  };
}

beforeEach(() => {
  usePrefs.setState({ onboarded: true, nickname: "Петя", color: "blue" });
  useServers.setState({
    servers: [
      { address: "a:1", name: "Хата", color: "blue" },
      { address: "b:1", name: "Работа", color: "green" },
    ],
    selected: "a:1",
  });
  useToasts.setState({ toasts: [] });
  mocks.channels = [channel("general", "Общий"), channel("games", "Игры")];
});
afterEach(cleanup);

const LINK = "hatavoice://198.51.100.4:7350/#v=1&sk=SK&inv=SECRET";
const preview = {
  address: "198.51.100.4:7350",
  server_name: "Берлога",
  description: "",
  welcome: "Заходи!",
  icon: null,
  inviter_name: "Аня",
  inviter_fingerprint: "a1b2",
  valid: true,
};

vi.stubGlobal("RTCPeerConnection", class {});

describe("AppShell", () => {
  it("a move while not in a call does not open the mic", async () => {
    mocks.voice = { status: "idle", error: null, address: null, channelId: null, participants: [], micOn: true, deafened: false, transmitting: false, micLevel: 0, security: NO_CALL, retryEncryption: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMic: vi.fn(), toggleDeafen: vi.fn() };
    render(<AppShell />);
    await waitFor(() => expect(mocks.listeners.has("server-event")).toBe(true));
    act(() => mocks.listeners.get("server-event")!({ payload: { address: "a:1", event: { type: "moved", channel: "games", by: "x" } } }));
    expect(mocks.voice.join).not.toHaveBeenCalled();
  });

  it("a move during a call on this server switches the channel", async () => {
    connectedVoice("general", async () => {});
    render(<AppShell />);
    await waitFor(() => expect(mocks.listeners.has("server-event")).toBe(true));
    act(() => mocks.listeners.get("server-event")!({ payload: { address: "a:1", event: { type: "moved", channel: "games", by: "x" } } }));
    expect(mocks.voice.join).toHaveBeenCalledWith({ address: "a:1", channelId: "games" });
  });

  it("an identity that could not be decrypted is reported at start", async () => {
    mocks.tauri = true;
    mocks.voice = { status: "idle", error: null, address: null, channelId: null, participants: [], micOn: true, deafened: false, transmitting: false, micLevel: 0, security: NO_CALL, retryEncryption: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMic: vi.fn(), toggleDeafen: vi.fn() };
    mocks.invoke.mockImplementation(async (command: unknown) =>
      command === "identity_info" ? { user_id: "k7q3x", fingerprint: "k7q3", lost_previous: true } : null,
    );
    render(<AppShell />);
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.text)).toContain(
        "Личность на этом ПК не прочиталась: Windows переустановили или сбросили пароль. Создана новая. Если есть копия .hvid, загрузи её в разделе «Профиль»",
      ),
    );
    mocks.tauri = false;
  });

  it("an invite link opened from the browser lands on the join screen", async () => {
    mocks.voice = { status: "idle", error: null, address: null, channelId: null, participants: [], micOn: true, deafened: false, transmitting: false, micLevel: 0, security: NO_CALL, retryEncryption: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMic: vi.fn(), toggleDeafen: vi.fn() };
    mocks.invoke.mockImplementation(async (command: unknown) => (command === "invite_preview" ? preview : null));
    render(<AppShell />);
    await waitFor(() => expect(mocks.onOpenUrl).not.toBeNull());
    act(() => mocks.onOpenUrl!([LINK]));
    expect(await screen.findByText("Заходи!")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("invite_preview", { link: LINK });
  });

  it("the link that started the app opens the join screen too", async () => {
    mocks.voice = { status: "idle", error: null, address: null, channelId: null, participants: [], micOn: true, deafened: false, transmitting: false, micLevel: 0, security: NO_CALL, retryEncryption: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMic: vi.fn(), toggleDeafen: vi.fn() };
    mocks.startUrls = [LINK];
    mocks.invoke.mockImplementation(async (command: unknown) => (command === "invite_preview" ? preview : null));
    render(<AppShell />);
    expect(await screen.findByText("Заходи!")).toBeTruthy();
    mocks.startUrls = null;
  });

  it("leaves the current channel before switching to another server", async () => {
    const selectedWhenLeaving: (string | null)[] = [];
    connectedVoice("general", async () => {
      selectedWhenLeaving.push(useServers.getState().selected);
    });
    render(<AppShell />);

    fireEvent.click(screen.getByRole("button", { name: "Меню сервера" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Работа/ }));

    await waitFor(() => expect(useServers.getState().selected).toBe("b:1"));
    expect(selectedWhenLeaving).toEqual(["a:1"]);
  });

  it("leaves and explains when someone deletes your channel", async () => {
    const leave = vi.fn(async () => {});
    connectedVoice("games", leave);
    const { rerender } = render(<AppShell />);
    expect(leave).not.toHaveBeenCalled();

    mocks.channels = [channel("general", "Общий")];
    rerender(<AppShell />);

    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("Комната удалена");
  });

  it("ends the call when another server is opened from anywhere else", async () => {
    const leave = vi.fn(async () => {});
    connectedVoice("general", leave);
    render(<AppShell />);

    mocks.channels = [channel("work", "Задачи")];
    act(() => useServers.getState().select("b:1"));

    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(useToasts.getState().toasts.map((t) => t.text)).not.toContain("Комната удалена");
  });

  it("asks the server who is where as soon as you leave a channel", async () => {
    connectedVoice("general", async () => {});
    const { rerender } = render(<AppShell />);
    mocks.refresh.mockClear();

    mocks.voice = { ...mocks.voice, status: "idle", channelId: null, address: null };
    rerender(<AppShell />);

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  describe("the encryption of the call", () => {
    const view = (identity: string, name: string, over: Partial<ParticipantView> = {}): ParticipantView => ({
      identity,
      name,
      speaking: false,
      muted: false,
      isLocal: false,
      quality: "good",
      level: 0,
      deafened: false,
      color: "blue",
      encrypted: true,
      ...over,
    });
    const inCall = (security: CallSecurity, participants: ParticipantView[] = []) => {
      connectedVoice("general", async () => {});
      mocks.voice = { ...mocks.voice, security, participants };
    };

    it("puts the lock in the call's head, and its retry starts the encryption again", () => {
      inCall({ state: "failed", code: null, members: [], error: "Не удалось зашифровать звонок" });
      render(<AppShell />);
      fireEvent.click(screen.getByRole("button", { name: "Не удалось зашифровать" }));
      fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
      expect(mocks.voice.retryEncryption).toHaveBeenCalledTimes(1);
    });

    it("names the people of the encrypted group from the journal", () => {
      inCall({ ...SECURE, members: ["me00", "a000"] });
      render(<AppShell />);
      fireEvent.click(screen.getByRole("button", { name: "Звонок зашифрован" }));
      // The test server knows «me00» (Петя) and not «a000»: that one shows its fingerprint alone.
      const rows = within(screen.getByRole("list", { name: "В зашифрованной группе" })).getAllByRole("listitem");
      expect(rows.map((row) => row.textContent)).toEqual(["Петя · me00", "a000"]);
    });

    it("marks a person outside the encryption on the stage and in the whole house", () => {
      inCall(SECURE, [view("me00", "Петя", { isLocal: true }), view("x000", "Гость", { encrypted: false })]);
      render(<AppShell />);
      expect(screen.getAllByText("не в шифровании")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "На главную" }));
      expect(screen.getAllByText("не в шифровании")).toHaveLength(1);
    });

    it("marks nobody and holds the mic while the keys are on their way", () => {
      inCall({ ...NO_CALL, state: "pending" }, [view("me00", "Петя", { isLocal: true }), view("x000", "Гость", { encrypted: false })]);
      render(<AppShell />);
      expect(screen.queryByText("не в шифровании")).toBeNull();
      expect((screen.getByRole("button", { name: "Ждём ключи шифрования" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });
  describe("the pages", () => {
    const idle = () => ({ status: "idle", error: null, address: null, channelId: null, participants: [], micOn: true, deafened: false, transmitting: false, micLevel: 0, security: NO_CALL, retryEncryption: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMic: vi.fn(), toggleDeafen: vi.fn() });

    it("the house opens first, with no tabs and no call's tools; the mic and the sound are behind our face", () => {
      mocks.voice = idle();
      render(<AppShell />);
      expect(screen.getByRole("button", { name: /Общий/ })).toBeTruthy();
      expect(screen.queryByRole("navigation")).toBeNull();
      expect(screen.queryByRole("button", { name: "Выйти из комнаты" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Мой профиль" }));
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Микрофон" }));
      expect(mocks.voice.toggleMic).toHaveBeenCalledTimes(1);
    });

    it("finishing the first-run steps opens the house", () => {
      mocks.voice = idle();
      usePrefs.setState({ onboarded: false });
      render(<AppShell />);
      expect(screen.queryByRole("button", { name: "На главную" })).toBeNull();
      act(() => usePrefs.getState().finishOnboarding());
      expect(screen.getByRole("button", { name: "На главную" })).toBeTruthy();
    });

    it("Ctrl+, opens the settings", () => {
      mocks.voice = idle();
      render(<AppShell />);
      fireEvent.keyDown(document, { key: ",", ctrlKey: true });
      expect(screen.getByRole("dialog", { name: "Настройки" })).toBeTruthy();
    });

    it("getting into a call shows its stage; home keeps the call in a small panel that leads back", () => {
      connectedVoice("general", async () => {});
      render(<AppShell />);
      expect(document.querySelector(".call-card")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Выйти из комнаты" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "На главную" }));
      expect(document.querySelector(".call-card")).toBeNull();
      expect(screen.getByRole("button", { name: "Выйти из комнаты" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Комната «Общий»" }));
      expect(document.querySelector(".call-card")).toBeTruthy();
    });

    it("the room's name lists the other rooms and leads to the whole house", () => {
      connectedVoice("general", async () => {});
      render(<AppShell />);
      fireEvent.click(screen.getByRole("button", { name: "Комната «Общий»: другие комнаты" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Игры/ }));
      expect(mocks.voice.join).toHaveBeenCalledWith({ address: "a:1", channelId: "games" });
      fireEvent.click(screen.getByRole("button", { name: "Комната «Общий»: другие комнаты" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Весь сервер" }));
      expect(document.querySelector(".mini-call")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Комната «Общий»" }));
      expect(document.querySelector(".call-card")).toBeTruthy();
      expect(document.querySelector(".mini-call")).toBeNull();
    });

    it("Ctrl+K finds a room by a few letters and goes in", () => {
      mocks.voice = idle();
      render(<AppShell />);
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
      const field = screen.getByRole("textbox", { name: "Что найти" });
      fireEvent.change(field, { target: { value: "игр" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(mocks.voice.join).toHaveBeenCalledWith({ address: "a:1", channelId: "games" });
      expect(screen.queryByRole("textbox", { name: "Что найти" })).toBeNull();
    });
  });

  describe("the chat", () => {
    it("«Чаты» opens the panel; a chat opens inside it, not a call; a room still joins", () => {
      mocks.voice = { status: "idle", error: null, address: null, channelId: null, participants: [], micOn: true, deafened: false, transmitting: false, micLevel: 0, security: NO_CALL, retryEncryption: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMic: vi.fn(), toggleDeafen: vi.fn() };
      mocks.channels = [channel("general", "Общий"), channel("chat", "Болталка", { kind: "text" })];
      render(<AppShell />);
      expect(screen.queryByRole("button", { name: /Болталка/ }), "chats are not on the home page").toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Чаты" }));
      fireEvent.click(screen.getByRole("button", { name: /Болталка/ }));
      expect(screen.getByRole("region", { name: "Чат «Болталка»" }).closest(".drawer")).toBeTruthy();
      expect(mocks.voice.join).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Назад к чатам" }));
      expect(screen.queryByRole("region", { name: "Чат «Болталка»" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Закрыть панель" }));
      expect(screen.queryByRole("complementary", { name: "Чаты и люди" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Общий/ }));
      expect(mocks.voice.join).toHaveBeenCalledWith({ address: "a:1", channelId: "general" });
    });

    it("in a call, the room's chat key opens its chat in the panel, and closes it", () => {
      connectedVoice("general", async () => {});
      render(<AppShell />);
      expect(screen.queryByRole("region", { name: "Чат «Общий»" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Чат комнаты" }));
      expect(screen.getByRole("button", { name: "Чат комнаты" }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("region", { name: "Чат «Общий»" }).closest(".drawer")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Чат комнаты" }));
      expect(screen.queryByRole("region", { name: "Чат «Общий»" })).toBeNull();
    });

    it("pinned, the panel stands beside the page and the pin is remembered", () => {
      mocks.voice = { status: "idle", error: null, address: null, channelId: null, participants: [], micOn: true, deafened: false, transmitting: false, micLevel: 0, security: NO_CALL, retryEncryption: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMic: vi.fn(), toggleDeafen: vi.fn() };
      usePrefs.setState({ drawerPinned: false });
      render(<AppShell />);
      fireEvent.click(screen.getByRole("button", { name: "Чаты" }));
      fireEvent.click(screen.getByRole("button", { name: "Закрепить панель" }));
      expect(usePrefs.getState().drawerPinned).toBe(true);
      expect(document.querySelector(".drawer.pinned")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Открепить панель" }));
      expect(usePrefs.getState().drawerPinned).toBe(false);
      expect(document.querySelector(".drawer")).toBeNull();
    });
  });
});
