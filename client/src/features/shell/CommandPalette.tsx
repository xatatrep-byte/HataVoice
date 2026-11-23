import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";

export type Command = {
  id: string;
  /** What it is called. */
  title: string;
  /** Where it belongs: «Комната», «Человек», «Настройки». */
  kind: string;
  icon?: ReactNode;
  /** More words it can be found by. */
  words?: string;
  run: () => void;
};

/** Commands whose every word is found in their title or words, the ones that begin with it first. */
export function findCommands(commands: Command[], query: string): Command[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  const hay = (c: Command) => `${c.title} ${c.kind} ${c.words ?? ""}`.toLowerCase();
  const found = commands.filter((c) => words.every((w) => hay(c).includes(w)));
  const starts = (c: Command) => (c.title.toLowerCase().startsWith(words[0]!) ? 0 : 1);
  return [...found].sort((a, b) => starts(a) - starts(b));
}

/** Everything in the program by a few letters: rooms, people, settings, things to do. */
export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);
  const found = useMemo(() => findCommands(commands, query).slice(0, 40), [commands, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.children[index]?.scrollIntoView?.({ block: "nearest" });
  }, [index]);
  if (!open) return null;
  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };
  return (
    <div className="palette-shade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Поиск по программе">
        <label className="palette-field">
          <Search size={17} aria-hidden />
          <input
            autoFocus
            value={query}
            placeholder="Комната, человек, настройка, действие…"
            aria-label="Что найти"
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(found.length - 1, i + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              }
              if (e.key === "Enter") run(found[index]);
            }}
          />
        </label>
        <ul className="palette-list" ref={list}>
          {found.map((command, i) => (
            <li key={command.id}>
              <button type="button" className={i === index ? "palette-item active" : "palette-item"} onMouseEnter={() => setIndex(i)} onClick={() => run(command)}>
                <span className="palette-icon">{command.icon}</span>
                <span className="palette-title">{command.title}</span>
                <span className="label">{command.kind}</span>
              </button>
            </li>
          ))}
          {found.length === 0 && <li className="palette-none">Ничего не нашлось</li>}
        </ul>
      </div>
    </div>
  );
}
