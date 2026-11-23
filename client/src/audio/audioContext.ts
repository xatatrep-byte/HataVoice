/** RNNoise only works at 48 kHz, so the whole audio graph runs at that rate. */
export const SAMPLE_RATE = 48_000;

let context: AudioContext | undefined;

/** One app-wide context: LiveKit plays remote audio through it and runs mic processors on it. */
export function getAudioContext(): AudioContext {
  context ??= new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  return context;
}

/** Plays everything in `context` on the chosen speakers ("default" follows the system). */
export async function applyOutputDevice(context: AudioContext, deviceId: string): Promise<void> {
  const sink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  // Engines without AudioContext.setSinkId keep the system default.
  if (!sink.setSinkId) return;
  await sink.setSinkId(deviceId === "default" ? "" : deviceId);
}
