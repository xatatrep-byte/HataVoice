/** How often the input level is measured (and fed to voice activation). */
export const LEVEL_INTERVAL_MS = 20;

/** Level of silence; also what we report for no signal at all. */
export const SILENCE_DB = -100;
const METER_FLOOR_DB = -60;

/** RMS amplitude (0–1) → dBFS; zero or negative input gives SILENCE_DB. */
export function rmsToDb(rms: number): number {
  if (!(rms > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(rms));
}

/** dBFS → 0–1 for level meters: −60 dB and below is empty, 0 dB is full. */
export function dbToMeter(db: number): number {
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** RMS of an analyser's current time-domain window. */
export function readRms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) sum += sample * sample;
  return Math.sqrt(sum / buffer.length);
}
