import { afterEach, describe, expect, it, vi } from "vitest";
import { offerH264MainFirst, preferH264Main } from "./h264Main";

const h264 = (profile: string, mode: 0 | 1) => ({
  mimeType: "video/H264",
  clockRate: 90000,
  sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`,
});
const plain = (mimeType: string) => ({ mimeType, clockRate: 90000 });

// The order Chromium on Windows lists its send codecs in, with the video card's H.264.
const chromium: RTCRtpCodec[] = [
  plain("video/VP8"),
  plain("video/rtx"),
  h264("42001f", 1),
  h264("42001f", 0),
  h264("42e01f", 1),
  h264("42e01f", 0),
  h264("4d001f", 1),
  h264("4d001f", 0),
  plain("video/AV1"),
  h264("64001f", 1),
  plain("video/red"),
];

describe("H.264 Main goes first in our offer", () => {
  it("leads the H.264 codecs, mode 1 before mode 0; every other codec keeps its place", () => {
    const ordered = preferH264Main(chromium);
    expect(ordered.map((c) => c.sdpFmtpLine?.match(/packetization-mode=(\d).*profile-level-id=(\w+)/)?.slice(1).join(" ") ?? c.mimeType)).toEqual([
      "video/VP8",
      "video/rtx",
      "1 4d001f",
      "0 4d001f",
      "1 42001f",
      "0 42001f",
      "1 42e01f",
      "0 42e01f",
      "video/AV1",
      "1 64001f",
      "video/red",
    ]);
    expect(ordered).toHaveLength(chromium.length);
  });

  it("changes nothing on a PC that cannot encode Main", () => {
    const noMain = chromium.filter((c) => !c.sdpFmtpLine?.includes("4d001f"));
    expect(preferH264Main(noMain)).toEqual(noMain);
  });
});

describe("every video transceiver with a track offers it that way", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeBrowser() {
    const preferences: { kind: string; codecs: unknown[] }[] = [];
    class FakePeerConnection {
      addTransceiver(trackOrKind: { kind: string } | string) {
        const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
        return { setCodecPreferences: (codecs: unknown[]) => preferences.push({ kind, codecs }) };
      }
    }
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: chromium }) });
    return { pc: new FakePeerConnection() as unknown as RTCPeerConnection, preferences };
  }

  it("sets the order on a screen's transceiver, not on audio or LiveKit's empty receive sections", () => {
    const { pc, preferences } = fakeBrowser();
    offerH264MainFirst();
    offerH264MainFirst();
    pc.addTransceiver({ kind: "video" } as MediaStreamTrack, { direction: "sendonly" });
    pc.addTransceiver({ kind: "audio" } as MediaStreamTrack, { direction: "sendonly" });
    pc.addTransceiver("video", { direction: "recvonly" });
    expect(preferences).toEqual([{ kind: "video", codecs: preferH264Main(chromium) }]);
  });
});
