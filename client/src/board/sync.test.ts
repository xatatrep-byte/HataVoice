import { describe, expect, it } from "vitest";
import { BoardSync, type BoardKeys } from "./sync";

const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const FRAME: Record<string, string> = { teacher: b64(1), anna: b64(2), boris: b64(3), carl: b64(4) };
const keys: BoardKeys = { own: (me) => ({ index: 0, key: FRAME[me]! }), of: (who, index) => (index === 0 ? (FRAME[who] ?? null) : null) };

/** A call of a few: what one sends, the others get, in order. */
function call(names: string[]) {
  const syncs = new Map<string, BoardSync>();
  const wire: Promise<void>[] = [];
  for (const name of names) {
    syncs.set(
      name,
      new BoardSync(name, keys, async (bytes) => {
        for (const [other, sync] of syncs) if (other !== name) wire.push(sync.receive(name, bytes));
      }),
    );
  }
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      for (const sync of syncs.values()) await sync.flush();
      await Promise.all(wire.splice(0));
    }
  };
  return { syncs, settle, of: (name: string) => syncs.get(name)! };
}

describe("the board in a call", () => {
  it("the teacher opens it and draws; everyone sees it; pupils draw once allowed", async () => {
    const { of, settle } = call(["teacher", "anna", "boris"]);
    of("teacher").open();
    const id = of("teacher").startPath("pen", "#111111", 3, [10, 10]);
    of("teacher").addPoints(id, [20, 20, 30, 30]);
    await settle();
    expect(of("anna").board.owner).toBe("teacher");
    expect(of("anna").board.strokes.map((s) => s.id)).toEqual([id]);
    expect((of("boris").board.strokes[0] as { pts: number[] }).pts).toEqual([10, 10, 20, 20, 30, 30]);

    expect(of("anna").canDraw).toBe(false);
    of("anna").startPath("pen", "#ff0000", 3, [5, 5]);
    await settle();
    expect(of("teacher").board.strokes.length, "not allowed: drawn by nobody").toBe(1);

    of("teacher").setRights(false, ["anna"]);
    await settle();
    expect(of("anna").canDraw).toBe(true);
    const mine = of("anna").startPath("marker", "#facc15", 12, [50, 50]);
    await settle();
    expect(of("teacher").board.strokes.map((s) => s.id)).toContain(mine);
    expect(of("boris").board.strokes.map((s) => s.id)).toContain(mine);
  });

  it("one's own stroke is taken back and brought again; the teacher clears the board for all", async () => {
    const { of, settle } = call(["teacher", "anna"]);
    of("teacher").open();
    of("teacher").startPath("pen", "#111111", 3, [10, 10]);
    of("teacher").shape("rect", "#2563eb", 4, [100, 100], [200, 200]);
    await settle();
    of("teacher").undo();
    await settle();
    expect(of("anna").board.strokes.length).toBe(1);
    of("teacher").redo();
    await settle();
    expect(of("anna").board.strokes.length).toBe(2);
    of("teacher").clear();
    await settle();
    expect(of("anna").board.strokes).toEqual([]);
  });

  it("one who comes later asks, and gets the whole board from the teacher", async () => {
    const { of, settle } = call(["teacher", "anna", "boris"]);
    of("teacher").open();
    for (let i = 0; i < 40; i++) of("teacher").startPath("pen", "#111111", 3, Array.from({ length: 300 }, (_, k) => (k * 3 + i) % 900));
    await settle();
    const late = call(["teacher", "carl"]);
    // Carl's call: the teacher's board as it is, and Carl asking.
    late.of("teacher").board = of("teacher").board;
    late.of("carl").hello();
    await late.settle();
    expect(late.of("carl").board.owner).toBe("teacher");
    expect(late.of("carl").board.strokes.length).toBe(40);
  });

  it("hears one who came back after a restart (their packets count on from the clock, not from one)", async () => {
    const { of, settle } = call(["teacher", "anna"]);
    of("teacher").open();
    for (let i = 0; i < 5; i++) of("teacher").startPath("pen", "#111111", 3, [i, i]);
    await settle();
    const sent: Uint8Array[] = [];
    // Back a few seconds later, as a restart takes.
    const again = new BoardSync("teacher", keys, async (bytes) => void sent.push(bytes), () => Date.now() + 5000);
    again.open();
    await again.flush();
    await of("anna").receive("teacher", sent[0]!);
    expect(of("anna").board.strokes, "the board opened anew by its owner").toEqual([]);
  });

  it("drops a packet played again, and one sealed by someone else's key", async () => {
    const { of, settle } = call(["teacher", "anna"]);
    const sent: Uint8Array[] = [];
    const spy = new BoardSync("teacher", keys, async (bytes) => void sent.push(bytes));
    spy.open();
    await spy.flush();
    spy.clear();
    await spy.flush();
    await of("anna").receive("teacher", sent[0]!);
    expect(of("anna").board.owner).toBe("teacher");
    of("anna").board = { ...of("anna").board, strokes: [{ kind: "path", id: "teacher:9", by: "teacher", tool: "pen", color: "#000000", size: 2, pts: [1, 1] }] };
    await of("anna").receive("teacher", sent[0]!);
    expect(of("anna").board.strokes.length, "the open again changes nothing").toBe(1);
    await of("anna").receive("boris", sent[1]!);
    expect(of("anna").board.strokes.length, "the teacher's clear passed off as Boris's does not open").toBe(1);
    await settle();
  });
});

describe("taking erasing back", () => {
  it("what one erased comes back with «назад» and goes again with «вперёд», for everyone", async () => {
    const { of, settle } = call(["teacher", "anna"]);
    of("teacher").open();
    const line = of("teacher").startPath("pen", "#111111", 3, [10, 10, 50, 50]);
    of("teacher").shape("rect", "#2563eb", 4, [100, 100], [200, 200]);
    await settle();
    of("teacher").erase([line]);
    await settle();
    expect(of("anna").board.strokes.length).toBe(1);
    of("teacher").undo();
    await settle();
    expect(of("anna").board.strokes.length, "the erased line is back").toBe(2);
    expect(of("anna").board.strokes.some((s) => s.kind === "path" && s.pts.join() === "10,10,50,50")).toBe(true);
    of("teacher").redo();
    await settle();
    expect(of("anna").board.strokes.length, "and erased again").toBe(1);
    of("teacher").undo();
    of("teacher").undo();
    await settle();
    expect(of("anna").board.strokes.map((s) => s.kind), "then the rectangle drawn last goes").toEqual(["path"]);
  });
});
