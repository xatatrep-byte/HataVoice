/**
 * Where each one walks on the call's 3D stage, as the stage itself has it: how far (metres, across and in depth) the spot
 * a figure heads for is from its own place in the rows. The call's stage writes it; the feed of the characters on the
 * desktop reads it, so that each one there walks as on the stage (from where it was put on the screen).
 */
let walks: ReadonlyMap<string, [number, number]> = new Map();

export function setStageWalks(now: ReadonlyMap<string, [number, number]>) {
  walks = now;
}

/** The stage's walks now, as the desktop is told them. */
export function readStageWalks(): Record<string, [number, number]> {
  return Object.fromEntries(walks);
}
