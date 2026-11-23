import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Circle, Crosshair, Download, Eraser, Highlighter, HelpCircle, Minus, MousePointerClick, MoveUpRight, PenLine, Redo2, Square, SquareDashed, Trash2, Type, Undo2, Users, X } from "lucide-react";
import { drawBoard, lasersShowing } from "../../board/draw";
import { COLORS, hotkey, SIZES, TOOLS, type BoardTool } from "../../board/hotkeys";
import { BOARD_HEIGHT, BOARD_WIDTH, strokeAt, strokesIn, type Point, type Stroke } from "../../board/model";
import type { BoardControls } from "../../board/useBoard";
import { pickSave } from "../../files/pick";
import { toB64 } from "../../remote/api";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { notify } from "../../ui/toasts";
import "./board.css";

const ICONS: Record<BoardTool, typeof PenLine> = {
  pen: PenLine,
  marker: Highlighter,
  eraser: Eraser,
  line: Minus,
  arrow: MoveUpRight,
  rect: Square,
  ellipse: Circle,
  text: Type,
  laser: Crosshair,
};

/** Board units the eraser reaches around the pointer when it takes strokes whole. */
const ERASER_REACH = 10;

/** The three erasers: rub out what is under it, take a stroke whole, take everything a drawn-out area touches. */
export type EraserKind = "rub" | "whole" | "area";
export const ERASERS: { kind: EraserKind; name: string; icon: typeof Eraser }[] = [
  { kind: "rub", name: "Ластик: стирает там, где проведёшь", icon: Eraser },
  { kind: "whole", name: "Ластик: убирает линию или фигуру целиком", icon: MousePointerClick },
  { kind: "area", name: "Ластик: стирает всё, что задела рамка", icon: SquareDashed },
];

/** How wide the rubbing eraser is (board units) for each of the five sizes: wider than a pen. */
export const rubWidth = (size: number) => size * 3 + 6;
/** A laser dot goes out this often at most, ms. */
const LASER_EVERY_MS = 33;

type Props = {
  controls: BoardControls;
  /** Everyone else in the call, for the owner's «Кто рисует». */
  people: { id: string; name: string }[];
  nameOf: (id: string) => string;
};

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** The board's snapshot as a PNG, at its full size. */
async function savePicture(controls: BoardControls) {
  const canvas = document.createElement("canvas");
  canvas.width = BOARD_WIDTH;
  canvas.height = BOARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  drawBoard(ctx, controls.board, 1, null, new Map(), 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const where = await pickSave("any", "Доска.png").catch(() => null);
  if (!where) return;
  try {
    await invoke("save_picture", { token: where.token, data: toB64(new Uint8Array(await blob.arrayBuffer())) });
    notify.info("Доска сохранена");
  } catch (e) {
    notify.error(String(e));
  }
}

/**
 * The call's drawing board: the paper (16:9, whole on any screen), the tools on its left (each with its key), at its top
 * who leads and who may draw. What one draws everyone sees as it is drawn.
 */
export function BoardView({ controls, people, nameOf }: Props) {
  const { board, sync, me } = controls;
  const [tool, setTool] = useState<BoardTool>("pen");
  const [color, setColor] = useState(COLORS[0]!.value);
  const [sizeAt, setSizeAt] = useState(1);
  const [help, setHelp] = useState(false);
  const [rights, setRights] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [typing, setTyping] = useState<{ at: Point; text: string } | null>(null);
  const [eraser, setEraser] = useState<EraserKind>("rub");
  const [area, setArea] = useState<{ a: Point; b: Point } | null>(null);
  const ring = useRef<HTMLDivElement>(null);
  const typingBox = useRef<HTMLTextAreaElement>(null);
  const [scale, setScale] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<Stroke | null>(null);
  const drawing = useRef<{ id: string; last: Point } | { a: Point } | null>(null);
  const lastLaser = useRef(0);
  const [, redraw] = useState(0);
  const size = SIZES[sizeAt]!;
  const textSize = Math.max(18, size * 5);
  const owner = board.owner === me;
  const mayDraw = sync.canDraw;

  // The paper fits its box, 16:9, whole (measured inside the box's padding: the box itself is a flex item of its own).
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = () => {
      const { width, height } = element.getBoundingClientRect();
      setScale(Math.max(0.05, Math.min(width / BOARD_WIDTH, height / BOARD_HEIGHT)));
    };
    fit();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  // Drawn on every change, and every frame while a laser fades.
  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext?.("2d");
    if (!element || !ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    // A canvas given its size again is made anew: only when the size changed.
    const width = Math.round(BOARD_WIDTH * scale * dpr);
    const height = Math.round(BOARD_HEIGHT * scale * dpr);
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
    let frame = 0;
    const paint = () => {
      const now = performance.now();
      drawBoard(ctx, board, scale * dpr, preview.current, sync.lasers, now);
      if (lasersShowing(sync.lasers, now)) frame = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frame);
  });

  // What is typed goes on the board once: by Enter or by a click elsewhere, whichever comes first (Esc drops it).
  const typed = useRef(typing);
  typed.current = typing;
  const finishTyping = (keep: boolean) => {
    const now = typed.current;
    typed.current = null;
    if (now && keep) sync.text(color, textSize, now.at, now.text);
    setTyping(null);
  };

  // The text box takes the keys once it is there (opened when the click is over: a press would take its focus away).
  const typingOpen = typing !== null;
  useEffect(() => {
    if (typingOpen) typingBox.current?.focus();
  }, [typingOpen]);

  const act = (action: NonNullable<ReturnType<typeof hotkey>>) => {
    // E again turns to the next eraser.
    if (action.do === "tool" && action.tool === "eraser" && tool === "eraser") setEraser((kind) => ERASERS[(ERASERS.findIndex((e) => e.kind === kind) + 1) % ERASERS.length]!.kind);
    else if (action.do === "tool") setTool(action.tool);
    else if (action.do === "color") setColor(action.color);
    else if (action.do === "size") setSizeAt((at) => Math.max(0, Math.min(SIZES.length - 1, at + action.step)));
    else if (action.do === "undo") sync.undo();
    else if (action.do === "redo") sync.redo();
    else if (action.do === "save") void savePicture(controls);
    else if (action.do === "clear" && owner) setClearing(true);
    else if (action.do === "help") setHelp((on) => !on);
  };
  const actRef = useRef(act);
  actRef.current = act;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const action = hotkey(e);
      if (!action) return;
      e.preventDefault();
      actRef.current(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const at = (e: React.PointerEvent): Point => {
    const r = canvas.current!.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * BOARD_WIDTH);
    const y = Math.round(((e.clientY - r.top) / r.height) * BOARD_HEIGHT);
    return [Math.max(0, Math.min(BOARD_WIDTH, x)), Math.max(0, Math.min(BOARD_HEIGHT, y))];
  };

  const erase = ([x, y]: Point) => {
    const hit = strokeAt(board, x, y, ERASER_REACH);
    if (hit && (owner || hit.by === me)) sync.erase([hit.id]);
  };

  /** The rubbing eraser's ring follows the pointer over the paper. */
  const showRing = (e: React.PointerEvent) => {
    const element = ring.current;
    if (!element) return;
    const r = canvas.current!.getBoundingClientRect();
    element.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`;
    element.style.opacity = "1";
  };

  const onDown = (e: React.PointerEvent) => {
    if (!mayDraw || e.button !== 0) return;
    const p = at(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "pen" || tool === "marker") drawing.current = { id: sync.startPath(tool, color, size, p), last: p };
    else if (tool === "eraser" && eraser === "rub") drawing.current = { id: sync.startPath("eraser", "#000000", rubWidth(size), p), last: p };
    else if (tool === "eraser" && eraser === "area") {
      drawing.current = { a: p };
      setArea({ a: p, b: p });
    } else if (tool === "eraser") {
      drawing.current = { a: p };
      erase(p);
    } else if (tool === "text") {
      // The box opens when the click is over; the press itself would blur it at once.
      e.preventDefault();
      drawing.current = { a: p };
    } else if (tool === "laser") {
      drawing.current = { a: p };
      sync.laser(p);
    } else drawing.current = { a: p };
  };

  const onMove = (e: React.PointerEvent) => {
    if (tool === "eraser" && eraser === "rub") showRing(e);
    const now = drawing.current;
    if (!now || !mayDraw) return;
    const p = at(e);
    if ("id" in now) {
      if (Math.hypot(p[0] - now.last[0], p[1] - now.last[1]) < 2) return;
      now.last = p;
      sync.addPoints(now.id, p);
    } else if (tool === "eraser" && eraser === "area") setArea({ a: now.a, b: p });
    else if (tool === "eraser") erase(p);
    else if (tool === "laser") {
      if (performance.now() - lastLaser.current < LASER_EVERY_MS) return;
      lastLaser.current = performance.now();
      sync.laser(p);
    } else if (tool === "line" || tool === "arrow" || tool === "rect" || tool === "ellipse") {
      preview.current = { kind: "shape", id: "preview", by: me, tool, color, size, a: now.a, b: p };
      redraw((n) => n + 1);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const now = drawing.current;
    drawing.current = null;
    if (!now || "id" in now) return;
    preview.current = null;
    if (tool === "text") {
      setTyping({ at: now.a, text: "" });
      return;
    }
    if (tool === "eraser" && eraser === "area") {
      const b = at(e);
      setArea(null);
      // A click with no area takes what is under it, as the whole-stroke eraser does.
      if (Math.hypot(b[0] - now.a[0], b[1] - now.a[1]) < 4) erase(b);
      else sync.erase(strokesIn(board, now.a, b).map((s) => s.id));
      return;
    }
    if (tool === "line" || tool === "arrow" || tool === "rect" || tool === "ellipse") {
      const b = at(e);
      if (Math.hypot(b[0] - now.a[0], b[1] - now.a[1]) > 3) sync.shape(tool, color, size, now.a, b);
      redraw((n) => n + 1);
    }
  };

  const others = people.filter((p) => p.id !== board.owner);
  const drawers = board.everyone ? "все" : [nameOf(board.owner ?? ""), ...board.allowed.map(nameOf)].join(", ");
  const paper: CSSProperties = { width: BOARD_WIDTH * scale, height: BOARD_HEIGHT * scale };

  return (
    <section className="board" aria-label="Доска">
      <header className="board-head">
        <b>Доска</b>
        <span className="board-who">
          Ведёт: {owner ? "ты" : nameOf(board.owner ?? "")} · рисуют: {drawers}
        </span>
        <span className="board-spacer" />
        {owner && (
          <div className="board-rights-anchor">
            <Button onClick={() => setRights((on) => !on)} aria-expanded={rights}>
              <Users size={16} aria-hidden /> Кто рисует
            </Button>
            {rights && (
              <div className="board-rights" role="dialog" aria-label="Кто рисует">
                <label className="board-check">
                  <input type="checkbox" checked={board.everyone} onChange={(e) => sync.setRights(e.currentTarget.checked, board.allowed)} />
                  Все в звонке
                </label>
                <p className="hint">Или те, кого отметишь:</p>
                {others.length === 0 && <p className="hint">В звонке пока никого, кроме тебя.</p>}
                {others.map((p) => (
                  <label key={p.id} className="board-check">
                    <input
                      type="checkbox"
                      disabled={board.everyone}
                      checked={board.everyone || board.allowed.includes(p.id)}
                      onChange={(e) =>
                        sync.setRights(false, e.currentTarget.checked ? [...board.allowed, p.id] : board.allowed.filter((id) => id !== p.id))
                      }
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <IconButton label="Горячие клавиши (?)" onClick={() => setHelp((on) => !on)}>
          <HelpCircle size={17} />
        </IconButton>
        {owner && (
          <IconButton label="Закрыть доску для всех" onClick={() => sync.close()}>
            <X size={17} />
          </IconButton>
        )}
      </header>
      <div className="board-body">
        {mayDraw && (
          <div className="board-tools" role="toolbar" aria-label="Инструменты доски">
            {TOOLS.map((t) => {
              const Icon = ICONS[t.tool];
              return (
                <button key={t.tool} type="button" className="board-tool" aria-pressed={tool === t.tool} title={`${t.name} (${t.key})`} aria-label={t.name} onClick={() => setTool(t.tool)}>
                  <Icon size={18} aria-hidden />
                </button>
              );
            })}
            {tool === "eraser" && (
              <div className="board-erasers" role="group" aria-label="Какой ластик">
                {ERASERS.map(({ kind, name, icon: Icon }) => (
                  <button key={kind} type="button" className="board-eraser" aria-pressed={eraser === kind} aria-label={name} title={`${name} (E — следующий)`} onClick={() => setEraser(kind)}>
                    <Icon size={15} aria-hidden />
                  </button>
                ))}
              </div>
            )}
            <span className="board-sep" />
            {COLORS.map((c, i) => (
              <button
                key={c.value}
                type="button"
                className="board-color"
                aria-pressed={color === c.value}
                aria-label={c.name}
                title={`${c.name} (${i + 1})`}
                style={{ ["--swatch" as string]: c.value }}
                onClick={() => setColor(c.value)}
              />
            ))}
            <span className="board-sep" />
            {SIZES.map((s, i) => (
              <button key={s} type="button" className="board-size" aria-pressed={sizeAt === i} aria-label={`Толщина ${s}`} title="Толщина ([ и ])" onClick={() => setSizeAt(i)}>
                <i style={{ width: Math.min(18, s + 2), height: Math.min(18, s + 2) }} />
              </button>
            ))}
            <span className="board-sep" />
            <button type="button" className="board-tool" aria-label="Назад" title="Назад (Ctrl+Z)" onClick={() => sync.undo()}>
              <Undo2 size={18} aria-hidden />
            </button>
            <button type="button" className="board-tool" aria-label="Вперёд" title="Вперёд (Ctrl+Y)" onClick={() => sync.redo()}>
              <Redo2 size={18} aria-hidden />
            </button>
            <button type="button" className="board-tool" aria-label="Сохранить картинкой" title="Сохранить картинкой (Ctrl+S)" onClick={() => void savePicture(controls)}>
              <Download size={18} aria-hidden />
            </button>
            {owner && (
              <button type="button" className="board-tool danger" aria-label="Очистить доску" title="Очистить доску (Delete)" onClick={() => setClearing(true)}>
                <Trash2 size={18} aria-hidden />
              </button>
            )}
          </div>
        )}
        <div className="board-stage">
          <div className="board-fit" ref={box}>
          <div className="board-paper" style={paper}>
            <canvas
              ref={canvas}
              className={`board-canvas tool-${mayDraw ? (tool === "eraser" ? `eraser-${eraser}` : tool) : "view"}`}
              style={paper}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onPointerLeave={() => ring.current && (ring.current.style.opacity = "0")}
            />
            {mayDraw && tool === "eraser" && eraser === "rub" && (
              <div ref={ring} className="board-ring" aria-hidden style={{ width: rubWidth(size) * scale, height: rubWidth(size) * scale }} />
            )}
            {area && (
              <div
                className="board-area"
                aria-hidden
                style={{
                  left: Math.min(area.a[0], area.b[0]) * scale,
                  top: Math.min(area.a[1], area.b[1]) * scale,
                  width: Math.abs(area.b[0] - area.a[0]) * scale,
                  height: Math.abs(area.b[1] - area.a[1]) * scale,
                }}
              />
            )}
            {typing && (
              <textarea
                ref={typingBox}
                className="board-typing"
                aria-label="Текст на доске"
                placeholder="Текст"
                rows={Math.max(1, typing.text.split("\n").length)}
                value={typing.text}
                style={{ left: typing.at[0] * scale, top: (typing.at[1] - textSize) * scale, fontSize: textSize * scale, color }}
                onChange={(e) => setTyping({ ...typing, text: e.currentTarget.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") finishTyping(false);
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    finishTyping(true);
                  }
                }}
                onBlur={() => finishTyping(true)}
              />
            )}
          </div>
          </div>
          {!mayDraw && <p className="board-note">Рисует {drawers}. Чтобы рисовать, попроси ведущего отметить тебя в «Кто рисует».</p>}
        </div>
      </div>
      {clearing && (
        <div className="board-confirm" role="dialog" aria-label="Очистить доску">
          <span>Очистить доску для всех?</span>
          <Button
            variant="danger"
            onClick={() => {
              sync.clear();
              setClearing(false);
            }}
          >
            Очистить
          </Button>
          <Button onClick={() => setClearing(false)}>Отмена</Button>
        </div>
      )}
      {help && (
        <div className="board-help" role="dialog" aria-label="Горячие клавиши доски">
          <b>Горячие клавиши</b>
          <ul>
            {TOOLS.map((t) => (
              <li key={t.tool}>
                <kbd>{t.key}</kbd> {t.name}
              </li>
            ))}
            <li>
              <kbd>E</kbd> ещё раз — другой ластик (стирает, где проведёшь · убирает целиком · рамкой)
            </li>
            <li>
              <kbd>1</kbd>–<kbd>8</kbd> цвет
            </li>
            <li>
              <kbd>[</kbd> <kbd>]</kbd> тоньше / толще
            </li>
            <li>
              <kbd>Ctrl</kbd>+<kbd>Z</kbd> назад, <kbd>Ctrl</kbd>+<kbd>Y</kbd> вперёд
            </li>
            <li>
              <kbd>Ctrl</kbd>+<kbd>S</kbd> сохранить картинкой
            </li>
            <li>
              <kbd>Delete</kbd> очистить (ведущий)
            </li>
            <li>
              <kbd>Esc</kbd> к ручке, <kbd>?</kbd> эта подсказка
            </li>
          </ul>
          <Button onClick={() => setHelp(false)}>Понятно</Button>
        </div>
      )}
    </section>
  );
}
