/**
 * Chromium encodes H.264 on the video card in Main (4d001f), but LiveKit's usual H.264, Constrained Baseline (42e01f),
 * on the processor (OpenH264). Our server offers both (`livekit_conf.rs`), and LiveKit answers with the H.264 variants
 * in the order of our offer, so Main has to come first in it. A PC whose encoders cannot do Main does not offer it,
 * and gets Constrained Baseline as before.
 */

const isH264 = (codec: RTCRtpCodec) => codec.mimeType.toLowerCase() === "video/h264";

/** 0 for Main in packetization mode 1 (the one the server takes), 1 for Main in mode 0, 2 for any other H.264. */
function rank(codec: RTCRtpCodec): number {
  const fmtp = (codec.sdpFmtpLine ?? "").toLowerCase();
  if (!/(^|;)profile-level-id=4d/.test(fmtp)) return 2;
  return /(^|;)packetization-mode=1/.test(fmtp) ? 0 : 1;
}

/** `codecs` with the H.264 ones reordered among themselves, Main first; every other codec keeps its place. */
export function preferH264Main(codecs: RTCRtpCodec[]): RTCRtpCodec[] {
  const h264 = codecs.filter(isH264).sort((a, b) => rank(a) - rank(b));
  let next = 0;
  return codecs.map((codec) => (isH264(codec) ? h264[next++] : codec));
}

const MARK = Symbol.for("hatavoice.h264Main");

/**
 * Makes every video transceiver created with a track offer H.264 Main first. LiveKit creates its transceivers
 * inside, so this sits on RTCPeerConnection itself: our only video out is shared screens, and nothing else here
 * opens a peer connection. Safe to call again.
 */
export function offerH264MainFirst(): void {
  const proto = globalThis.RTCPeerConnection?.prototype as (RTCPeerConnection & { [MARK]?: true }) | undefined;
  if (!proto || proto[MARK]) return;
  proto[MARK] = true;
  const add = proto.addTransceiver;
  proto.addTransceiver = function (this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
    const transceiver = add.call(this, trackOrKind, init);
    if (typeof trackOrKind !== "string" && trackOrKind.kind === "video") {
      const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
      try {
        if (codecs?.length) transceiver.setCodecPreferences(preferH264Main(codecs));
      } catch {
        // The browser would not take the list: its own order, Constrained Baseline for H.264.
      }
    }
    return transceiver;
  } as RTCPeerConnection["addTransceiver"];
}
