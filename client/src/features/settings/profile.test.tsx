// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { usePrefs } from "../../state/prefs";
import { useServers } from "../../state/servers";
import { ProfileSection } from "./ProfileSection";

beforeEach(() => {
  invoke.mockReset();
  usePrefs.setState({ nickname: "Петя", color: "pink", showGame: true, customGames: [] });
  useServers.setState({
    servers: [
      { address: "1.2.3.4:7350", name: "Хата", color: "blue", serverKey: "SK" },
      { address: "5.6.7.8:7350", name: "Новый", color: "green" },
    ],
    selected: "1.2.3.4:7350",
  });
});
afterEach(cleanup);

describe("ProfileSection", () => {
  it("profile section shows the fingerprint and exports the identity", async () => {
    // The save dialog is the program's own: the page gets a token for where, never the path.
    invoke.mockImplementation(async (command: string) =>
      command === "identity_info" ? { user_id: "k7q3abcdef", fingerprint: "k7q3" } : command === "pick_save" ? { token: "t-where", name: "личность.hvid", size: 0 } : null,
    );
    render(<ProfileSection />);
    expect(await screen.findByText("k7q3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Сохранить копию личности" }));
    fireEvent.change(screen.getByLabelText("Пароль для файла"), { target: { value: "секрет12345" } });
    fireEvent.change(screen.getByLabelText("Ещё раз"), { target: { value: "секрет12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Выбрать, куда сохранить" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("identity_export", {
        token: "t-where",
        password: "секрет12345",
        nickname: "Петя",
        color: "pink",
        servers: [{ address: "1.2.3.4:7350", server_key: "SK" }],
      }),
    );
  });

  it("refuses a short or mistyped password before asking where to save", async () => {
    invoke.mockResolvedValue({ user_id: "k7q3abcdef", fingerprint: "k7q3" });
    render(<ProfileSection />);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить копию личности" }));
    fireEvent.change(screen.getByLabelText("Пароль для файла"), { target: { value: "123456789" } });
    fireEvent.change(screen.getByLabelText("Ещё раз"), { target: { value: "123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Выбрать, куда сохранить" }));
    expect(await screen.findByText("Пароль: хотя бы 10 символов")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Пароль для файла"), { target: { value: "1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Выбрать, куда сохранить" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("pick_save", expect.anything());
  });

  it("the game status can be hidden", () => {
    invoke.mockResolvedValue({ user_id: "k7q3abcdef", fingerprint: "k7q3" });
    render(<ProfileSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Показывать, во что я играю" }));
    expect(usePrefs.getState().showGame).toBe(false);
  });

  it("adds and removes a game the built-in list does not know", () => {
    invoke.mockResolvedValue({ user_id: "k7q3abcdef", fingerprint: "k7q3" });
    render(<ProfileSection />);
    fireEvent.change(screen.getByLabelText("Файл игры"), { target: { value: "MyGame.exe" } });
    fireEvent.change(screen.getByLabelText("Как назвать"), { target: { value: "Моя игра" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить игру" }));
    expect(usePrefs.getState().customGames).toEqual([{ exe: "MyGame.exe", title: "Моя игра" }]);
    fireEvent.click(screen.getByRole("button", { name: "Убрать «Моя игра»" }));
    expect(usePrefs.getState().customGames).toEqual([]);
  });
});
