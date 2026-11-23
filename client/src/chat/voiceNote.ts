/** A voice message: recorded here and sent as a file of the chat, so it is encrypted like any other. */

export const VOICE_NOTE_PREFIX = "голосовое";
export const MAX_VOICE_NOTE_SECONDS = 300;
const BITS_PER_SECOND = 48_000;

/** Opus where the system has it in WebM (everywhere but Apple's), AAC otherwise. */
const FORMATS: [string, string][] = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/mp4;codecs=mp4a.40.2", "m4a"],
  ["audio/mp4", "m4a"],
];

/** `голосовое-0-42.webm`: how long it is, in the name, as a file has no other place for it. */
export function voiceNoteName(seconds: number, extension: string): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${VOICE_NOTE_PREFIX}-${Math.floor(whole / 60)}-${String(whole % 60).padStart(2, "0")}.${extension}`;
}

/** A file of a message that is to be played rather than saved. */
export function isVoiceNote(name: string): boolean {
  return name.startsWith(`${VOICE_NOTE_PREFIX}-`) && /\.(webm|m4a)$/.test(name);
}

export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function canRecordVoiceNote(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

export type VoiceNote = {
  /** The recording as a file; null when nothing was said. */
  finish: () => Promise<File | null>;
  cancel: () => void;
};

/** Starts recording from the microphone. The microphone is let go when it ends, however it ends. */
export async function startVoiceNote(now: () => number = Date.now): Promise<VoiceNote> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  const [mimeType, extension] = FORMATS.find(([type]) => MediaRecorder.isTypeSupported(type)) ?? FORMATS[0]!;
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITS_PER_SECOND });
  } catch (e) {
    release();
    throw e;
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const started = now();
  recorder.start();
  return {
    finish: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          release();
          const seconds = (now() - started) / 1000;
          const blob = new Blob(chunks, { type: mimeType });
          resolve(blob.size > 0 ? new File([blob], voiceNoteName(seconds, extension), { type: mimeType }) : null);
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = release;
      recorder.stop();
    },
  };
}
