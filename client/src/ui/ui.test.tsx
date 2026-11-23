// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initials } from "./Avatar";
import { Modal } from "./Modal";
import { Toggle } from "./Toggle";
import { useToasts } from "./toasts";

afterEach(cleanup);

describe("initials", () => {
  it("takes the first letters of up to two words", () => {
    expect(initials("Петя Иванов")).toBe("ПИ");
    expect(initials("вася")).toBe("В");
    expect(initials("  ")).toBe("?");
  });
});

describe("Modal", () => {
  it("shows a titled dialog and closes once on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Настройки">
        <p>Содержимое</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Настройки" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(
      <Modal open={false} onClose={() => {}} title="Скрыто">
        <p>x</p>
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Toggle", () => {
  it("is a switch that reports the new state", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Звуки событий" />);
    const toggle = screen.getByRole("switch", { name: "Звуки событий" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("useToasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it("does not duplicate a visible message and hides info after 5 s", () => {
    act(() => {
      useToasts.getState().push({ kind: "info", text: "Адрес скопирован" });
      useToasts.getState().push({ kind: "info", text: "Адрес скопирован" });
    });
    expect(useToasts.getState().toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("keeps errors until dismissed", () => {
    let id = "";
    act(() => {
      id = useToasts.getState().push({ kind: "error", text: "Сервер недоступен" });
    });
    act(() => vi.advanceTimersByTime(10_000));
    expect(useToasts.getState().toasts).toHaveLength(1);
    act(() => useToasts.getState().dismiss(id));
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
