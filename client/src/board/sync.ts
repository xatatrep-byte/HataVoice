/**
 * One's side of the call's drawing board: the board as everyone has it, what we change on it (sent to the others, sealed
 * with our call key, in packets of a few hundredths of a second), and what comes from them (opened with theirs, checked,
 * applied). One who comes later says hello; the board's owner answers with all of it, in pieces.
 */
import { boardKey, openPacket, sealPacket } from "./crypto";
import { applyOps, canDraw, chunkSnapshot, emptyBoard, joinChunks, readOps, snapshotOf, type Board, type Chunk, type Op, type Point, type ShapeTool, type Stroke, type Tool } from "./model";

/** Where the call keys come from (`voice/callKeys.ts`; fixed ones in checks). */
export type BoardKeys = {
  own: (me: string) => { index: number; key: string } | null;
  of: (identity: string, index: number) => string | null;
};

/** A packet's ops stay under this much JSON (sealed, it fits the call's channel). */
const PACKET_JSON = 12_000;
/** A laser dot lasts this long, ms. */
export const LASER_MS = 1200;

/** A thing we did on the board: drew a stroke (by its id), or erased strokes (as they were). */
type Step = { k: "drew"; id: string } | { k: "erased"; strokes: Stroke[] };
/** A thing taken back: a stroke to draw again, or strokes (by their ids now) to erase again. */
type Undone = { k: "draw"; stroke: Stroke } | { k: "erase"; ids: string[] };

export class BoardSync {
  board: Board = emptyBoard();
  /** Where each one's laser was last, and when (this PC's clock). */
  readonly lasers = new Map<string, { at: Point; time: number }>();
  private queue: (Op | Chunk)[] = [];
  private sent = 0;
  private strokes = 0;
  private readonly heard = new Map<string, number>();
  private readonly pieces = new Map<string, Chunk[]>();
  private readonly derived = new Map<string, Promise<CryptoKey>>();
  /** What we did, newest last, for «назад» (a stroke drawn, or strokes erased); and what was taken back, for «вперёд». */
  private readonly done: Step[] = [];
  private readonly undone: Undone[] = [];
  private changed: () => void = () => {};
  /** Packets are opened one after another, in the order they came: opening takes a moment, and the next one must not
   * get ahead (it would make the one before look old). */
  private inbox: Promise<void> = Promise.resolve();

  constructor(
    readonly me: string,
    private readonly keys: BoardKeys,
    private readonly send: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
    /** The wall clock, ms: packets count on from it, so one who restarts is still heard (and nothing old is taken). */
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Called on every change of the board (the view draws again). */
  onChange(listener: () => void) {
    this.changed = listener;
  }

  get canDraw(): boolean {
    return canDraw(this.board, this.me);
  }

  get owner(): boolean {
    return this.board.owner === this.me;
  }

  private nextId(): string {
    return `${this.me}:${++this.strokes}`;
  }

  /** Ours, at once here and to the others in the next packet. */
  private local(ops: (Op | Chunk)[]) {
    this.board = applyOps(this.board, this.me, ops.filter((op): op is Op => op.t !== "chunk"));
    this.queue.push(...ops);
    this.changed();
  }

  open() {
    this.local([{ t: "open", owner: this.me }]);
  }

  close() {
    if (this.owner) this.local([{ t: "close" }]);
  }

  setRights(everyone: boolean, allowed: string[]) {
    if (this.owner) this.local([{ t: "perm", everyone, allowed }]);
  }

  hello() {
    this.queue.push({ t: "hello" });
  }

  startPath(tool: Tool, color: string, size: number, pts: number[]): string {
    const id = this.nextId();
    if (!this.canDraw) return id;
    this.local([{ t: "s", id, tool, color, size, pts }]);
    this.did({ k: "drew", id });
    return id;
  }

  addPoints(id: string, pts: number[]) {
    if (this.canDraw && pts.length) this.local([{ t: "p", id, pts }]);
  }

  shape(tool: ShapeTool, color: string, size: number, a: Point, b: Point): string {
    const id = this.nextId();
    if (!this.canDraw) return id;
    this.local([{ t: "shape", id, tool, color, size, a, b }]);
    this.did({ k: "drew", id });
    return id;
  }

  text(color: string, size: number, at: Point, text: string): string {
    const id = this.nextId();
    if (!this.canDraw || !text.trim()) return id;
    this.local([{ t: "text", id, color, size, at, text: text.slice(0, 500) }]);
    this.did({ k: "drew", id });
    return id;
  }

  private did(step: Step) {
    this.done.push(step);
    this.done.splice(0, Math.max(0, this.done.length - 200));
    this.undone.length = 0;
  }

  /** Strokes off the board for everyone (ours; anyone's for the owner), kept for «назад». */
  erase(ids: string[]) {
    const wanted = new Set(ids);
    const strokes = this.board.strokes.filter((s) => wanted.has(s.id) && (this.owner || s.by === this.me));
    if (strokes.length === 0) return;
    this.local([{ t: "x", ids: strokes.map((s) => s.id) }]);
    this.did({ k: "erased", strokes });
  }

  /** A stroke on the board again, as a new one of ours: its id. */
  private again(stroke: Stroke): string {
    const id = this.nextId();
    if (stroke.kind === "path") {
      this.local([{ t: "s", id, tool: stroke.tool, color: stroke.color, size: stroke.size, pts: stroke.pts.slice(0, 2000) }]);
      for (let at = 2000; at < stroke.pts.length; at += 2000) this.local([{ t: "p", id, pts: stroke.pts.slice(at, at + 2000) }]);
    } else if (stroke.kind === "shape") this.local([{ t: "shape", id, tool: stroke.tool, color: stroke.color, size: stroke.size, a: stroke.a, b: stroke.b }]);
    else this.local([{ t: "text", id, color: stroke.color, size: stroke.size, at: stroke.at, text: stroke.text }]);
    return id;
  }

  /** The last thing we did, taken back for everyone: a stroke drawn goes, strokes erased come back. */
  undo() {
    if (!this.canDraw) return;
    while (this.done.length) {
      const step = this.done.pop()!;
      if (step.k === "drew") {
        const stroke = this.board.strokes.find((s) => s.id === step.id);
        if (!stroke) continue;
        this.local([{ t: "x", ids: [step.id] }]);
        this.undone.push({ k: "draw", stroke });
      } else {
        this.undone.push({ k: "erase", ids: step.strokes.map((stroke) => this.again(stroke)) });
      }
      return;
    }
  }

  /** The last thing taken back, done again. */
  redo() {
    if (!this.canDraw) return;
    const step = this.undone.pop();
    if (!step) return;
    if (step.k === "draw") {
      this.done.push({ k: "drew", id: this.again(step.stroke) });
      return;
    }
    const wanted = new Set(step.ids);
    const strokes = this.board.strokes.filter((s) => wanted.has(s.id));
    if (strokes.length === 0) return;
    this.local([{ t: "x", ids: strokes.map((s) => s.id) }]);
    this.done.push({ k: "erased", strokes });
  }

  clear() {
    if (this.owner) this.local([{ t: "clear" }]);
  }

  laser(at: Point, now = performance.now()) {
    this.lasers.set(this.me, { at, time: now });
    this.queue.push({ t: "laser", at });
    this.changed();
  }

  /** The whole board to everyone (the owner, when someone comes into the call). */
  sendWhole() {
    if (!this.owner) return;
    this.queue.push(...chunkSnapshot(snapshotOf(this.board), `${this.me}-${Date.now().toString(36)}`));
  }

  private key(identity: string, index: number): Promise<CryptoKey> | null {
    const frame = this.keys.of(identity, index);
    if (!frame) return null;
    let key = this.derived.get(frame);
    if (!key) {
      key = boardKey(frame);
      this.derived.set(frame, key);
    }
    return key;
  }

  /** Sends what is waiting, in packets that fit the call's channel; it waits while we have no key yet. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const own = this.keys.own(this.me);
    const key = own && this.key(this.me, own.index);
    if (!own || !key) return;
    const ops = this.queue.splice(0);
    const packets: (Op | Chunk)[][] = [];
    let current: (Op | Chunk)[] = [];
    let size = 0;
    for (const op of ops) {
      const length = JSON.stringify(op).length;
      if (current.length && size + length > PACKET_JSON) {
        packets.push(current);
        current = [];
        size = 0;
      }
      current.push(op);
      size += length;
    }
    if (current.length) packets.push(current);
    const sealing = await key;
    for (const list of packets) {
      this.sent = Math.max(this.sent + 1, this.clock() * 1000);
      const bytes = await sealPacket({ n: this.sent, ops: list as Op[] }, sealing, own.index, this.me);
      await this.send(bytes).catch(() => {});
    }
  }

  /** A packet from `from`: opened with their key, newer than the last of theirs, read, applied (in the order they came). */
  receive(from: string, bytes: Uint8Array, now = performance.now()): Promise<void> {
    const next = this.inbox.then(() => this.take(from, bytes, now));
    this.inbox = next.catch(() => {});
    return next;
  }

  private async take(from: string, bytes: Uint8Array, now: number): Promise<void> {
    const raw = await openPacket(bytes, from, async (index) => this.key(from, index));
    const packet = readOps(raw);
    if (!packet) return;
    if (packet.n <= (this.heard.get(from) ?? 0)) return;
    this.heard.set(from, packet.n);
    const ops: Op[] = [];
    for (const op of packet.ops) {
      if (op.t === "chunk") {
        const key = `${from}|${op.id}`;
        const got = [...(this.pieces.get(key) ?? []).filter((c) => c.part !== op.part), op];
        const whole = joinChunks(got);
        if (whole) {
          this.pieces.delete(key);
          ops.push(whole);
        } else this.pieces.set(key, got.slice(0, 400));
      } else if (op.t === "hello") {
        if (this.owner) this.sendWhole();
      } else if (op.t === "laser") {
        this.lasers.set(from, { at: op.at, time: now });
      } else ops.push(op);
    }
    if (ops.length) this.board = applyOps(this.board, from, ops);
    this.changed();
  }
}
