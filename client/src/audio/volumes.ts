/** Local playback setting for one participant. Volume 1 = 100%, max 2 = 200%. */
export type ParticipantVolume = { volume: number; muted: boolean };

/** Keyed by user id: a nickname can change, the id does not. */
export type VolumeMap = Record<string, ParticipantVolume>;

export const MAX_VOLUME = 2;

const STORAGE_KEY = "hatavoice.volumes";

const clampVolume = (v: number) => Math.min(MAX_VOLUME, Math.max(0, v));

export function loadVolumes(): VolumeMap {
  try {
    return parseVolumes(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveVolumes(volumes: VolumeMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(volumes));
  } catch {
    // Storage unavailable: volumes last until the app closes.
  }
}

export function parseVolumes(raw: string | null): VolumeMap {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};

  const result: VolumeMap = {};
  for (const [name, entry] of Object.entries(data)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { volume, muted } = entry as Record<string, unknown>;
    if (typeof volume !== "number" || !Number.isFinite(volume)) continue;
    result[name] = { volume: clampVolume(volume), muted: muted === true };
  }
  return result;
}

export function effectiveVolume(volumes: VolumeMap, name: string): number {
  const entry = volumes[name];
  if (!entry) return 1;
  return entry.muted ? 0 : entry.volume;
}

export function withVolume(
  volumes: VolumeMap,
  name: string,
  change: Partial<ParticipantVolume>,
): VolumeMap {
  const current = volumes[name] ?? { volume: 1, muted: false };
  const next = { ...current, ...change };
  return { ...volumes, [name]: { volume: clampVolume(next.volume), muted: next.muted } };
}
