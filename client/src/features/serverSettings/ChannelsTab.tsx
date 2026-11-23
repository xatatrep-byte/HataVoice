import { useState } from "react";
import { Hash, Plus, Volume2 } from "lucide-react";
import type { ChannelKind, ChannelOverride, ChannelView, RoleDef, Tri } from "../../server/session";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { makeChannelId } from "../channels/templates";
import { canManageRole } from "./labels";
import type { TabProps } from "./ServerSettingsModal";

const TRI_OPTIONS: { value: Tri; label: string }[] = [
  { value: "inherit", label: "Как у роли" },
  { value: "allow", label: "Разрешено" },
  { value: "deny", label: "Запрещено" },
];
const COLUMNS: { key: "view" | "connect" | "speak"; label: string }[] = [
  { key: "view", label: "видеть" },
  { key: "connect", label: "входить" },
  { key: "speak", label: "говорить" },
];
const KINDS: { value: ChannelKind; label: string }[] = [
  { value: "voice", label: "Голосовой" },
  { value: "text", label: "Текстовый" },
];
const MAX_LIMIT = 99;
const MAX_NAME = 32;

const blank = (role: string): ChannelOverride => ({ role, view: "inherit", connect: "inherit", speak: "inherit" });
const isBlank = (o: ChannelOverride) => o.view === "inherit" && o.connect === "inherit" && o.speak === "inherit";

function ChannelEditor({ channel, roles, editableRole, post }: {
  channel: ChannelView;
  roles: RoleDef[];
  editableRole: (index: number) => boolean;
  post: TabProps["post"];
}) {
  const [name, setName] = useState(channel.name);
  const [limit, setLimit] = useState(String(channel.user_limit));
  const [kind, setKind] = useState<ChannelKind>(channel.kind);
  const [rules, setRules] = useState<ChannelOverride[]>(() => roles.map((r) => channel.overrides.find((o) => o.role === r.id) ?? blank(r.id)));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (role: string, key: "view" | "connect" | "speak", value: Tri) =>
    setRules((now) => now.map((o) => (o.role === role ? { ...o, [key]: value } : o)));
  const save = () => {
    const userLimit = Math.min(MAX_LIMIT, Math.max(0, Math.floor(Number(limit) || 0)));
    void post({
      type: "channel_update",
      id: channel.id,
      name: name.trim() || channel.name,
      user_limit: userLimit,
      overrides: rules.filter((o) => !isBlank(o)),
      kind,
    }).catch(() => {});
  };

  return (
    <div className="channel-editor">
      <div className="field">
        <label className="field-label" htmlFor="channel-name">
          Название
        </label>
        <input id="channel-name" className="input" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.currentTarget.value)} />
      </div>
      <Segmented label="Что это" value={kind} options={KINDS} onChange={setKind} />
      {kind === "voice" && (
        <div className="field">
          <label className="field-label" htmlFor="channel-limit">
            Лимит людей (0 значит без лимита)
          </label>
          <input
            id="channel-limit"
            className="input narrow"
            type="number"
            min={0}
            max={MAX_LIMIT}
            value={limit}
            onChange={(e) => setLimit(e.currentTarget.value)}
          />
        </div>
      )}
      <table className="rules">
        <caption className="field-label">Права по ролям</caption>
        <thead>
          <tr>
            <th scope="col">Роль</th>
            {COLUMNS.map((c) => (
              <th key={c.key} scope="col">
                {c.label[0]!.toUpperCase() + c.label.slice(1)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roles.map((role, index) => {
            const rule = rules[index]!;
            return (
              <tr key={role.id}>
                <th scope="row">{role.name}</th>
                {COLUMNS.map((c) => (
                  <td key={c.key}>
                    <select
                      className="select"
                      aria-label={`${role.name} — ${c.label}`}
                      value={rule[c.key]}
                      disabled={!editableRole(index)}
                      onChange={(e) => set(role.id, c.key, e.currentTarget.value as Tri)}
                    >
                      {TRI_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">Если у человека несколько ролей, разрешение одной из них сильнее запрета другой.</p>
      <div className="modal-actions">
        {confirmDelete ? (
          <>
            <span className="hint">Удалить «{channel.name}»?</span>
            <Button variant="danger" onClick={() => void post({ type: "channel_delete", id: channel.id }).catch(() => {})}>
              Удалить
            </Button>
            <Button onClick={() => setConfirmDelete(false)}>Отмена</Button>
          </>
        ) : (
          <Button onClick={() => setConfirmDelete(true)}>Удалить</Button>
        )}
        <Button variant="primary" onClick={save}>
          Сохранить
        </Button>
      </div>
    </div>
  );
}

/** Channels, their limits and who may see, join and speak in each. */
export function ChannelsTab({ state, post }: TabProps) {
  const [selected, setSelected] = useState<string | null>(state.channels[0]?.id ?? null);
  const channel = state.channels.find((c) => c.id === selected) ?? state.channels[0];
  return (
    <div className="split">
      <div className="split-list">
        <ul className="role-list" aria-label="Комнаты">
          {state.channels.map((c) => (
            <li key={c.id}>
              <button type="button" className={c.id === channel?.id ? "split-item active" : "split-item"} onClick={() => setSelected(c.id)}>
                {c.kind === "text" ? <Hash size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}
                <span>{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <Button
          onClick={() => {
            const id = makeChannelId("Новая комната", state.channels.map((c) => c.id));
            void post({ type: "channel_create", id, name: "Новая комната", user_limit: 0, overrides: [] }).catch(() => {});
          }}
        >
          <Plus size={16} /> Новая комната
        </Button>
      </div>
      {channel ? (
        <ChannelEditor
          key={channel.id + JSON.stringify(channel.overrides) + channel.name + channel.user_limit + channel.kind}
          channel={channel}
          roles={state.roles}
          editableRole={(index) => canManageRole(state.me, index)}
          post={post}
        />
      ) : (
        <p className="hint">Комнат нет. Создай первую.</p>
      )}
    </div>
  );
}
