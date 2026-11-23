// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parseCharacter } from "../../characters/character";
import { usePrefs } from "../../state/prefs";
import { CharacterSection } from "./CharacterSection";

const invoke = vi.fn(async (command: string) => (command === "identity_info" ? { user_id: "abcd", fingerprint: "f", lost_previous: false } : null));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (command: string) => invoke(command) }));

afterEach(() => {
  cleanup();
  usePrefs.setState({ character: null, stage3d: true });
});

describe("the 3D character section", () => {
  it("dresses the character, and the code is what friends get", () => {
    usePrefs.setState({ character: null, color: "#123456" });
    render(<CharacterSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Корона" }));
    const crowned = parseCharacter(usePrefs.getState().character);
    expect(crowned).toMatchObject({ hat: "crown", outfit: "#123456" });
    fireEvent.click(screen.getByRole("radio", { name: "Крепыш" }));
    expect(parseCharacter(usePrefs.getState().character)).toMatchObject({ hat: "crown", body: "chunky" });
    fireEvent.click(screen.getByRole("button", { name: /Как по умолчанию/ }));
    expect(usePrefs.getState().character).toBeNull();
  });

  it("makes a random one that is always a valid character, and turns the stage off", () => {
    render(<CharacterSection />);
    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByRole("button", { name: /Случайный/ }));
      expect(parseCharacter(usePrefs.getState().character)).not.toBeNull();
    }
    fireEvent.click(screen.getByRole("switch", { name: /3D-персонажи в звонке/ }));
    expect(usePrefs.getState().stage3d).toBe(false);
  });

  it("says so when this PC cannot draw 3D", async () => {
    render(<CharacterSection />);
    await waitFor(() => expect(screen.getByText(/Этот ПК не рисует 3D/)).toBeTruthy());
  });
});
