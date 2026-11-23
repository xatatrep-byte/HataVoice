import { useState } from "react";
import { GripVertical, Plus } from "lucide-react";
import type { Permission, RoleDef } from "../../server/session";
import { Button } from "../../ui/Button";
import { Swatches } from "../../ui/Swatches";
import { canManageRole, PERMISSION_LABELS, PERMISSIONS, roleRank } from "./labels";
import type { TabProps } from "./ServerSettingsModal";

const NO_COLOR = "none";
const ROLE_COLORS: Record<string, string> = {
  [NO_COLOR]: "Без цвета",
  "#e5484d": "Красный",
  "#f76b15": "Оранжевый",
  "#ffc53d": "Жёлтый",
  "#30a46c": "Зелёный",
  "#12a594": "Бирюзовый",
  "#3e9bff": "Синий",
  "#8e4ec6": "Фиолетовый",
  "#d6409f": "Розовый",
};

const MAX_ROLE_NAME = 32;

/** An id the journal accepts (`[a-z0-9-]`, up to 32) that no role has yet. */
function newRoleId(taken: string[]): string {
  for (;;) {
    const id = `role-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.includes(id)) return id;
  }
}

/**
 * The roles from the highest down with `dragged` dropped in front of `target`, returned in the
 * journal's order (lowest first, «@все» always at the bottom).
 */
export function reorder(roles: RoleDef[], dragged: string, target: string): string[] {
  const display = roles.map((r) => r.id).reverse().filter((id) => id !== dragged);
  display.splice(display.indexOf(target), 0, dragged);
  return display.reverse();
}

function RoleEditor({ role, editable, myRights, isOwner, post }: {
  role: RoleDef;
  editable: boolean;
  myRights: Permission[];
  isOwner: boolean;
  post: TabProps["post"];
}) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color ?? NO_COLOR);
  const [rights, setRights] = useState<Permission[]>(role.permissions);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const everyone = role.id === "everyone";
  const colors = { ...ROLE_COLORS, ...(role.color && !ROLE_COLORS[role.color] ? { [role.color]: "Свой цвет" } : {}) };

  const toggle = (p: Permission) => setRights((now) => (now.includes(p) ? now.filter((x) => x !== p) : [...now, p]));
  const save = () =>
    void post({
      type: "role_update",
      id: role.id,
      name: name.trim() || role.name,
      color: color === NO_COLOR ? null : color,
      permissions: PERMISSIONS.filter((p) => rights.includes(p)),
    }).catch(() => {});

  return (
    <div className="role-editor">
      {!editable && <p className="hint">Эту роль меняют только те, чья роль выше</p>}
      <div className="field">
        <label className="field-label" htmlFor="role-name">
          Название роли
        </label>
        <input
          id="role-name"
          className="input"
          value={name}
          maxLength={MAX_ROLE_NAME}
          disabled={!editable || everyone}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </div>
      {!everyone && editable && (
        <Swatches
          label="Цвет ника"
          value={color}
          options={Object.keys(colors)}
          colorOf={(c) => (c === NO_COLOR ? "var(--card)" : c)}
          nameOf={(c) => colors[c] ?? c}
          onChange={setColor}
        />
      )}
      <fieldset className="field rights">
        <legend className="field-label">Права</legend>
        {PERMISSIONS.map((p) => (
          <label key={p} className="check">
            <input
              type="checkbox"
              checked={rights.includes(p)}
              disabled={!editable || (!isOwner && !myRights.includes(p))}
              onChange={() => toggle(p)}
            />
            {PERMISSION_LABELS[p]}
          </label>
        ))}
      </fieldset>
      {editable && (
        <div className="modal-actions">
          {!everyone &&
            (confirmDelete ? (
              <>
                <span className="hint">Удалить роль «{role.name}»? У людей она пропадёт.</span>
                <Button variant="danger" onClick={() => void post({ type: "role_delete", id: role.id }).catch(() => {})}>
                  Удалить
                </Button>
                <Button onClick={() => setConfirmDelete(false)}>Отмена</Button>
              </>
            ) : (
              <Button onClick={() => setConfirmDelete(true)}>Удалить роль</Button>
            ))}
          <Button variant="primary" onClick={save}>
            Сохранить роль
          </Button>
        </div>
      )}
    </div>
  );
}

/** Roles by seniority (drag to reorder), and the chosen one's name, color and rights. */
export function RolesTab({ state, post }: TabProps) {
  const { me } = state;
  const [selected, setSelected] = useState<string>(state.roles[state.roles.length - 1]?.id ?? "everyone");
  const [dragged, setDragged] = useState<string | null>(null);
  const role = state.roles.find((r) => r.id === selected) ?? state.roles[0];
  const movable = (id: string) => id !== "everyone" && canManageRole(me, roleRank(state, id));

  return (
    <div className="split">
      <div className="split-list">
        <ul className="role-list" aria-label="Роли по старшинству">
          {[...state.roles].reverse().map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={r.id === role?.id ? "split-item active" : "split-item"}
                draggable={movable(r.id)}
                onClick={() => setSelected(r.id)}
                onDragStart={(e) => {
                  e.dataTransfer?.setData?.("text/plain", r.id);
                  setDragged(r.id);
                }}
                onDragOver={(e) => {
                  if (dragged && dragged !== r.id && movable(r.id)) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!dragged || dragged === r.id || !movable(r.id)) return;
                  void post({ type: "role_order", ids: reorder(state.roles, dragged, r.id) }).catch(() => {});
                  setDragged(null);
                }}
                onDragEnd={() => setDragged(null)}
              >
                {movable(r.id) && <GripVertical size={14} aria-hidden className="grip" />}
                <span className="role-dot" style={{ background: r.color ?? "transparent" }} aria-hidden />
                <span>{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <Button
          onClick={() =>
            void post({
              type: "role_create",
              id: newRoleId(state.roles.map((r) => r.id)),
              name: "Новая роль",
              color: null,
              permissions: [],
            }).catch(() => {})
          }
        >
          <Plus size={16} /> Новая роль
        </Button>
        <p className="hint">Перетащи роль выше или ниже. Права людей складываются из всех их ролей.</p>
      </div>
      {role && (
        <RoleEditor
          key={role.id + JSON.stringify(role)}
          role={role}
          editable={canManageRole(me, roleRank(state, role.id))}
          myRights={me.permissions}
          isOwner={me.is_owner}
          post={post}
        />
      )}
    </div>
  );
}
