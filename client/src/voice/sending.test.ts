import { describe, expect, it } from "vitest";
import { isSending } from "./sending";

const live = { connected: true, micOn: true, deafened: false, serverMuted: false, mode: "voice" as const, pttOpen: false };

describe("isSending", () => {
  it("sends with the mic on in a call", () => {
    expect(isSending(live)).toBe(true);
    expect(isSending({ ...live, mode: "ptt" })).toBe(false);
    expect(isSending({ ...live, mode: "ptt", pttOpen: true })).toBe(true);
  });

  it("a server mute closes the mic whatever the buttons say", () => {
    expect(isSending({ ...live, serverMuted: true })).toBe(false);
    expect(isSending({ ...live, mode: "ptt", pttOpen: true, serverMuted: true })).toBe(false);
  });

  it("never sends while deafened, muted or outside a call", () => {
    expect(isSending({ ...live, deafened: true })).toBe(false);
    expect(isSending({ ...live, micOn: false })).toBe(false);
    expect(isSending({ ...live, connected: false })).toBe(false);
  });
});
