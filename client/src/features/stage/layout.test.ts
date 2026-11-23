import { describe, expect, it } from "vitest";
import { stageColumns, stageGrid } from "./layout";

describe("stageColumns", () => {
  it("grows the grid with the number of people", () => {
    const counts = [0, 1, 2, 3, 4, 5, 9, 10, 20];
    expect(counts.map(stageColumns)).toEqual([1, 1, 2, 2, 2, 3, 3, 4, 4]);
  });
});

describe("stageGrid", () => {
  it("gives one person a card, not the whole window", () => {
    expect(stageGrid(1)).toEqual({ columns: 1, rows: 1, maxWidth: 560 });
    expect(stageGrid(2)).toEqual({ columns: 2, rows: 1, maxWidth: 520 });
  });

  it("has as many rows as the people need", () => {
    expect(stageGrid(3).rows).toBe(2);
    expect(stageGrid(9)).toMatchObject({ columns: 3, rows: 3 });
    expect(stageGrid(11)).toMatchObject({ columns: 4, rows: 3 });
  });
});
