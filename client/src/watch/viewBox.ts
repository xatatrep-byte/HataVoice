import type { Box } from "./browser";

/** Rows and columns of points looked at over the video box. */
const ROWS = 10;
const COLUMNS = 5;
/** Less of the box than this left free, and the site is hidden rather than squeezed. */
const LEAST_ROWS = 4;

/**
 * The part of the video box the site in the call may cover. A webview is drawn over the whole page, so it goes only
 * where nothing of the program is drawn: above the call's buttons floating over the bottom of the box, below anything
 * over its top, and nowhere while a window or a menu is over its middle. `at(x, y)` says what is drawn at a point;
 * `ours(thing)`: that is the video box itself.
 */
export function visiblePart<T>(box: Box, at: (x: number, y: number) => T | null, ours: (thing: T | null) => boolean): Box | null {
  if (!(box.width > 0 && box.height > 0)) return null;
  const free: boolean[] = [];
  for (let row = 0; row < ROWS; row++) {
    const y = box.y + (box.height * (row + 0.5)) / ROWS;
    let clear = true;
    for (let column = 0; column < COLUMNS && clear; column++) clear = ours(at(box.x + (box.width * (column + 0.5)) / COLUMNS, y));
    free.push(clear);
  }
  // The longest run of free rows.
  let best = { from: 0, count: 0 };
  for (let row = 0, from = 0; row <= ROWS; row++) {
    if (row < ROWS && free[row]) continue;
    if (row - from > best.count) best = { from, count: row - from };
    from = row + 1;
  }
  if (best.count < LEAST_ROWS) return null;
  const band = box.height / ROWS;
  return { x: box.x, y: box.y + best.from * band, width: box.width, height: best.count * band };
}
