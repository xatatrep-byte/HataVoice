// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));

import { useServers } from "../../state/servers";
import { NetworkSection } from "./NetworkSection";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("«Сеть»: the speed test", () => {
  it("measures the way to the server we are on, and says how fast", async () => {
    useServers.setState({ servers: [{ address: "a:1", name: "Хата", color: "blue" }], selected: "a:1" });
    invoke.mockResolvedValue({ ping_ms: 14.2, down_mbps: 87.5, up_mbps: 21.3 });
    render(<NetworkSection />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /До сервера/ })));
    expect(invoke).toHaveBeenCalledWith("speed_server", { address: "a:1" });
    expect(screen.getByText(/14 мс/)).toBeTruthy();
    expect(screen.getByText(/87,5 Мбит\/с/)).toBeTruthy();
    expect(screen.getByText(/21,3 Мбит\/с/)).toBeTruthy();
  });

  it("measures the internet from Russia and from Europe only when asked, with no Cloudflare", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "speed_internet"
        ? {
            points: [
              { name: "Россия (Selectel)", ping_ms: 9.6, down_mbps: 312.4, error: null },
              { name: "Европа (Hetzner, Хельсинки)", ping_ms: null, down_mbps: null, error: "Нет связи" },
            ],
            vpn: null,
          }
        : null,
    );
    render(<NetworkSection />);
    expect(screen.queryByText(/Cloudflare/)).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("speed_internet");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /Интернет/ })));
    expect(invoke).toHaveBeenCalledWith("speed_internet");
    expect(screen.getByText("Россия (Selectel)")).toBeTruthy();
    expect(screen.getByText(/312,4 Мбит\/с/)).toBeTruthy();
    expect(screen.getByText("Нет связи")).toBeTruthy();
  });

  it("says when a VPN is on: every speed test then measures the VPN", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "speed_internet" ? { points: [{ name: "Россия (Selectel)", ping_ms: 80, down_mbps: 40, error: null }], vpn: "WireGuard Tunnel" } : null,
    );
    render(<NetworkSection />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /Интернет/ })));
    expect(screen.getByText(/Похоже, включён VPN/).textContent).toContain("WireGuard Tunnel");
  });

  it("says what went wrong", async () => {
    useServers.setState({ servers: [{ address: "a:1", name: "Хата", color: "blue" }], selected: "a:1" });
    invoke.mockRejectedValue("Сервер не умеет проверять скорость — его нужно обновить");
    render(<NetworkSection />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /До сервера/ })));
    expect(screen.getByText("Сервер не умеет проверять скорость — его нужно обновить")).toBeTruthy();
  });
});
