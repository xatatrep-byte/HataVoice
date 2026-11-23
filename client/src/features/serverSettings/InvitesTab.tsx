import { useState } from "react";
import { Copy } from "lucide-react";
import { createInvite, serverErrorText } from "../../server/session";
import { useShareOptions } from "./quickInvite";
import { Button } from "../../ui/Button";
import { notify } from "../../ui/toasts";
import { Choice } from "../moderation/MuteDialog";
import { canManageRole, formatDate, nameOf, roleRank } from "./labels";
import type { TabProps } from "./ServerSettingsModal";
import { Secret } from "../../ui/Secret";
import { useStreamerActive } from "../../state/streamer";

const USES: { value: number | null; label: string }[] = [
  { value: 1, label: "1 раз" },
  { value: 5, label: "5 раз" },
  { value: 25, label: "25 раз" },
  { value: null, label: "Без ограничений" },
];
const EXPIRY: { value: number | null; label: string }[] = [
  { value: 30, label: "30 минут" },
  { value: 1440, label: "1 день" },
  { value: 10_080, label: "7 дней" },
  { value: null, label: "Бессрочно" },
];

/** New links (shown once: the secret is not kept) and the live ones with their uses. */
export function InvitesTab({ address, state, clockOffset, post }: TabProps) {
  const streamer = useStreamerActive();
  const shareOptions = useShareOptions(address, state.tunnel);
  const [share, setShare] = useState(0);
  const [roles, setRoles] = useState<string[]>([]);
  const [maxUses, setMaxUses] = useState<number | null>(1);
  const [expires, setExpires] = useState<number | null>(1440);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now() / 1000 + clockOffset;
  const grantable = state.roles.filter((r, index) => r.id !== "everyone" && canManageRole(state.me, index));

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const shareAddress = (shareOptions[share] ?? shareOptions[0]!).address;
      setLink(await createInvite(address, { shareAddress, roles, maxUses, expiresMinutes: expires }));
    } catch (e) {
      setError(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      notify.info("Ссылка скопирована");
    } catch {
      notify.error("Не получилось скопировать ссылку");
    }
  }

  return (
    <>
      <h3 className="settings-sub">Новое приглашение</h3>
      {shareOptions.length > 1 && (
        <div className="field">
          <label className="field-label" htmlFor="invite-share">
            Адрес для друзей
          </label>
          <select id="invite-share" className="select" value={share} onChange={(e) => setShare(Number(e.currentTarget.value))}>
            {shareOptions.map((o, i) =>
              o.missing ? (
                <option key={o.label} value={i} disabled>
                  {o.label} — {o.missing}
                </option>
              ) : (
                <option key={o.address} value={i}>
                  {o.label}: {streamer ? "скрыто" : o.address}
                </option>
              ),
            )}
          </select>
        </div>
      )}
      {grantable.length > 0 && (
        <fieldset className="field rights">
          <legend className="field-label">Роли для новичка (кроме «@все»)</legend>
          {grantable.map((r) => (
            <label key={r.id} className="check">
              <input
                type="checkbox"
                checked={roles.includes(r.id)}
                onChange={() => setRoles((now) => (now.includes(r.id) ? now.filter((x) => x !== r.id) : [...now, r.id]))}
              />
              {r.name}
            </label>
          ))}
        </fieldset>
      )}
      <Choice legend="Сколько раз" options={USES} value={maxUses} onChange={setMaxUses} />
      <Choice legend="Срок" options={EXPIRY} value={expires} onChange={setExpires} />
      {error && <p className="form-error">{error}</p>}
      <div className="field-row">
        <Button variant="primary" disabled={busy} onClick={() => void create()}>
          Создать ссылку
        </Button>
      </div>
      {link && (
        <div className="invite-link">
          <code>
            <Secret>{link}</Secret>
          </code>
          <Button onClick={() => void copy()}>
            <Copy size={16} /> Копировать
          </Button>
          <p className="hint">Ссылка показывается один раз. Скопируй её сейчас</p>
        </div>
      )}

      <h3 className="settings-sub">Действующие приглашения</h3>
      {state.invites.length === 0 ? (
        <p className="hint">Пока нет.</p>
      ) : (
        <ul className="plain-list">
          {state.invites.map((invite) => {
            const roleNames = invite.roles.map((id) => state.roles[roleRank(state, id)]?.name ?? id);
            const expired = invite.expires_at !== null && invite.expires_at <= now;
            const end = invite.expires_at === null ? "бессрочно" : expired ? "истекло" : `до ${formatDate(invite.expires_at)}`;
            return (
              <li key={invite.key} className="plain-row">
                <span className="plain-main">
                  <span>{invite.max_uses === null ? `${invite.uses}/∞` : `${invite.uses}/${invite.max_uses}`}</span>
                  <span className="hint">
                    {[roleNames.join(", ") || "@все", end, `создал ${nameOf(state, invite.by)}`].join(" · ")}
                  </span>
                </span>
                <Button onClick={() => void post({ type: "invite_revoke", invite: invite.key }).catch(() => {})}>Отозвать</Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
