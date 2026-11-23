import { VideoPreset, type ScreenShareCaptureOptions, type TrackPublishOptions, type VideoTrack } from "livekit-client";

/** The screen's size as the person picks it, by its height: 720p, 1080p, 1440p, 4K. */
export type ScreenResolution = "720" | "1080" | "1440" | "2160";
/** Frames a second as the person picks them. */
export type ScreenFps = "15" | "30" | "60";
/**
 * The codec as the person picks it. «Авто»: AV1 where the video card encodes it (the best picture for the bitrate, and
 * a steady 60 fps the processor cannot keep), H.264 anywhere else — Chromium encodes LiveKit's H.264 (constrained
 * baseline) on the processor, but fast enough for a steady 1080p60, where VP9 on the processor drops frames. AV1 travels
 * encrypted in an envelope its RTP packing can cut (av1Envelope.ts). VP9 (`vp9svc`; the old «Авто (VP9)» was `vp9`)
 * has spatial layers for weak viewers.
 */
export type ScreenCodec = "auto" | "av1" | "h264" | "vp9svc";
export type ScreenSettings = { resolution: ScreenResolution; fps: ScreenFps; codec: ScreenCodec; audio: boolean };
/** How the screen is really encoded once this PC is known (av1Support.ts): the codec, and by the video card or not. */
export type ScreenEncoder = { codec: "av1" | "h264" | "vp9"; hardware: boolean };

export const SCREEN_RESOLUTIONS: readonly ScreenResolution[] = ["720", "1080", "1440", "2160"];
export const SCREEN_FPS: readonly ScreenFps[] = ["15", "30", "60"];
export const SCREEN_CODECS: readonly ScreenCodec[] = ["auto", "av1", "h264", "vp9svc"];
export const DEFAULT_SCREEN: ScreenSettings = { resolution: "1080", fps: "60", codec: "auto", audio: true };

export const SCREEN_RESOLUTION_LABELS: Record<ScreenResolution, string> = { "720": "720p", "1080": "1080p", "1440": "1440p", "2160": "4K" };

/** «1080p · 60». */
export const screenQualityLabel = (s: Pick<ScreenSettings, "resolution" | "fps">) => `${SCREEN_RESOLUTION_LABELS[s.resolution]} · ${s.fps}`;

/** The four fixed choices of before 0.12 (`preset`), as a size and a rate. */
export const OLD_SCREEN_PRESETS: Record<string, Pick<ScreenSettings, "resolution" | "fps">> = {
  games: { resolution: "1080", fps: "60" },
  text: { resolution: "1440", fps: "30" },
  qhd60: { resolution: "1440", fps: "60" },
  max: { resolution: "2160", fps: "60" },
};

/**
 * What a watcher's player keeps in hand, ms: a stream player's short buffer, so the frames come evenly whatever the
 * network does. Whoever controls the PC or plays on it takes them at once instead (`lowLatency`).
 */
export const SCREEN_SMOOTH_MS = 250;

type Preset = { width: number; height: number; fps: number; bitrate: number; hint: "motion" | "detail" };

const SIZES: Record<ScreenResolution, [number, number]> = { "720": [1280, 720], "1080": [1920, 1080], "1440": [2560, 1440], "2160": [3840, 2160] };
/** AV1's bits at 60 fps for each size; fewer frames take a share of them (a frame of a slower picture costs more). */
const BITRATE_AT_60: Record<ScreenResolution, number> = { "720": 6_000_000, "1080": 12_000_000, "1440": 18_000_000, "2160": 25_000_000 };
const FPS_SHARE: Record<ScreenFps, number> = { "15": 0.4, "30": 0.6, "60": 1 };

/**
 * What a size and a rate mean for the capture and the encoder: at 60 fps it is a moving picture (frames first when the
 * link is short), slower it is text and slides (sharpness first).
 */
export function screenPreset(settings: Pick<ScreenSettings, "resolution" | "fps">): Preset {
  const [width, height] = SIZES[settings.resolution];
  const fps = Number(settings.fps);
  return { width, height, fps, bitrate: Math.round(BITRATE_AT_60[settings.resolution] * FPS_SHARE[settings.fps]), hint: fps >= 60 ? "motion" : "detail" };
}

/** How far above the capture's frame rate the encoder's cap sits. */
const FPS_HEADROOM = 1.5;

/** What the screen goes out as: its size and rate at most, and the bitrate. */
export type ScreenQuality = { width: number; height: number; fps: number; bitrate: number };

/** The bits a pixel gets while someone drives the PC, between these limits: 1080p60 ≈ 25 Mbit/s, 1440p60 ≈ 44. */
const DRIVE_BITS_PER_PIXEL = 0.2;
const DRIVE_MIN_BITRATE = 20_000_000;
const DRIVE_MAX_BITRATE = 50_000_000;

/** What the preset itself sends. */
export function presetQuality(settings: ScreenSettings): ScreenQuality {
  const { width, height, fps, bitrate } = screenPreset(settings);
  return { width, height, fps, bitrate };
}

/**
 * The screen while someone controls this PC or plays on it: they work with the picture, so it is the real one. With the
 * video card encoding: the screen's own pixels (scaling them takes the processor and blurs text) up to 1440p, up to 4K
 * when 4K is chosen, at 60 fps and a bitrate with room for it. On the processor the size stays, as more of it would cost
 * frames, and only the bitrate grows.
 */
export function drivenQuality(settings: ScreenSettings, native: { width: number; height: number } | null, hardware: boolean): ScreenQuality {
  const preset = presetQuality(settings);
  if (!hardware) return { ...preset, bitrate: Math.round(preset.bitrate * 1.5) };
  const [limitWidth, limitHeight] = settings.resolution === "2160" ? [3840, 2160] : [2560, 1440];
  const source = native && native.width > 0 && native.height > 0 ? native : preset;
  const scale = Math.min(1, limitWidth / source.width, limitHeight / source.height);
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);
  const bitrate = Math.round(Math.max(DRIVE_MIN_BITRATE, Math.min(DRIVE_MAX_BITRATE, DRIVE_BITS_PER_PIXEL * width * height * 60)));
  return { width, height, fps: 60, bitrate };
}

/**
 * How many more bits a codec needs than AV1 for the same picture: H.264 (constrained baseline, as LiveKit sends it)
 * about a third more, VP9 a little. The presets' bitrates are AV1's; the others get theirs raised, so «1080p · 60» looks
 * the same whatever the codec (the link's own congestion control still lowers it when the link is short).
 */
export const CODEC_BITS: Record<ScreenEncoder["codec"], number> = { av1: 1, vp9: 1.15, h264: 1.35 };

/** A preset's bitrate for a codec. */
export const codecBitrate = (bitrate: number, codec: ScreenEncoder["codec"]) => Math.round(bitrate * CODEC_BITS[codec]);

/** The encoder's frame cap for a capture at `fps`. */
export const encoderFpsCap = (fps: number) => Math.round(fps * FPS_HEADROOM);

/** The sound of the screen: stereo Opus, as music and films want it. */
export const SCREEN_AUDIO_BITRATE = 128_000;

export const SCREEN_CODEC_LABELS: Record<ScreenCodec, string> = {
  auto: "Авто",
  av1: "AV1",
  h264: "H.264",
  vp9svc: "VP9",
};

/** What Windows is asked to capture: the preset's size and rate at most, and the computer's sound if wanted. */
export function screenCaptureOptions(settings: ScreenSettings): ScreenShareCaptureOptions {
  const preset = screenPreset(settings);
  return {
    audio: settings.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    systemAudio: settings.audio ? "include" : "exclude",
    // Our own window would show itself again and again inside the picture.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    resolution: { width: preset.width, height: preset.height, frameRate: preset.fps },
    contentHint: preset.hint,
  };
}

/** How a screen is cut into what the server can give a weak viewer, for each encoder. */
function layering(encoder: ScreenEncoder, preset: Preset): Pick<TrackPublishOptions, "scalabilityMode" | "simulcast" | "screenShareSimulcastLayers"> {
  switch (encoder.codec) {
    case "av1":
      // The video card encodes AV1 only in one layer (layers send it to the processor): two whole streams instead,
      // the full one and a quarter of it, each on the card.
      return encoder.hardware
        ? {
            scalabilityMode: "L1T1",
            simulcast: true,
            screenShareSimulcastLayers: [new VideoPreset(preset.width / 2, preset.height / 2, preset.bitrate / 4, Math.min(30, preset.fps), "high")],
          }
        : { scalabilityMode: "L1T3", simulcast: false };
    case "h264":
      // One stream: every extra layer would be one more encoder, on the processor where the card has no H.264 Main.
      return { scalabilityMode: undefined, simulcast: false };
    case "vp9":
      return { scalabilityMode: "L3T3_KEY", simulcast: false };
  }
}

/** How the screen goes out: the encoder, its layers, the preset's bitrate; what gives way when the link is short. */
export function screenPublishOptions(settings: ScreenSettings, encoder: ScreenEncoder): TrackPublishOptions {
  const preset = screenPreset(settings);
  return {
    videoCodec: encoder.codec,
    // The capture sets the frame rate; the encoder's cap sits above it, as it drops a frame that comes sooner than
    // 1/cap after the last, and captured frames never come evenly (at a cap of 60, a 56 fps capture went out at 50).
    screenShareEncoding: { maxBitrate: codecBitrate(preset.bitrate, encoder.codec), maxFramerate: encoderFpsCap(preset.fps), priority: "high" },
    ...layering(encoder, preset),
    // Every viewer is this app: no second codec to fall back to (and none to encrypt twice).
    backupCodec: false,
    degradationPreference: preset.hint === "motion" ? "maintain-framerate" : "maintain-resolution",
    audioPreset: { maxBitrate: SCREEN_AUDIO_BITRATE },
    forceStereo: true,
    dtx: false,
    red: false,
  };
}

/**
 * A phone's screen leaves through a phone's uplink. At a PC's bitrate (720p at 30 fps is 4.9 Mbit/s in H.264) a mobile
 * uplink filled up and the voice waited in the same queue (0.23.0). 0.23.2 capped it at 1.5 Mbit/s: the picture got
 * softer, and the moment the phone was touched it fell to 4-10 frames a second (see `PHONE_SCREEN_HINT`). Over Wi-Fi
 * there is room for more; over a mobile network a middle way. The voice goes first either way (low priority).
 */
export const PHONE_SCREEN_MAX_BITRATE = { wifi: 4_000_000, mobile: 2_500_000 } as const;

/**
 * A phone's screen is a moving picture: lists scroll and screens slide under a finger. Sent as «detail» (text, slides)
 * WebRTC kept every pixel and dropped frames whenever the picture moved; as motion it gives way in size, not in frames.
 */
export const PHONE_SCREEN_HINT = "motion";

/** Whether this phone is on Wi-Fi (or a cable), as the browser tells; a mobile network when it cannot tell. */
export function onWifi(connection: { type?: string } | undefined = (globalThis.navigator as { connection?: { type?: string } } | undefined)?.connection): boolean {
  return connection?.type === "wifi" || connection?.type === "ethernet";
}

/** How a phone's screen goes out: its video chip's H.264, smoothness first, capped for its uplink, after the voice. */
export function phoneScreenPublishOptions(settings: ScreenSettings, wifi = onWifi()): TrackPublishOptions {
  const options = screenPublishOptions(settings, { codec: "h264", hardware: true });
  const encoding = options.screenShareEncoding!;
  const cap = wifi ? PHONE_SCREEN_MAX_BITRATE.wifi : PHONE_SCREEN_MAX_BITRATE.mobile;
  return {
    ...options,
    screenShareEncoding: { ...encoding, maxBitrate: Math.min(encoding.maxBitrate, cap), priority: "low" },
    degradationPreference: "maintain-framerate",
  };
}

/** Someone's shared screen as the stage shows it. */
export type ScreenView = {
  identity: string;
  isLocal: boolean;
  /** The picture; null while it is still coming, or when we closed it. */
  track: VideoTrack | null;
  /** We take its frames (a closed one is not downloaded at all). */
  watching: boolean;
  /** It comes with the computer's sound. */
  hasAudio: boolean;
  /** Its picture froze: a game in full screen on that PC (see `frozenShare.ts`). */
  frozen?: boolean;
  /** It is a phone's screen: nobody can control it or play on it (see `ATTR_DEVICE`). */
  phone?: boolean;
};

/** The key of the volume of someone's screen sound, apart from their voice. */
export const screenVolumeKey = (identity: string) => `screen:${identity}`;
