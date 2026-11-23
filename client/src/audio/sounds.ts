export type SoundKind = "join" | "leave" | "mute" | "unmute" | "deafen" | "undeafen";

/** Short note sequences (Hz): rising for "on/in", falling for "off/out". */
export const SOUND_TONES: Record<SoundKind, number[]> = {
  join: [523.25, 783.99],
  leave: [783.99, 523.25],
  mute: [659.25, 440],
  unmute: [440, 659.25],
  deafen: [392, 293.66],
  undeafen: [293.66, 392],
};

const NOTE_SECONDS = 0.09;
const VOLUME = 0.12;

/** Plays an event sound through `ctx`; never throws (sounds are optional). */
export function playSound(kind: SoundKind, ctx: AudioContext): void {
  try {
    const start = ctx.currentTime + 0.01;
    SOUND_TONES[kind].forEach((frequency, i) => {
      const t = start + i * NOTE_SECONDS;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(VOLUME, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + NOTE_SECONDS);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + NOTE_SECONDS + 0.02);
    });
  } catch {
    // A suspended or closed context just means no sound.
  }
}
