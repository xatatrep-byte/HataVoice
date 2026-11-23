import { NO_FX, parseVoiceFx, VOICE_PRESETS, type VoiceFx } from "./voiceFx";
export type NoiseSuppression = "rnnoise" | "browser" | "off";
export type ActivationMode = "voice" | "ptt";

export type AudioSettings = {
  noiseSuppression: NoiseSuppression;
  echoCancellation: boolean;
  mode: ActivationMode;
  /** Input codes from the Rust PTT hook, e.g. "key:162", "mouse:x1". All must be held. */
  pttBinding: string[];
  /** How long the mic stays open after the PTT key is released. */
  pttTailMs: number;
  /** Voice activation opens the mic at this input level, dBFS. */
  vadThresholdDb: number;
  // "default" follows the system choice.
  inputDeviceId: string;
  outputDeviceId: string;
  /** Join/leave/mute event sounds. */
  sounds: boolean;
  /** Sound of the GIFs and clips in kick and ban notices about others. */
  moderationGifSound: boolean;
  /** The voice changer: a preset's id, or `custom` for `voiceCustom`. */
  voicePreset: string;
  voiceCustom: VoiceFx;
  /** How our voice goes out (Opus bitrate). */
  voiceQuality: VoiceQuality;
};

/**
 * The Opus bitrate, kbit/s, as its id. Opus goes no higher than 510. The ids were words until 0.10.0
 * («economy»…«max» = 32…128); a saved word is no longer one of these, so everyone starts at the maximum, as the owner asked.
 */
export type VoiceQuality = "32" | "64" | "128" | "256" | "510";
export const VOICE_QUALITIES: readonly { id: VoiceQuality; label: string; bitrate: number }[] = [
  { id: "32", label: "32 кбит/с", bitrate: 32_000 },
  { id: "64", label: "64 кбит/с", bitrate: 64_000 },
  { id: "128", label: "128 кбит/с", bitrate: 128_000 },
  { id: "256", label: "256 кбит/с", bitrate: 256_000 },
  { id: "510", label: "510 кбит/с — максимум Opus", bitrate: 510_000 },
];

export function voiceBitrate(quality: VoiceQuality): number {
  return VOICE_QUALITIES.find((q) => q.id === quality)?.bitrate ?? 510_000;
}

export const MIN_VAD_DB = -80;
export const MAX_VAD_DB = -10;

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  noiseSuppression: "rnnoise",
  echoCancellation: true,
  mode: "voice",
  pttBinding: [],
  pttTailMs: 200,
  vadThresholdDb: -50,
  inputDeviceId: "default",
  outputDeviceId: "default",
  sounds: true,
  moderationGifSound: true,
  voicePreset: "none",
  voiceCustom: NO_FX,
  voiceQuality: "510",
};

const STORAGE_KEY = "hatavoice.audio";

export function loadAudioSettings(): AudioSettings {
  try {
    return parseAudioSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

export function saveAudioSettings(settings: AudioSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: settings last until the app closes.
  }
}

export const MAX_TAIL_MS = 1000;
const NOISE_SUPPRESSION: readonly NoiseSuppression[] = ["rnnoise", "browser", "off"];
const MODES: readonly ActivationMode[] = ["voice", "ptt"];

const deviceId = (value: unknown): string => (typeof value === "string" && value !== "" ? value : "default");

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function parseAudioSettings(raw: string | null): AudioSettings {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
  const d = data as Record<string, unknown>;
  const defaults = DEFAULT_AUDIO_SETTINGS;
  return {
    noiseSuppression: oneOf(d.noiseSuppression, NOISE_SUPPRESSION, defaults.noiseSuppression),
    echoCancellation:
      typeof d.echoCancellation === "boolean" ? d.echoCancellation : defaults.echoCancellation,
    mode: oneOf(d.mode, MODES, defaults.mode),
    pttBinding: Array.isArray(d.pttBinding)
      ? d.pttBinding.filter((c): c is string => typeof c === "string")
      : [...defaults.pttBinding],
    pttTailMs:
      typeof d.pttTailMs === "number" && Number.isFinite(d.pttTailMs)
        ? Math.min(MAX_TAIL_MS, Math.max(0, Math.round(d.pttTailMs)))
        : defaults.pttTailMs,
    vadThresholdDb:
      typeof d.vadThresholdDb === "number" && Number.isFinite(d.vadThresholdDb)
        ? Math.min(MAX_VAD_DB, Math.max(MIN_VAD_DB, Math.round(d.vadThresholdDb)))
        : defaults.vadThresholdDb,
    inputDeviceId: deviceId(d.inputDeviceId),
    outputDeviceId: deviceId(d.outputDeviceId),
    sounds: typeof d.sounds === "boolean" ? d.sounds : defaults.sounds,
    moderationGifSound: typeof d.moderationGifSound === "boolean" ? d.moderationGifSound : defaults.moderationGifSound,
    voicePreset:
      typeof d.voicePreset === "string" && (d.voicePreset === "custom" || VOICE_PRESETS.some((p) => p.id === d.voicePreset))
        ? d.voicePreset
        : defaults.voicePreset,
    voiceCustom: parseVoiceFx(d.voiceCustom),
    voiceQuality: oneOf(d.voiceQuality, VOICE_QUALITIES.map((q) => q.id), defaults.voiceQuality),
  };
}
