import { screenPreset, type ScreenEncoder, type ScreenSettings } from "./screen";

/** Whether this PC can send its screen in AV1, and how: by the video card (`hardware`) or by the processor. */
export type Av1Support = { encode: boolean; hardware: boolean; smooth: boolean };

/**
 * What this PC can do with AV1 at that size and rate: WebRTC must have an AV1 encoder at all, and the browser says whether it is
 * power efficient (the video card's) and smooth at that size and rate. Not every video card encodes AV1 (it takes an
 * RTX 40, a Radeon RX 7000, an Intel Arc or newer); without one, the processor does it.
 */
export async function av1Support(quality: Pick<ScreenSettings, "resolution" | "fps">): Promise<Av1Support> {
  const codecs = globalThis.RTCRtpSender?.getCapabilities?.("video")?.codecs ?? [];
  if (!codecs.some((c) => c.mimeType.toLowerCase() === "video/av1")) return { encode: false, hardware: false, smooth: false };
  const { width, height, fps, bitrate } = screenPreset(quality);
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: "webrtc",
      video: { contentType: "video/AV1", width, height, bitrate, framerate: fps },
    });
    return { encode: info.supported, hardware: info.supported && info.powerEfficient, smooth: info.supported && info.smooth };
  } catch {
    // The browser would not say: the encoder is there, the careful guess is the processor.
    return { encode: true, hardware: false, smooth: true };
  }
}

/** What to tell the person about AV1 on this PC; nothing when the video card encodes it. */
export function av1Warning(support: Av1Support): string | null {
  if (!support.encode) return "Этот ПК не кодирует AV1, демонстрация пойдёт в VP9";
  if (!support.hardware) {
    return "AV1 будет кодировать процессор, а не видеокарта, и картинка может подтормаживать. Если так, выбери «Авто» или H.264";
  }
  return null;
}

/**
 * How the screen goes out on this PC. «Авто»: AV1 where the video card encodes it, H.264 anywhere else. AV1 chosen: on
 * the card, or on the processor with a warning, or VP9 with a warning where this PC has no AV1 at all.
 */
export async function screenToSend(settings: ScreenSettings): Promise<{ encoder: ScreenEncoder; warning: string | null }> {
  switch (settings.codec) {
    case "h264":
      return { encoder: { codec: "h264", hardware: false }, warning: null };
    case "vp9svc":
      return { encoder: { codec: "vp9", hardware: false }, warning: null };
    case "auto": {
      const support = await av1Support(settings);
      return { encoder: support.hardware ? { codec: "av1", hardware: true } : { codec: "h264", hardware: false }, warning: null };
    }
    case "av1": {
      const support = await av1Support(settings);
      const encoder: ScreenEncoder = support.encode ? { codec: "av1", hardware: support.hardware } : { codec: "vp9", hardware: false };
      return { encoder, warning: av1Warning(support) };
    }
  }
}
