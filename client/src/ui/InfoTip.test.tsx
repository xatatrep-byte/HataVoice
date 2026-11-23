// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InfoTip } from "./InfoTip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tip = () => render(<InfoTip label="Чем отличаются кодеки">AV1 лучше всех</InfoTip>);

describe("the «i» with an explanation", () => {
  it("opens with a click and stays: a hover that opened it first does not make the click close it", () => {
    vi.useFakeTimers();
    tip();
    const button = screen.getByRole("button", { name: "Чем отличаются кодеки" });
    fireEvent.mouseEnter(button.parentElement!);
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.getByRole("tooltip").textContent).toBe("AV1 лучше всех");
    fireEvent.click(button);
    fireEvent.mouseLeave(button.parentElement!);
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("a pinned card goes with a click elsewhere, Escape, or another click on the «i»", () => {
    tip();
    const button = screen.getByRole("button", { name: "Чем отличаются кодеки" });
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("forgives the trip from the «i» to the card", () => {
    vi.useFakeTimers();
    tip();
    const holder = screen.getByRole("button", { name: "Чем отличаются кодеки" }).parentElement!;
    fireEvent.mouseEnter(holder);
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.mouseLeave(holder);
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.mouseEnter(screen.getByRole("tooltip"));
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
});
