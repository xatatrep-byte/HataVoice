import { describe, expect, it, vi } from "vitest";
import type { ScreenView } from "../../voice/screen";
import { controlOf, padOf } from "./Stage";

const screen = (over: Partial<ScreenView> = {}): ScreenView => ({ identity: "anna", isLocal: false, track: null, watching: true, hasAudio: false, ...over });
const remote = { session: null, waiting: null, ask: vi.fn(), stop: vi.fn(), send: vi.fn() } as never;
const pads = { playing: null, waiting: null, device: null, ask: vi.fn(), release: vi.fn(), key: vi.fn(), keysUp: vi.fn(), touch: vi.fn() } as never;

describe("a phone's screen in a call", () => {
  it("can be asked for control or a pad when it is a PC's", () => {
    expect(controlOf(screen(), remote)?.state).toBe("idle");
    expect(padOf(screen(), pads)?.state).toBe("idle");
  });

  it("can be controlled through its accessibility service, but takes no pad", () => {
    const control = controlOf(screen({ phone: true }), remote);
    expect(control?.state).toBe("idle");
    expect(control?.phone, "letters as letters, and the phone's own keys").toBe(true);
    expect(controlOf(screen(), remote)?.phone).toBe(false);
    expect(padOf(screen({ phone: true }), pads)).toBeUndefined();
  });
});
