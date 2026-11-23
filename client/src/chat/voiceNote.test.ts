// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clock, isVoiceNote, startVoiceNote, voiceNoteName } from "./voiceNote";

class FakeRecorder {
  static isTypeSupported = (type: string) => type.startsWith("audio/webm");
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown, public options: { mimeType: string }) {}
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(["sound"]) });
    this.onstop?.();
  }
}

function withMicrophone() {
  const stop = vi.fn();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
  });
  return stop;
}

afterEach(() => vi.unstubAllGlobals());

describe("a voice note", () => {
  it("is named by its length, and recognized by its name", () => {
    expect(voiceNoteName(42.4, "webm")).toBe("голосовое-0-42.webm");
    expect(voiceNoteName(125, "m4a")).toBe("голосовое-2-05.m4a");
    expect(isVoiceNote("голосовое-0-42.webm")).toBe(true);
    expect(isVoiceNote("голосовое.exe")).toBe(false);
    expect(isVoiceNote("кот.webm")).toBe(false);
    expect(clock(65)).toBe("1:05");
  });

  it("gives a file and lets the microphone go", async () => {
    const stop = withMicrophone();
    let time = 1_000;
    const note = await startVoiceNote(() => time);
    time += 3_000;
    const file = await note.finish();
    expect(file?.name).toBe("голосовое-0-03.webm");
    expect(file?.type).toBe("audio/webm;codecs=opus");
    expect(stop).toHaveBeenCalled();
  });

  it("canceled, it lets the microphone go too", async () => {
    const stop = withMicrophone();
    const note = await startVoiceNote();
    note.cancel();
    expect(stop).toHaveBeenCalled();
  });
});
