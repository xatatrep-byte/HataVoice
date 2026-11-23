// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { usePrefs } from "../../state/prefs";
import { useServers } from "../../state/servers";
import { AddServerModal } from "../servers/AddServerModal";
import { JoinScreen } from "./JoinScreen";

const LINK = "hatavoice://1.2.3.4:7350/#v=1&sk=SK&inv=SECRET";
const preview = {
  address: "1.2.3.4:7350",
  server_name: "Хата",
  description: "Сервер друзей",
  welcome: "Заходи, не стесняйся!",
  icon: null,
  inviter_name: "Аня",
  inviter_fingerprint: "k7q3",
  valid: true,
};

beforeEach(() => {
  invoke.mockReset();
  usePrefs.setState({ nickname: "Петя", color: "pink", frame: "crown", character: null });
  useServers.setState({ servers: [], selected: null });
});
afterEach(cleanup);

describe("joining", () => {
  it("join screen shows the server, its welcome and who invited, then joins", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "invite_preview") return preview;
      if (command === "server_join") return { address: "1.2.3.4:7350", server_key: "SK", name: "Хата" };
      return null;
    });
    const onJoined = vi.fn();
    render(<JoinScreen link={LINK} onJoined={onJoined} onCancel={() => {}} />);
    expect(await screen.findByText("Хата")).toBeTruthy();
    expect(screen.getByText("Заходи, не стесняйся!")).toBeTruthy();
    expect(screen.getByText("Приглашает Аня · k7q3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith({ address: "1.2.3.4:7350", serverKey: "SK", name: "Хата" }));
    expect(invoke).toHaveBeenCalledWith("server_join", { link: LINK, profile: { nickname: "Петя", color: "pink", frame: "crown", character: null } });
    expect(useServers.getState().servers[0]).toMatchObject({ address: "1.2.3.4:7350", serverKey: "SK", name: "Хата" });
    expect(useServers.getState().selected).toBe("1.2.3.4:7350");
  });

  it("an invite that no longer works says so instead of offering to join", async () => {
    invoke.mockResolvedValue({ ...preview, valid: false });
    render(<JoinScreen link={LINK} onJoined={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText("Приглашение больше не действует. Попроси новое")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Войти" })).toBeNull();
  });

  it("a pasted invite link goes to the join screen, a plain address to openServer", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "invite_preview") return preview;
      if (command === "server_open") return { address: "5.6.7.8:7350", server_key: "SK2", name: "Работа" };
      return null;
    });
    render(<AddServerModal open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Ссылка-приглашение или адрес"), { target: { value: LINK } });
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    expect(await screen.findByText("Заходи, не стесняйся!")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("server_open", expect.anything());

    cleanup();
    render(<AddServerModal open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Ссылка-приглашение или адрес"), { target: { value: " 5.6.7.8:7350 " } });
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    await waitFor(() => expect(useServers.getState().servers).toHaveLength(1));
    expect(useServers.getState().servers[0]).toMatchObject({ address: "5.6.7.8:7350", serverKey: "SK2", name: "Работа" });
  });

  it("tells a stranger to ask for an invite", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "server_open") throw "Ты не участник этого сервера. Попроси ссылку у владельца";
      return null;
    });
    render(<AddServerModal open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Ссылка-приглашение или адрес"), { target: { value: "5.6.7.8:7350" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    expect(await screen.findByText("На сервер заходят только по приглашениям. Попроси ссылку у владельца")).toBeTruthy();
    expect(useServers.getState().servers).toHaveLength(0);
  });

  it("an address pasted with http:// is saved as host:port", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "server_open" ? { address: "5.6.7.8:7350", server_key: "SK2", name: "Работа" } : null,
    );
    render(<AddServerModal open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Ссылка-приглашение или адрес"), { target: { value: "http://5.6.7.8:7350/" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    await waitFor(() => expect(useServers.getState().servers).toHaveLength(1));
    expect(useServers.getState().servers[0]!.address).toBe("5.6.7.8:7350");
    expect(invoke).toHaveBeenCalledWith("server_open", expect.objectContaining({ address: "5.6.7.8:7350" }));
  });
});
