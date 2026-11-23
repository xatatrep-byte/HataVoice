// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  create: vi.fn(async (_: unknown) => ({ config: { name: "Хата", api_port: 7350 }, serverKey: "key", backupSuggested: false })),
  view: vi.fn(async (): Promise<{ config: Record<string, unknown> | null }> => ({ config: null })),
  invoke: vi.fn(async (..._: unknown[]) => null),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("../host/createServer", () => ({
  createHostedServer: (s: unknown) => mocks.create(s),
  hostView: () => mocks.view(),
  localAddress: (c: { api_port: number }) => `127.0.0.1:${c.api_port}`,
}));

import { AddServerModal } from "./AddServerModal";
import { useServers } from "../../state/servers";

afterEach(() => {
  cleanup();
  mocks.create.mockClear();
  mocks.invoke.mockClear();
  mocks.view.mockImplementation(async () => ({ config: null }));
});

describe("creating a server", () => {
  it("has no ready-made sets: one room to start, rooms added, renamed and moved by hand", async () => {
    render(<AddServerModal open onClose={() => {}} initialTab="create" />);
    expect(screen.queryByText(/Учёба и работа/)).toBeNull();
    expect((screen.getByRole("textbox", { name: "Комната 1" }) as HTMLInputElement).value).toBe("Общий");
    fireEvent.change(screen.getByRole("textbox", { name: "Название новой комнаты" }), { target: { value: "Игры" } });
    fireEvent.click(screen.getByRole("button", { name: /Добавить/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название новой комнаты" }), { target: { value: "Кино" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Название новой комнаты" }), { key: "Enter" });
    fireEvent.change(screen.getByRole("textbox", { name: "Комната 1" }), { target: { value: "Болталка" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Ниже" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Создать сервер" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      rooms: [
        { id: "general", name: "Болталка" },
        { id: "kino", name: "Кино" },
        { id: "igry", name: "Игры" },
      ],
      p2p: true,
      upnp: true,
      ports: undefined,
    });
  });

  it("asks nothing about white IPs: both ways are on, and it says where to change them", () => {
    render(<AddServerModal open onClose={() => {}} initialTab="create" />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /Порты/ })).toBeNull();
    expect(screen.getByText(/и с белым IP, и без него/).textContent).toContain("«Настройки сервера» → «Подключение»");
  });

  it("a busy port brings the port fields, which refuse ports that clash", async () => {
    mocks.create.mockImplementationOnce(async () => {
      throw "Сервер не запустился: Порт 7350 занят или недоступен";
    });
    render(<AddServerModal open onClose={() => {}} initialTab="create" />);
    fireEvent.click(screen.getByRole("button", { name: "Создать сервер" }));
    expect(await screen.findByText(/Обычные порты заняты/)).toBeTruthy();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Порт сервера (TCP)" }), { target: { value: "7882" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать сервер" }));
    expect(await screen.findByText(/разные числа от 1024 до 65535/)).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Порт сервера (TCP)" }), { target: { value: "7450" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать сервер" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1]![0]).toMatchObject({ ports: { api_port: 7450, rtc_udp_port: 7882, rtc_tcp_port: 7881 } });
  });
});

describe("a server already on this PC", () => {
  const config = { name: "Хата", api_port: 7350, rtc_tcp_port: 7881, rtc_udp_port: 7882, livekit_port: 7880, upnp: false, external_ip: null, p2p: true };

  it("is opened as it is, without a form that would change it", async () => {
    mocks.view.mockImplementation(async () => ({ config }));
    render(<AddServerModal open onClose={() => {}} initialTab="create" />);
    expect(await screen.findByText("На этом ПК уже есть твой сервер «Хата»")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Комната 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Открыть его" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ name: "Хата", upnp: false, p2p: true });
  });

  it("can be deleted to make a new one; the name has to be typed first", async () => {
    mocks.view.mockImplementation(async () => ({ config }));
    useServers.getState().add({ address: "127.0.0.1:7350", name: "Хата", color: "green", serverKey: "a2V5" });
    render(<AddServerModal open onClose={() => {}} initialTab="create" />);
    fireEvent.click(await screen.findByRole("button", { name: /Удалить и создать новый/ }));
    const confirm = screen.getByRole("button", { name: /Удалить навсегда/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/впиши название/), { target: { value: "хата " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("host_delete", { serverKey: "a2V5" }));
    expect(await screen.findByRole("textbox", { name: "Комната 1" })).toBeTruthy();
    expect(useServers.getState().servers.some((s) => s.address === "127.0.0.1:7350")).toBe(false);
  });
});

describe("deleting the server of this PC", () => {
  it("takes it off the list under every address it was added by, and leaves other servers", async () => {
    const { deleteHostedServer } = await import("../host/deleteServer");
    useServers.setState({ servers: [], selected: null });
    useServers.getState().add({ address: "127.0.0.1:7350", name: "Хата", color: "green" });
    useServers.getState().add({ address: "203.0.113.7:7350", name: "Хата", color: "green", serverKey: "a2V5" });
    useServers.getState().add({ address: "5.6.7.8:7350", name: "У друга", color: "blue", serverKey: "b3RoZXI" });
    // The entry here has no key saved; Rust tells the key of the server it deleted.
    mocks.invoke.mockImplementation(async (command: unknown) => (command === "host_delete" ? "a2V5" : null) as null);
    await deleteHostedServer("127.0.0.1:7350");
    expect(mocks.invoke).toHaveBeenCalledWith("host_delete", { serverKey: null });
    expect(useServers.getState().servers.map((s) => s.address)).toEqual(["5.6.7.8:7350"]);
    mocks.invoke.mockImplementation(async () => null);
  });
});
