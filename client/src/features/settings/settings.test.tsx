// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "../../audio/settings";
import { usePrefs } from "../../state/prefs";
import { DEFAULT_APPEARANCE } from "../../theme/appearance";
import { SettingsModal } from "./SettingsModal";

vi.mock("../../audio/useMicTest", () => ({ useMicTest: () => ({ level: 0.2, error: null }) }));
vi.mock("../host/HostCard", () => ({ HostCard: () => <div>Карточка хоста</div> }));
vi.mock("../../audio/useDevices", () => ({
  useDevices: () => ({ inputs: [{ deviceId: "usb", label: "USB-микрофон", kind: "audioinput" }], outputs: [] }),
}));
const loopback = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../audio/useMicLoopback", () => ({
  useMicLoopback: (enabled: boolean) => {
    loopback.enabled = enabled;
    return { error: null };
  },
}));

afterEach(cleanup);
beforeEach(() => usePrefs.setState({ appearance: { ...DEFAULT_APPEARANCE } }));

const voice = {
  status: "idle" as const,
  inputs: [],
  outputs: [],
  micLevel: 0,
  selectOutput: vi.fn(),
};
const ptt = { open: false, error: null, capturing: false, startCapture: vi.fn(), cancelCapture: vi.fn() };

function renderSettings(
  settings: AudioSettings,
  section: "appearance" | "voice" | "notifications",
  onClose = vi.fn(),
  onSettingsChange = vi.fn(),
) {
  return render(
    <SettingsModal
      open
      section={section}
      onClose={onClose}
      voice={voice}
      ptt={ptt}
      settings={settings}
      onSettingsChange={onSettingsChange}
    />,
  );
}

describe("SettingsModal", () => {
  it("sets which chat messages earn a Windows notification, and whether it shows the text", () => {
    usePrefs.setState({ notifyMode: "mentions", notifyText: true });
    renderSettings(DEFAULT_AUDIO_SETTINGS, "notifications");
    expect(screen.getByRole("button", { name: "Упоминания" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Все сообщения" }));
    expect(usePrefs.getState().notifyMode).toBe("all");
    fireEvent.click(screen.getByRole("switch", { name: "Показывать текст сообщения" }));
    expect(usePrefs.getState().notifyText).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Выключены" }));
    expect(usePrefs.getState().notifyMode).toBe("off");
    expect(screen.queryByRole("switch", { name: "Показывать текст сообщения" }), "nothing to show when they are off").toBeNull();
  });

  it("switches the theme from the appearance section", () => {
    renderSettings(DEFAULT_AUDIO_SETTINGS, "appearance");
    fireEvent.click(screen.getByRole("radio", { name: /Бумага/ }));
    expect(usePrefs.getState().appearance.theme).toBe("light");
    fireEvent.change(screen.getByRole("combobox", { name: "Смешать с темой" }), { target: { value: "ocean" } });
    expect(usePrefs.getState().appearance.mixWith).toBe("ocean");
    expect(screen.getByLabelText("Сколько второй темы")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Сделать свою из текущей/ }));
    expect(usePrefs.getState().appearance.theme).toBe("custom");
    expect(screen.getByRole("radio", { name: /Своя/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Акцент/ }));
    expect(screen.getByRole("group", { name: "Акцент" })).toBeTruthy();
  });

  it("puts the settings' sections on top or down the left, as chosen in the appearance section", () => {
    renderSettings(DEFAULT_AUDIO_SETTINGS, "appearance");
    const settings = document.querySelector(".settings")!;
    expect(settings.classList.contains("side")).toBe(false);
    const where = screen.getByRole("group", { name: "Вкладки настроек" });
    fireEvent.click(within(where).getByRole("button", { name: "Слева" }));
    expect(usePrefs.getState().appearance.settingsTabs).toBe("left");
    expect(document.querySelector(".settings")!.classList.contains("side")).toBe(true);
    fireEvent.click(within(where).getByRole("button", { name: "Сверху" }));
    expect(document.querySelector(".settings")!.classList.contains("side")).toBe(false);
  });

  it("shows the sensitivity slider only for voice activation", () => {
    renderSettings({ ...DEFAULT_AUDIO_SETTINGS, mode: "voice" }, "voice");
    expect(screen.getByLabelText("Чувствительность")).toBeTruthy();
    cleanup();
    renderSettings({ ...DEFAULT_AUDIO_SETTINGS, mode: "ptt" }, "voice");
    expect(screen.queryByLabelText("Чувствительность")).toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderSettings(DEFAULT_AUDIO_SETTINGS, "voice", onClose);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets you turn off the sound of moderation GIFs", () => {
    const onSettingsChange = vi.fn();
    renderSettings(DEFAULT_AUDIO_SETTINGS, "voice", vi.fn(), onSettingsChange);
    fireEvent.click(screen.getByRole("switch", { name: "Звук гифок модерации" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ moderationGifSound: false });
  });

  it("saves the chosen microphone", () => {
    const onSettingsChange = vi.fn();
    renderSettings(DEFAULT_AUDIO_SETTINGS, "voice", vi.fn(), onSettingsChange);
    fireEvent.change(screen.getByLabelText("Микрофон"), { target: { value: "usb" } });
    expect(onSettingsChange).toHaveBeenCalledWith({ inputDeviceId: "usb" });
  });

  it("lets you listen to yourself and stop", () => {
    renderSettings(DEFAULT_AUDIO_SETTINGS, "voice");
    expect(loopback.enabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Послушать себя" }));
    expect(loopback.enabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Остановить" }));
    expect(loopback.enabled).toBe(false);
  });

  it("offers listening to yourself only outside a call", () => {
    render(
      <SettingsModal
        open
        section="voice"
        onClose={() => {}}
        voice={{ ...voice, status: "connected" }}
        ptt={ptt}
        settings={DEFAULT_AUDIO_SETTINGS}
        onSettingsChange={() => {}}
      />,
    );
    expect((screen.getByRole("button", { name: "Послушать себя" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
