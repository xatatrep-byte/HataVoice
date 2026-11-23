// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_AUDIO_SETTINGS } from "../../audio/settings";
import { usePrefs } from "../../state/prefs";
import { Onboarding } from "./Onboarding";

vi.mock("../../audio/useMicTest", () => ({ useMicTest: () => ({ level: 0.3, error: null }) }));
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

const ptt = { open: false, error: null, capturing: false, startCapture: vi.fn(), cancelCapture: vi.fn() };

afterEach(cleanup);
beforeEach(() => usePrefs.setState({ nickname: "", color: "blue", onboarded: false }));

describe("Onboarding", () => {
  it("needs a nickname, then walks through sound and finishes", () => {
    const onDone = vi.fn();
    const onSettingsChange = vi.fn();
    render(
      <Onboarding
        onDone={onDone}
        settings={DEFAULT_AUDIO_SETTINGS}
        onSettingsChange={onSettingsChange}
        onAddServer={() => {}}
        ptt={ptt}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    expect(screen.getByText("Введи ник")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Как тебя зовут?" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Ник"), { target: { value: "Петя" } });
    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    expect(screen.getByRole("heading", { name: "Проверим звук" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Я в наушниках" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ echoCancellation: false });

    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    expect(screen.getByRole("heading", { name: "Куда подключимся?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Позже" }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(usePrefs.getState().onboarded).toBe(true);
    expect(usePrefs.getState().nickname).toBe("Петя");
  });

  it("opens the add-server dialog on the chosen tab", () => {
    const onAddServer = vi.fn();
    usePrefs.setState({ nickname: "Аня" });
    render(
      <Onboarding onDone={() => {}} settings={DEFAULT_AUDIO_SETTINGS} onSettingsChange={() => {}} onAddServer={onAddServer} ptt={ptt} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать свой сервер" }));
    expect(onAddServer).toHaveBeenCalledWith("create");
  });
});

describe("Onboarding sound step", () => {
  function soundStep(settings = DEFAULT_AUDIO_SETTINGS, onSettingsChange = vi.fn()) {
    usePrefs.setState({ nickname: "Аня" });
    render(
      <Onboarding onDone={() => {}} settings={settings} onSettingsChange={onSettingsChange} onAddServer={() => {}} ptt={ptt} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    return onSettingsChange;
  }

  it("saves the chosen microphone for calls", () => {
    const onSettingsChange = soundStep();
    fireEvent.change(screen.getByLabelText("Микрофон"), { target: { value: "usb" } });
    expect(onSettingsChange).toHaveBeenCalledWith({ inputDeviceId: "usb" });
  });

  it("asks for a push-to-talk key right away", () => {
    soundStep({ ...DEFAULT_AUDIO_SETTINGS, mode: "ptt" });
    fireEvent.click(screen.getByRole("button", { name: "Назначить" }));
    expect(ptt.startCapture).toHaveBeenCalled();
  });

  it("lets you hear yourself while checking the sound", () => {
    soundStep();
    fireEvent.click(screen.getByRole("button", { name: "Послушать себя" }));
    expect(loopback.enabled).toBe(true);
  });
});
