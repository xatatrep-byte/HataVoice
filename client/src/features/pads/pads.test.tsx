// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScreenTile, type PadControl } from "../stage/ScreenTile";
import { PadPlayers } from "./PadHost";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

afterEach(cleanup);

const view = { identity: "anna", isLocal: false, track: null, watching: true, hasAudio: false };
const pad = (over: Partial<PadControl> = {}): PadControl => ({
  state: "idle",
  player: null,
  device: null,
  onAsk: vi.fn(),
  onRelease: vi.fn(),
  onKey: vi.fn(() => true),
  onKeysUp: vi.fn(),
  ...over,
});
const tile = (control: PadControl) =>
  render(
    <ScreenTile
      screen={view as never}
      name="Аня"
      volume={{ volume: 1, muted: false }}
      expanded={false}
      onExpand={() => {}}
      onVolumeChange={() => {}}
      onClose={() => {}}
      pad={control}
    />,
  );

describe("playing with a pad on a friend's PC", () => {
  it("asks from the friend's screen, then shows the player and lets go", () => {
    const idle = pad();
    tile(idle);
    fireEvent.click(screen.getByRole("button", { name: "Играть геймпадом" }));
    expect(idle.onAsk).toHaveBeenCalledOnce();
    cleanup();

    const active = pad({ state: "active", player: 2, device: "Xbox 360 Controller" });
    tile(active);
    expect(screen.getByText("Ты — игрок 2 · Xbox 360 Controller")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отпустить геймпад" }));
    expect(active.onRelease).toHaveBeenCalledOnce();
  });

  it("takes the keyboard pad's keys on the picture, and lets them all up when it loses the focus", () => {
    const keys = pad({ state: "active", player: 3, device: null });
    tile(keys);
    const picture = screen.getByRole("figure");
    const down = new KeyboardEvent("keydown", { code: "KeyW", bubbles: true, cancelable: true });
    picture.dispatchEvent(down);
    expect(keys.onKey).toHaveBeenCalledWith("KeyW", true);
    expect(down.defaultPrevented, "the page does not get it too").toBe(true);
    fireEvent.keyUp(picture, { code: "KeyW" });
    expect(keys.onKey).toHaveBeenCalledWith("KeyW", false);
    fireEvent.blur(picture);
    expect(keys.onKeysUp).toHaveBeenCalledOnce();
  });
});

describe("friends who play on our PC", () => {
  it("are listed with a way to take each one's pad out, and all at once", () => {
    const onKick = vi.fn();
    const onStopAll = vi.fn();
    const guests = [
      { address: "a", channel: "c", peer: "boris", player: 2 },
      { address: "a", channel: "c", peer: "vika", player: 3 },
    ];
    render(<PadPlayers guests={guests} nameOf={(u) => (u === "boris" ? "Борис" : "Вика")} onKick={onKick} onStopAll={onStopAll} />);
    expect(screen.getByText(/Борис · игрок 2/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Отключить" })[1]);
    expect(onKick).toHaveBeenCalledWith("vika");
    fireEvent.click(screen.getByRole("button", { name: "Отключить всех" }));
    expect(onStopAll).toHaveBeenCalledOnce();
    cleanup();
    const { container } = render(<PadPlayers guests={[]} nameOf={() => ""} onKick={onKick} onStopAll={onStopAll} />);
    expect(container.innerHTML).toBe("");
  });
});
