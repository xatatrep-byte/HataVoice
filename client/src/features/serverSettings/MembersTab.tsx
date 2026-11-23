import { useState } from "react";
import { displayName, hasPermission, type MemberView } from "../../server/session";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { banEnd } from "../moderation/KickedCard";
import { outranks } from "../moderation/menu";
import { canManageRole, nameOf } from "./labels";
import type { TabProps } from "./ServerSettingsModal";

/** Everyone with their roles (handed out by those who may), the bans, and passing ownership on. */
export function MembersTab({ state, post, onPerson }: TabProps & { onPerson?: (userId: string) => void }) {
  const { me } = state;
  const grantable = state.roles.filter((r, index) => r.id !== "everyone" && canManageRole(me, index));
  const mayGrant = (m: MemberView) => hasPermission(me, "manage_roles") && m.user_id !== me.user_id && outranks(me, m);

  function toggleRole(m: MemberView, role: string) {
    const wanted = m.roles.includes(role) ? m.roles.filter((r) => r !== role) : [...m.roles, role];
    const roles = state.roles.map((r) => r.id).filter((id) => wanted.includes(id));
    void post({ type: "member_roles", user: m.user_id, roles }).catch(() => {});
  }

  return (
    <>
      <ul className="plain-list">
        {state.members.map((m) => (
          <li key={m.user_id} className="plain-row member-entry">
            <button type="button" className="member-open" disabled={!onPerson} onClick={() => onPerson?.(m.user_id)}>
              <Avatar name={displayName(m)} color={m.color} size={28} />
              <span className="plain-main">
                <span style={m.top_role_color ? { color: m.top_role_color } : undefined}>{displayName(m)}</span>
                <span className="hint">
                  {m.is_owner
                    ? "Владелец"
                    : m.roles.map((id) => state.roles.find((r) => r.id === id)?.name ?? id).join(", ") || "Участник"}
                </span>
              </span>
            </button>
            {mayGrant(m) && grantable.length > 0 && (
              <span className="member-roles">
                {grantable.map((r) => (
                  <label key={r.id} className="check">
                    <input
                      type="checkbox"
                      aria-label={`${m.nickname}: ${r.name}`}
                      checked={m.roles.includes(r.id)}
                      onChange={() => toggleRole(m, r.id)}
                    />
                    {r.name}
                  </label>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>

      {hasPermission(me, "ban_members") && (
        <>
          <h3 className="settings-sub">Забаненные</h3>
          {state.bans.length === 0 ? (
            <p className="hint">Никого.</p>
          ) : (
            <ul className="plain-list">
              {state.bans.map((ban) => {
                const who = ban.nickname ?? ban.user_id.slice(0, 4);
                return (
                  <li key={ban.user_id} className="plain-row" aria-label={who}>
                    <span className="plain-main">
                      <span>{who}</span>
                      {ban.reason && <span>{ban.reason}</span>}
                      <span className="hint">{`забанил ${nameOf(state, ban.by)} · ${banEnd(ban.until)}`}</span>
                    </span>
                    <Button onClick={() => void post({ type: "unban", user: ban.user_id }).catch(() => {})}>Разбанить</Button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {me.is_owner && <OwnerTransfer state={state} post={post} />}
    </>
  );
}

function OwnerTransfer({ state, post }: Pick<TabProps, "state" | "post">) {
  const others = state.members.filter((m) => m.user_id !== state.me.user_id);
  const [to, setTo] = useState(others[0]?.user_id ?? "");
  const [confirming, setConfirming] = useState(false);
  const target = others.find((m) => m.user_id === to);
  if (others.length === 0) return null;
  return (
    <>
      <h3 className="settings-sub">Владение</h3>
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor="new-owner">
            Новый владелец
          </label>
          <select id="new-owner" className="select" value={to} onChange={(e) => setTo(e.currentTarget.value)}>
            {others.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {displayName(m)}
              </option>
            ))}
          </select>
        </div>
        <Button variant="danger" disabled={!target} onClick={() => setConfirming(true)}>
          Передать владение…
        </Button>
      </div>
      {confirming && target && (
        <div className="confirm-box">
          <p>{`Передать «${state.profile.name}» участнику ${displayName(target)}? Ты станешь админом, вернуть владение сам не сможешь.`}</p>
          <div className="field-row">
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                void post({ type: "owner_transfer", to: target.user_id }).catch(() => {});
              }}
            >
              Передать
            </Button>
            <Button onClick={() => setConfirming(false)}>Отмена</Button>
          </div>
        </div>
      )}
    </>
  );
}
