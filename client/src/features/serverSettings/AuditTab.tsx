import { useEffect, useState } from "react";
import { auditLog, serverErrorText, type AuditEntry } from "../../server/session";
import { Button } from "../../ui/Button";
import { ACTION_LABELS, formatDate, nameOf } from "./labels";
import type { TabProps } from "./ServerSettingsModal";

const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);

/** «Хозяин → Вася: кик — спам», or «Хозяин: новая комната» when nobody was the target. */
export function auditLine(state: TabProps["state"], entry: AuditEntry): string {
  const action = ACTION_LABELS[entry.kind] ?? entry.kind;
  const who = nameOf(state, entry.actor);
  const head = entry.target ? `${who} → ${nameOf(state, entry.target)}: ${action}` : `${who}: ${action}`;
  const reason = typeof entry.detail.reason === "string" ? entry.detail.reason.trim() : "";
  return reason ? `${head} — ${reason}` : head;
}

/** Who did what to whom and when, filtered by a person and an action; older pages on demand. */
export function AuditTab({ address, state }: TabProps) {
  const [user, setUser] = useState("");
  const [kind, setKind] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(before: number | null) {
    try {
      const page = await auditLog(address, { user: user || null, kind: kind || null, before });
      setEntries((now) => (before === null ? page : [...now, ...page]));
      setMore(page.length > 0);
      setError(null);
    } catch (e) {
      setError(serverErrorText(e));
    }
  }

  useEffect(() => {
    void load(null);
    // Reloads from the newest whenever a filter changes.
  }, [address, user, kind]);

  return (
    <>
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor="audit-user">
            Человек
          </label>
          <select id="audit-user" className="select" value={user} onChange={(e) => setUser(e.currentTarget.value)}>
            <option value="">Все</option>
            {state.members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.nickname}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="audit-kind">
            Действие
          </label>
          <select id="audit-kind" className="select" value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
            <option value="">Все</option>
            {Object.entries(ACTION_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {capital(label)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {entries.length === 0 && !error ? (
        <p className="hint">Ничего не найдено.</p>
      ) : (
        <ul className="plain-list">
          {entries.map((entry, i) => (
            <li key={`${entry.at}-${entry.kind}-${i}`} className="plain-row">
              <span className="plain-main">
                <span>{auditLine(state, entry)}</span>
                {!entry.verified && <span className="form-error">Нет подписи: это мог подделать сервер</span>}
                <span className="hint">{formatDate(entry.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {more && entries.length > 0 && (
        <Button onClick={() => void load(entries[entries.length - 1]!.at)}>Показать раньше</Button>
      )}
    </>
  );
}
