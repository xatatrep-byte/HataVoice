import { VideoPresets, VideoQuality, type TrackPublishOptions, type VideoCaptureOptions } from "livekit-client";
import { IS_ANDROID } from "../platform/android";

/** The camera's picture as the person picks it, by its height. */
export type CameraQuality = "360" | "720" | "1080";
export type CameraSettings = {
  /** A camera of this PC, or «default» for whichever Windows gives. */
  deviceId: string;
  quality: CameraQuality;
  /** Our own picture as in a mirror, on this PC only: friends see it the right way round. */
  mirror: boolean;
  /** A phone's camera: the front one (at the person) or the back one. */
  facing: CameraFacing;
};

export type CameraFacing = "user" | "environment";
export const CAMERA_FACINGS: readonly CameraFacing[] = ["user", "environment"];

export const CAMERA_QUALITIES: readonly CameraQuality[] = ["360", "720", "1080"];
export const CAMERA_QUALITY_LABELS: Record<CameraQuality, string> = { "360": "360p", "720": "720p", "1080": "1080p" };
export const DEFAULT_CAMERA: CameraSettings = { deviceId: "default", quality: "720", mirror: true, facing: "user" };

const PRESETS = { "360": VideoPresets.h360, "720": VideoPresets.h720, "1080": VideoPresets.h1080 } as const;
const FPS = 30;

export function cameraCaptureOptions(settings: CameraSettings, phone = false): VideoCaptureOptions {
  const { width, height } = PRESETS[settings.quality].resolution;
  // A phone picks by side (front or back); a PC by the device chosen.
  if (phone) return { facingMode: settings.facing, resolution: { width, height, frameRate: FPS } };
  return {
    deviceId: settings.deviceId === "default" ? undefined : { exact: settings.deviceId },
    resolution: { width, height, frameRate: FPS },
  };
}

/** Our picture is mirrored here only for a camera that looks at us (the back camera films the world as it is). */
export function mirrored(settings: CameraSettings, phone = false): boolean {
  return settings.mirror && (!phone || settings.facing === "user");
}

/**
 * The camera's own stream, apart from the voice's (`VOICE_STREAM`): tracks of one stream are played in step, and a voice
 * that waits for its picture is late. LiveKit 1.13 gives every track a stream of its own anyway (checked on a guest: the
 * host's microphone and camera came in two streams before this too), so this only keeps a later LiveKit that groups
 * them by default from making the voice wait.
 */
export const CAMERA_STREAM = "camera";
/** A phone's camera goes out with this share of a PC's bits (H.264 from its chip looks as good with them). */
export const PHONE_CAMERA_BITS = 0.6;
export const VOICE_STREAM = "voice";

/**
 * The camera goes out in VP8 (cheap on any processor, and LiveKit's encryption knows it) with smaller layers under the
 * chosen one: when many cameras are on, everyone takes a friend's middle layer instead of the full one. A phone sends
 * H.264, which its video chip encodes, in two layers and with fewer bits: VP8 in three layers on its processor took the
 * processor from its voice, and a camera's full bits on a phone's upload queued the voice behind the picture — a video
 * call from a phone talked late.
 */
export function cameraPublishOptions(settings: CameraSettings, phone = false): TrackPublishOptions {
  return {
    videoCodec: phone ? "h264" : "vp8",
    simulcast: true,
    videoEncoding: { maxBitrate: Math.round(PRESETS[settings.quality].encoding.maxBitrate * (phone ? PHONE_CAMERA_BITS : 1)), maxFramerate: FPS },
    videoSimulcastLayers: phone || settings.quality === "360" ? [VideoPresets.h180] : [VideoPresets.h180, VideoPresets.h360],
    degradationPreference: "balanced",
    stream: CAMERA_STREAM,
  };
}

/** How many friends' cameras still come in full; with more of them each comes as its middle layer. */
export const FULL_CAMERAS = 4;

export function remoteCameraQuality(cameras: number): VideoQuality {
  return cameras <= FULL_CAMERAS ? VideoQuality.HIGH : VideoQuality.MEDIUM;
}

/** What to tell the person when the camera does not start. */
export function cameraErrorText(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return "Сервер не разрешает тебе камеру: нужна роль с правом «Камера и показ экрана». Если право есть — владельцу сервера стоит обновить ХатаВойс";
  if (name === "NotAllowedError" && IS_ANDROID) return "Android не дал камеру: разреши её ХатаВойсу в настройках телефона (Приложения → ХатаВойс → Разрешения)";
  if (name === "NotAllowedError") return "Windows не дал камеру: Параметры → Конфиденциальность и защита → Камера → разреши доступ приложениям";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Камера не найдена: проверь, что она подключена, и выбери её в настройках";
  if (name === "NotReadableError") return "Камера занята другой программой: закрой её там и попробуй снова";
  return `Камера не включилась: ${e instanceof Error ? e.message : String(e)}`;
}

/** A camera's name in a list: Windows gives none until the camera was used once. */
export function cameraLabel(device: { label: string }, index: number): string {
  return device.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "") || `Камера ${index + 1}`;
}
