// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ScreenView } from "../../voice/screen";
import { resetBack } from "../../ui/backStack";

const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../../platform", async (real) => ({ ...(await real<typeof import("../../platform")>()), IS_ANDROID: true, IS_MOBILE: true }));
vi.mock("../../platform/android", async (real) => ({
  ...(await real<typeof import("../../platform/android")>()),
  android: () => ({ send: (word: Record<string, unknown>) => sent.push(word) }),
}));
const { ScreenTile } = await import("./ScreenTile");

afterEach(() => {
  cleanup();
  resetBack();
  sent.length = 0;
});

const shared = (): ScreenView => ({ identity: "anna", isLocal: false, track: { attach: vi.fn(), detach: vi.fn() } as never, watching: true, hasAudio: false });

describe("a shared screen on a phone", () => {
  it("covers the whole app on «Во весь экран», with Android's bars hidden, and comes back by the button", () => {
    const view = render(<ScreenTile screen={shared()} name="Аня" volume={{ volume: 1, muted: false }} expanded={false} onExpand={() => {}} onVolumeChange={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Во весь экран" }));
    expect(view.container.querySelector(".screen-tile")!.classList.contains("whole")).toBe(true);
    expect(sent).toEqual([{ op: "fullscreen", on: true, landscape: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Выйти из полного экрана" }));
    expect(view.container.querySelector(".screen-tile")!.classList.contains("whole")).toBe(false);
    expect(sent[sent.length - 1]).toEqual({ op: "fullscreen", on: false });
  });

  it("comes back by the phone's back key too", () => {
    const view = render(<ScreenTile screen={shared()} name="Аня" volume={{ volume: 1, muted: false }} expanded={false} onExpand={() => {}} onVolumeChange={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Во весь экран" }));
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(view.container.querySelector(".screen-tile")!.classList.contains("whole")).toBe(false);
    expect(sent[sent.length - 1]).toEqual({ op: "fullscreen", on: false });
  });
});
