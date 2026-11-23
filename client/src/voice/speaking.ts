import { dbToMeter } from "../audio/levels";
import { createVoiceGate, type VoiceGate } from "../audio/vad";
import type { SpeechState } from "./participants";

/** Others count as speaking from this level of their voice as received here, dBFS. */
export const REMOTE_SPEECH_DB = -55;

/**
 * Who is speaking, from voice levels measured on this PC. Unlike LiveKit's server-side
 * detection it reacts at once and does not miss quiet microphones.
 */
export class SpeakingTracker {
  private readonly people = new Map<string, { gate: VoiceGate; speaking: boolean; db: number }>();

  constructor(private readonly options: { thresholdDb: number; holdMs: number }) {}

  feed(id: string, db: number, nowMs: number): void {
    let person = this.people.get(id);
    if (!person) {
      const created = {
        speaking: false,
        db,
        gate: createVoiceGate({
          thresholdDb: this.options.thresholdDb,
          holdMs: this.options.holdMs,
          onChange: (open) => (created.speaking = open),
        }),
      };
      person = created;
      this.people.set(id, person);
    }
    person.db = db;
    person.gate.feed(db, nowMs);
  }

  get(id: string): SpeechState | undefined {
    const person = this.people.get(id);
    return person && { speaking: person.speaking, level: person.speaking ? dbToMeter(person.db) : 0 };
  }

  remove(id: string): void {
    this.people.delete(id);
  }

  clear(): void {
    this.people.clear();
  }
}
