import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));

import { applyGameStatus } from "./games";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe("applyGameStatus", () => {
  it("the game toggle turns the status off at once", async () => {
    await applyGameStatus(false, []);
    expect(invoke).toHaveBeenCalledWith("games_enable", { enabled: false });
    expect(invoke).toHaveBeenCalledWith("presence_set", { activity: null });
  });

  it("turning it on hands the user's own games to the watcher and waits for it", async () => {
    await applyGameStatus(true, [{ exe: " MyGame.exe ", title: "Моя игра" }, { exe: "", title: "пусто" }]);
    expect(invoke).toHaveBeenCalledWith("games_custom", { games: [{ exe: "MyGame.exe", title: "Моя игра" }] });
    expect(invoke).toHaveBeenCalledWith("games_enable", { enabled: true });
    expect(invoke).not.toHaveBeenCalledWith("presence_set", expect.anything());
  });
});
