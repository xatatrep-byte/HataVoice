// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { backTakenBy, holdBack, resetBack } from "./backStack";

afterEach(resetBack);

/** jsdom's history does not fire popstate on back(): the step is played by hand. */
const back = () => {
  const event = new PopStateEvent("popstate");
  window.dispatchEvent(event);
  return event;
};

describe("the phone's back key over the page", () => {
  it("closes the window on top only, and the shell knows the step was taken", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    holdBack(outer);
    holdBack(inner);
    const event = back();
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    expect(backTakenBy(event)).toBe(true);
    back();
    expect(outer).toHaveBeenCalledOnce();
  });

  it("a window closed by its own button takes its step out quietly", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const spy = vi.spyOn(history, "back").mockImplementation(() => {});
    holdBack(outer);
    const release = holdBack(inner);
    release();
    expect(spy).toHaveBeenCalledOnce();
    // The step history.back() makes closes nobody...
    const quietStep = back();
    expect(inner).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(backTakenBy(quietStep)).toBe(true);
    // ...and the next back closes the window under it.
    back();
    expect(outer).toHaveBeenCalledOnce();
    release();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("with nothing open, back belongs to the shell", () => {
    const event = back();
    expect(backTakenBy(event)).toBe(false);
  });
});
