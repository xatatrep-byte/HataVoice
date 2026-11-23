import { describe, expect, it } from "vitest";
import { applyOps, canDraw, chunkSnapshot, emptyBoard, joinChunks, readOps, snapshotOf, strokeAt, strokesIn, type Board, type Op } from "./model";

const open = (owner = "teacher"): Board => applyOps(emptyBoard(), owner, [{ t: "open", owner }]);

describe("who draws on the board", () => {
  it("the one who opened it; others once allowed one by one, or all at once", () => {
    let board = open();
    expect(canDraw(board, "teacher")).toBe(true);
    expect(canDraw(board, "anna")).toBe(false);
    board = applyOps(board, "teacher", [{ t: "perm", everyone: false, allowed: ["anna"] }]);
    expect(canDraw(board, "anna")).toBe(true);
    expect(canDraw(board, "boris")).toBe(false);
    board = applyOps(board, "teacher", [{ t: "perm", everyone: true, allowed: [] }]);
    expect(canDraw(board, "boris")).toBe(true);
  });

  it("takes rights only from the one who opened it, and strokes only from those allowed", () => {
    let board = open();
    board = applyOps(board, "anna", [{ t: "perm", everyone: true, allowed: [] }]);
    expect(canDraw(board, "anna")).toBe(false);
    board = applyOps(board, "anna", [{ t: "s", id: "anna:1", tool: "pen", color: "#ff0000", size: 4, pts: [1, 2, 3, 4] }]);
    expect(board.strokes).toEqual([]);
    expect(applyOps(board, "anna", [{ t: "open", owner: "anna" }]).owner, "nobody takes the board over").toBe("teacher");
  });

  it("its owner may open it anew (back after a restart), clean", () => {
    let board = applyOps(open(), "teacher", [{ t: "s", id: "teacher:1", tool: "pen", color: "#000000", size: 3, pts: [1, 1] }]);
    board = applyOps(board, "teacher", [{ t: "open", owner: "teacher" }]);
    expect(board.owner).toBe("teacher");
    expect(board.strokes).toEqual([]);
  });
});

describe("drawing", () => {
  it("a stroke grows as its points come, and a shape or a text is one piece", () => {
    let board = open();
    board = applyOps(board, "teacher", [{ t: "s", id: "teacher:1", tool: "pen", color: "#000000", size: 3, pts: [10, 10] }]);
    board = applyOps(board, "teacher", [{ t: "p", id: "teacher:1", pts: [20, 20, 30, 25] }]);
    board = applyOps(board, "teacher", [
      { t: "shape", id: "teacher:2", tool: "arrow", color: "#2563eb", size: 4, a: [100, 100], b: [300, 200] },
      { t: "text", id: "teacher:3", color: "#111111", size: 28, at: [400, 300], text: "x² + y² = r²" },
    ]);
    expect(board.strokes.map((s) => s.id)).toEqual(["teacher:1", "teacher:2", "teacher:3"]);
    expect((board.strokes[0] as { pts: number[] }).pts).toEqual([10, 10, 20, 20, 30, 25]);
    expect(board.strokes[0]!.by).toBe("teacher");
  });

  it("one's own strokes can be taken back; the teacher may take anyone's, a pupil only their own; the teacher clears it all", () => {
    let board = applyOps(open(), "teacher", [{ t: "perm", everyone: true, allowed: [] }]);
    board = applyOps(board, "anna", [{ t: "s", id: "anna:1", tool: "pen", color: "#000000", size: 3, pts: [1, 1] }]);
    board = applyOps(board, "boris", [{ t: "s", id: "boris:1", tool: "pen", color: "#000000", size: 3, pts: [5, 5] }]);
    board = applyOps(board, "anna", [{ t: "x", ids: ["boris:1"] }]);
    expect(board.strokes.map((s) => s.id), "not someone else's").toEqual(["anna:1", "boris:1"]);
    board = applyOps(board, "anna", [{ t: "x", ids: ["anna:1"] }]);
    board = applyOps(board, "teacher", [{ t: "x", ids: ["boris:1"] }]);
    expect(board.strokes).toEqual([]);
    board = applyOps(board, "boris", [{ t: "s", id: "boris:2", tool: "pen", color: "#000000", size: 3, pts: [5, 5] }]);
    expect(applyOps(board, "anna", [{ t: "clear" }]).strokes.length, "only the teacher clears").toBe(1);
    expect(applyOps(board, "teacher", [{ t: "clear" }]).strokes).toEqual([]);
  });

  it("finds the stroke under a point, for the eraser", () => {
    const board = applyOps(open(), "teacher", [
      { t: "s", id: "teacher:1", tool: "pen", color: "#000000", size: 4, pts: [0, 0, 100, 0] },
      { t: "shape", id: "teacher:2", tool: "rect", color: "#000000", size: 4, a: [200, 200], b: [300, 300] },
    ]);
    expect(strokeAt(board, 50, 2, 6)?.id).toBe("teacher:1");
    expect(strokeAt(board, 200, 250, 6)?.id).toBe("teacher:2");
    expect(strokeAt(board, 250, 250, 6), "inside an empty rectangle").toBeNull();
    expect(strokeAt(board, 50, 60, 6)).toBeNull();
  });
});

describe("a board for one who comes later", () => {
  it("goes in pieces small enough for the call's channel and comes back whole", () => {
    let board = open();
    for (let i = 0; i < 60; i++) {
      board = applyOps(board, "teacher", [{ t: "s", id: `teacher:${i}`, tool: "pen", color: "#000000", size: 3, pts: Array.from({ length: 200 }, (_, k) => (k * 7 + i) % 1600) }]);
    }
    const pieces = chunkSnapshot(snapshotOf(board), "snap1");
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(JSON.stringify(piece).length).toBeLessThanOrEqual(12_000);
    const whole = joinChunks(pieces.slice().reverse());
    expect(whole).not.toBeNull();
    const after = applyOps(emptyBoard(), "teacher", [whole!]);
    expect(after.strokes.length).toBe(60);
    expect(after.owner).toBe("teacher");
  });

  it("a snapshot is taken only from the one who opened the board", () => {
    const board = open();
    const fake = { ...snapshotOf(board), owner: "anna" };
    expect(applyOps(open(), "anna", [{ t: "snap", board: fake } as Op]).owner).toBe("teacher");
  });
});

describe("ops as they come from the call", () => {
  it("are read within limits and kinds; anything odd is dropped", () => {
    const ops = readOps({ n: 3, ops: [{ t: "s", id: "a:1", tool: "pen", color: "#ff0000", size: 4, pts: [1, 2, 3.7, 99999] }, { t: "hack" }, { t: "s", id: "a:2", tool: "nuke", color: "red", size: 1, pts: [] }] });
    expect(ops?.n).toBe(3);
    expect(ops?.ops).toEqual([{ t: "s", id: "a:1", tool: "pen", color: "#ff0000", size: 4, pts: [1, 2, 4, 900] }]);
    expect(readOps("nope")).toBeNull();
    expect(readOps({ n: -1, ops: [] })).toBeNull();
  });
});

describe("the three erasers", () => {
  it("a rubbing eraser is a stroke of its own: taken from one allowed, read from the call, never picked up whole", () => {
    let board = open();
    board = applyOps(board, "teacher", [
      { t: "s", id: "teacher:1", tool: "pen", color: "#000000", size: 4, pts: [0, 0, 100, 0] },
      { t: "s", id: "teacher:2", tool: "eraser", color: "#000000", size: 30, pts: [50, 0, 50, 10] },
    ]);
    expect(board.strokes.map((s) => s.kind === "path" && s.tool)).toEqual(["pen", "eraser"]);
    expect(strokeAt(board, 50, 2, 6)?.id, "the line under it, not the rubbing").toBe("teacher:1");
    const read = readOps({ n: 1, ops: [{ t: "s", id: "a:1", tool: "eraser", color: "#000000", size: 40, pts: [1, 1] }] });
    expect(read?.ops).toEqual([{ t: "s", id: "a:1", tool: "eraser", color: "#000000", size: 40, pts: [1, 1] }]);
  });

  it("an area takes every stroke that crosses it, even one with no point inside", () => {
    const board = applyOps(open(), "teacher", [
      { t: "s", id: "teacher:1", tool: "pen", color: "#000000", size: 4, pts: [0, 50, 400, 50] },
      { t: "shape", id: "teacher:2", tool: "rect", color: "#000000", size: 4, a: [150, 0], b: [250, 300] },
      { t: "text", id: "teacher:3", color: "#111111", size: 30, at: [180, 120], text: "Привет" },
      { t: "s", id: "teacher:4", tool: "pen", color: "#000000", size: 4, pts: [600, 600, 700, 700] },
      { t: "s", id: "teacher:5", tool: "eraser", color: "#000000", size: 30, pts: [190, 40, 200, 60] },
      { t: "shape", id: "teacher:6", tool: "ellipse", color: "#000000", size: 4, a: [100, 200], b: [500, 600] },
    ]);
    // An area inside the ellipse and the rectangle, crossing the line between two of its points.
    const taken = strokesIn(board, [170, 30], [240, 130]).map((s) => s.id);
    expect(taken).toEqual(["teacher:1", "teacher:3"]);
    expect(strokesIn(board, [140, 30], [260, 130]).map((s) => s.id)).toEqual(["teacher:1", "teacher:2", "teacher:3"]);
    expect(strokesIn(board, [800, 800], [900, 890])).toEqual([]);
  });

  it("a text keeps its lines", () => {
    const read = readOps({ n: 1, ops: [{ t: "text", id: "a:1", color: "#111111", size: 30, at: [10, 40], text: "раз\nдва\u0007" }] });
    expect(read?.ops).toEqual([{ t: "text", id: "a:1", color: "#111111", size: 30, at: [10, 40], text: "раз\nдва" }]);
  });
});
