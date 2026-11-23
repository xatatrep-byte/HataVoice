// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ColorPicker } from "./ColorPicker";

afterEach(cleanup);

describe("ColorPicker", () => {
  it("moves with the arrows over the square and the hue, takes HEX and presets", () => {
    const onChange = vi.fn();
    render(<ColorPicker label="Акцент" value="#ff0000" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Акцент: насыщенность и яркость" }), { key: "ArrowDown", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("#e60000");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Акцент: оттенок" }), { key: "ArrowRight", shiftKey: true });
    expect(onChange.mock.lastCall![0]).not.toBe("#e60000");
    const hex = screen.getByRole("textbox", { name: "Акцент: HEX" });
    fireEvent.change(hex, { target: { value: "3ecf8e" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("#3ecf8e");
    fireEvent.change(hex, { target: { value: "не цвет" } });
    fireEvent.blur(hex);
    expect(onChange).toHaveBeenLastCalledWith("#3ecf8e");
    fireEvent.click(screen.getByRole("button", { name: "#8b6cff" }));
    expect(onChange).toHaveBeenLastCalledWith("#8b6cff");
  });
});
