import { useEffect, useMemo, useReducer, useRef } from "react";
import { callKeyOf, latestCallKey, onCallKeysChanged } from "../voice/callKeys";
import { emptyBoard, type Board } from "./model";
import { onDrawing } from "./net";
import { BoardSync } from "./sync";

/** How often what we drew goes out, ms: a stroke is seen growing, in a few packets a second. */
const FLUSH_MS = 40;

export type BoardControls = {
  board: Board;
  sync: BoardSync;
  me: string;
};

type Props = {
  /** Our user id (our identity in the call). */
  me: string;
  /** The call we are in ("address|channel"), or null. */
  call: string | null;
  /** Everyone in the call now, ourselves too. */
  people: string[];
  send: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
};

/** The call's drawing board on our side: null outside a call. */
export function useBoard({ me, call, people, send }: Props): BoardControls | null {
  const latest = useRef(send);
  latest.current = send;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const sync = useMemo(
    () => (call && me ? new BoardSync(me, { own: (who) => latestCallKey(who), of: (who, index) => callKeyOf(who, index) }, (bytes) => latest.current(bytes)) : null),
    [call, me],
  );

  useEffect(() => {
    if (!sync) return;
    let frame = 0;
    // Drawn again once a frame at most, however many packets came.
    sync.onChange(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        bump();
      });
    });
    const timer = setInterval(() => void sync.flush(), FLUSH_MS);
    const stopHearing = onDrawing((from, bytes) => void sync.receive(from, bytes));
    // Once we have a key: one who comes into a call asks if a board is open there.
    let asked = false;
    const ask = () => {
      if (asked || !latestCallKey(me)) return;
      asked = true;
      sync.hello();
    };
    ask();
    const stopKeys = onCallKeysChanged(ask);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      stopHearing();
      stopKeys();
    };
  }, [sync, me]);

  // Someone came into the call: the board's owner gives them all of it. The owner left: the board goes.
  const everyone = [...people].sort().join(" ");
  const before = useRef<string[]>([]);
  useEffect(() => {
    if (!sync) return;
    const now = everyone ? everyone.split(" ") : [];
    const came = now.some((id) => !before.current.includes(id));
    before.current = now;
    if (came && sync.owner) sync.sendWhole();
    const owner = sync.board.owner;
    if (owner && owner !== me && !now.includes(owner)) {
      sync.board = emptyBoard();
      bump();
    }
  }, [everyone, sync, me]);

  if (!sync) return null;
  return { board: sync.board, sync, me };
}
