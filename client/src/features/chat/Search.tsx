import { useState } from "react";
import { X } from "lucide-react";
import type { ItemView } from "../../chat/api";
import { IconButton } from "../../ui/IconButton";
import { plainMentions } from "./MessageText";

const SNIPPET = 80;

/** Lower case, ё as е: «Ёлку» and «елку» are the same search. */
function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/** Whether a message or poll has `query` in its text (mentions by nickname), its files' names or its question. */
export function matches(item: ItemView, query: string, names: Map<string, string>): boolean {
  const wanted = fold(query.trim());
  if (!wanted || item.deleted) return false;
  const said = [plainMentions(item.text, names), ...item.files.map((f) => f.name), item.poll?.question ?? ""].join("\n");
  return fold(said).includes(wanted);
}

function snippet(item: ItemView, names: Map<string, string>): string {
  const text = item.poll?.question ?? (item.text ? plainMentions(item.text, names) : item.files.map((f) => f.name).join(", "));
  const chars = [...text.replace(/\s+/g, " ")];
  return chars.length > SNIPPET ? chars.slice(0, SNIPPET - 1).join("") + "…" : chars.join("");
}

type Props = {
  items: ItemView[];
  names: Map<string, string>;
  onJump: (id: string) => void;
  onClose: () => void;
};

/** Search in the channel's history on this PC: the matches, newest last; a click goes to the message. */
export function Search({ items, names, onJump, onClose }: Props) {
  const [query, setQuery] = useState("");
  const found = items.filter((item) => matches(item, query, names));
  return (
    <div className="chat-search">
      <div className="chat-search-row">
        <input
          type="search"
          className="input"
          aria-label="Поиск по чату"
          placeholder="Поиск по чату"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <IconButton label="Закрыть поиск" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      {query.trim() &&
        (found.length === 0 ? (
          <p className="chat-search-none">Ничего не нашлось</p>
        ) : (
          <ul className="chat-search-results" aria-label="Найдено">
            {found.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => onJump(item.id)}>
                  <span className="chat-search-author">{names.get(item.author) ?? "Без ника"}</span>
                  <span className="chat-search-text">{snippet(item, names)}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
