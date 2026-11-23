/**
 * The drawing board's keys, as a teacher in front of a class wants them: a letter for each tool (as Excalidraw has them,
 * so they are known), numbers for colours, brackets for the size, the usual Ctrl+Z / Ctrl+Y / Ctrl+S. Keys are read by
 * their place too, so a Russian layout works the same.
 */

export type BoardTool = "pen" | "marker" | "eraser" | "line" | "arrow" | "rect" | "ellipse" | "text" | "laser";

export const COLORS: { value: string; name: string }[] = [
  { value: "#111111", name: "Чёрный" },
  { value: "#e11d48", name: "Красный" },
  { value: "#2563eb", name: "Синий" },
  { value: "#16a34a", name: "Зелёный" },
  { value: "#ea580c", name: "Оранжевый" },
  { value: "#7c3aed", name: "Фиолетовый" },
  { value: "#facc15", name: "Жёлтый" },
  { value: "#ffffff", name: "Белый" },
];

export const SIZES = [2, 4, 8, 14, 24];

export type BoardAction =
  | { do: "tool"; tool: BoardTool }
  | { do: "color"; color: string }
  | { do: "size"; step: 1 | -1 }
  | { do: "undo" }
  | { do: "redo" }
  | { do: "save" }
  | { do: "clear" }
  | { do: "help" };

/** Each tool's key and what it is called (for the buttons' hints and the keys' list). */
export const TOOLS: { tool: BoardTool; key: string; name: string }[] = [
  { tool: "pen", key: "P", name: "Ручка" },
  { tool: "marker", key: "M", name: "Маркер" },
  { tool: "eraser", key: "E", name: "Ластик" },
  { tool: "line", key: "L", name: "Линия" },
  { tool: "arrow", key: "A", name: "Стрелка" },
  { tool: "rect", key: "R", name: "Прямоугольник" },
  { tool: "ellipse", key: "O", name: "Эллипс" },
  { tool: "text", key: "T", name: "Текст" },
  { tool: "laser", key: "K", name: "Указка" },
];

type KeyLike = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

/** The Latin letter of a key, by its place when the layout is another (KeyP on a Russian layout is «з»). */
function letter(event: KeyLike): string {
  const fromCode = /^Key([A-Z])$/.exec(event.code)?.[1];
  if (fromCode) return fromCode.toLowerCase();
  return event.key.length === 1 ? event.key.toLowerCase() : "";
}

/** What a key press does on the board, or null for one it leaves alone. */
export function hotkey(event: KeyLike): BoardAction | null {
  if (event.altKey) return null;
  const ctrl = event.ctrlKey || event.metaKey;
  const l = letter(event);
  if (ctrl) {
    if (l === "z") return event.shiftKey ? { do: "redo" } : { do: "undo" };
    if (l === "y") return { do: "redo" };
    if (l === "s") return { do: "save" };
    return null;
  }
  if (event.key === "Delete") return { do: "clear" };
  if (event.key === "?" || (event.shiftKey && event.code === "Slash")) return { do: "help" };
  if (event.key === "Escape") return { do: "tool", tool: "pen" };
  if (event.key === "[") return { do: "size", step: -1 };
  if (event.key === "]") return { do: "size", step: 1 };
  if (/^[1-8]$/.test(event.key)) return { do: "color", color: COLORS[Number(event.key) - 1]!.value };
  const tool = TOOLS.find((t) => t.key.toLowerCase() === l);
  return tool ? { do: "tool", tool: tool.tool } : null;
}
