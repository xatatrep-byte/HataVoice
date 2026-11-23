/** How long voice activation stays open after speech stops. */
export const VAD_HOLD_MS = 300;

export type VoiceGate = {
  /** Feeds the current input level; call it at a steady rate (every ~20 ms). */
  feed(db: number, nowMs: number): void;
  setThreshold(db: number): void;
};

/**
 * Voice activation: opens as soon as the level reaches the threshold and closes after
 * `holdMs` of continuous quiet, so pauses between words don't chop speech.
 */
export function createVoiceGate({
  thresholdDb,
  holdMs,
  onChange,
}: {
  thresholdDb: number;
  holdMs: number;
  onChange: (open: boolean) => void;
}): VoiceGate {
  let threshold = thresholdDb;
  let open = false;
  let quietSince: number | null = null;

  return {
    feed(db, nowMs) {
      if (db >= threshold) {
        quietSince = null;
        if (!open) {
          open = true;
          onChange(true);
        }
        return;
      }
      if (!open) return;
      quietSince ??= nowMs;
      if (nowMs - quietSince >= holdMs) {
        open = false;
        quietSince = null;
        onChange(false);
      }
    },
    setThreshold(db) {
      threshold = db;
    },
  };
}
