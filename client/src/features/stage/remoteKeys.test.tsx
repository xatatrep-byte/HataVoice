// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RemoteInput } from "../../remote/api";
import { RemoteKeys } from "./RemoteKeys";

afterEach(cleanup);

function keys() {
  const sent: RemoteInput[] = [];
  render(<RemoteKeys send={(input) => sent.push(input)} />);
  const field = screen.getByRole("textbox", { name: "Печатать на ПК друга" }) as HTMLInputElement;
  const pressed = () => sent.map((k) => (k.t === "key" ? `${k.code}${k.down ? "↓" : "↑"}` : k.t)).join(" ");
  return { field, pressed };
}

describe("typing on a friend's PC from a phone", () => {
  it("sends a letter typed at once and keeps the field empty", () => {
    const { field, pressed } = keys();
    field.value = "й";
    fireEvent.input(field);
    expect(pressed()).toBe("KeyQ↓ KeyQ↑");
    expect(field.value).toBe("");
  });

  it("sends a word the keyboard composed only once it is committed", () => {
    const { field, pressed } = keys();
    fireEvent.compositionStart(field);
    field.value = "Hi";
    fireEvent.input(field);
    expect(pressed()).toBe("");
    fireEvent.compositionEnd(field);
    expect(pressed()).toBe("ShiftLeft↓ KeyH↓ KeyH↑ ShiftLeft↑ KeyI↓ KeyI↑");
  });

  it("erasing in the empty field is the PC's Backspace, Enter is its Enter", () => {
    const { field, pressed } = keys();
    field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }));
    fireEvent.keyDown(field, { key: "Enter" });
    expect(pressed()).toBe("Backspace↓ Backspace↑ Enter↓ Enter↑");
  });

  it("has the keys a phone lacks", () => {
    const { pressed } = keys();
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    fireEvent.click(screen.getByRole("button", { name: "→" }));
    expect(pressed()).toBe("Escape↓ Escape↑ ArrowRight↓ ArrowRight↑");
  });
});
