/** The LiveKit topic of the drawing board's sealed packets (see `crypto.ts`). */
export const DRAW_TOPIC = "hv-draw";

const listeners = new Set<(from: string, bytes: Uint8Array) => void>();

/** Hears the board's packets from the others in the call; returns the stop. */
export function onDrawing(listener: (from: string, bytes: Uint8Array) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A board packet came from `from` (the call hands it here). */
export function heardDrawing(from: string, bytes: Uint8Array): void {
  for (const listener of listeners) listener(from, bytes);
}
