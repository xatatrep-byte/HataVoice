// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));

import { HostOff } from "./HostOff";
import { applyHostConfig } from "../../host/useHost";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("the server of this PC, off", () => {
  it("says it is off instead of «no connection» and turns it on", async () => {
    const onStarted = vi.fn();
    invoke.mockResolvedValue(null);
    render(<HostOff name="Бомжатник" crash={null} onStarted={onStarted} />);
    expect(screen.getByRole("status").textContent).toContain("Сервер на этом ПК выключен");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Включить сервер" }));
    });
    expect(invoke).toHaveBeenCalledWith("host_start");
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it("tells why it stopped by itself, and why it does not start", async () => {
    invoke.mockRejectedValue("Порт 7350 занят или недоступен");
    render(<HostOff name="Хата" crash="panicked at …" onStarted={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("остановился с ошибкой: panicked at …");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Включить сервер" }));
    });
    expect(screen.getByText("Порт 7350 занят или недоступен")).toBeTruthy();
  });

  it("a restart for new settings is not the owner turning it off", async () => {
    invoke.mockImplementation(async (command: string) => (command === "host_view" ? { running: true } : null));
    await applyHostConfig({ name: "Хата", api_port: 7350, rtc_tcp_port: 7881, rtc_udp_port: 7882, livekit_port: 7880, upnp: true, external_ip: null });
    expect(invoke).toHaveBeenCalledWith("host_stop", { keepOn: true });
    expect(invoke).toHaveBeenLastCalledWith("host_start");
  });
});
