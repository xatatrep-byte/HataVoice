import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPttGate } from "./pttGate";

describe("createPttGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens on press and closes after the tail once released", () => {
    const onChange = vi.fn();
    const gate = createPttGate({ tailMs: 200, onChange });

    gate.press();
    expect(onChange).toHaveBeenLastCalledWith(true);

    gate.release();
    vi.advanceTimersByTime(199);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("pressing again during the tail keeps the mic open without flicker", () => {
    const onChange = vi.fn();
    const gate = createPttGate({ tailMs: 200, onChange });

    gate.press();
    gate.release();
    vi.advanceTimersByTime(100);
    gate.press();
    vi.advanceTimersByTime(500);

    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it("repeated presses (key auto-repeat) report open only once", () => {
    const onChange = vi.fn();
    const gate = createPttGate({ tailMs: 200, onChange });
    gate.press();
    gate.press();
    gate.press();
    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it("closes immediately with a zero tail", () => {
    const onChange = vi.fn();
    const gate = createPttGate({ tailMs: 0, onChange });
    gate.press();
    gate.release();
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("release without press does nothing, dispose cancels a pending close", () => {
    const onChange = vi.fn();
    const gate = createPttGate({ tailMs: 200, onChange });
    gate.release();
    expect(onChange).not.toHaveBeenCalled();

    gate.press();
    gate.release();
    gate.dispose();
    vi.advanceTimersByTime(1000);
    expect(onChange.mock.calls).toEqual([[true]]);
  });
});
