/** Columns of the voice stage for `count` people: 1, then 2 up to four, 3 up to nine, then 4. */
export function stageColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

/**
 * The grid of the voice stage for `count` people: columns, rows, and how wide a tile may grow at most (px). The tiles
 * are fitted into the stage both ways by CSS; one or two people get cards of a sensible size, not the whole window.
 */
export function stageGrid(count: number): { columns: number; rows: number; maxWidth: number } {
  const columns = stageColumns(count);
  const rows = Math.max(1, Math.ceil(count / columns));
  return { columns, rows, maxWidth: count <= 1 ? 560 : count === 2 ? 520 : 460 };
}
