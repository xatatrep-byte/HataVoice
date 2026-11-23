import { useEffect, useId, useRef, useState } from "react";
import { LockKeyhole, LockKeyholeOpen } from "lucide-react";
import { tunnelState, type MemberView, type TunnelState } from "../../server/session";
import { useServers } from "../../state/servers";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { ENCRYPTION_FAILED, type CallSecurity } from "../../voice/callSecurity";
import type { ParticipantView } from "../../voice/participants";

const LOCK_WORDS = {
  secure: "Звонок зашифрован",
  pending: "Устанавливаю шифрование…",
  failed: "Не удалось зашифровать",
} as const;

export const CODE_HINT = "Сверьте вслух пару групп цифр. Совпали значит, посередине никого нет";
export const TLS_LINE = "Соединение с сервером: TLS 1.3, постквантовый обмен ключами";

/** Which way the call goes when it goes through the tunnel; asked while the popover is open. */
export function tunnelWords(state: TunnelState | null): string | null {
  if (!state) return null;
  if (!state.connected) return "Маршрут: ищем путь до сервера";
  const delay = state.rtt_ms === null ? "" : `, задержка ${state.rtt_ms} мс`;
  return state.direct ? `Маршрут: напрямую${delay}` : `Маршрут: через ретранслятор${delay}`;
}

function TunnelLine() {
  const address = useServers((s) => s.selected);
  const [state, setState] = useState<TunnelState | null>(null);
  useEffect(() => {
    if (!address) return;
    let alive = true;
    const ask = () => void tunnelState(address).then((next) => alive && setState(next)).catch(() => {});
    ask();
    const timer = setInterval(ask, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [address]);
  const words = tunnelWords(state);
  return words ? <p className="hint call-tls">{words}</p> : null;
}

/** A fingerprint is the first four characters of the user id: the same one the app shows next to a nickname. */
const FINGERPRINT_LENGTH = 4;

/** «ник · отпечаток»; for an id the journal does not know, the fingerprint alone. */
function GroupMember({ id, member }: { id: string; member: MemberView | undefined }) {
  if (!member) {
    return (
      <li className="call-member">
        <span className="call-member-fp">{id.slice(0, FINGERPRINT_LENGTH)}</span>
      </li>
    );
  }
  return (
    <li className="call-member">
      <span className="call-member-name" title={member.nickname}>
        {member.nickname || "Без ника"}
      </span>
      <span className="call-member-sep" aria-hidden>
        {" · "}
      </span>
      <span className="call-member-fp">{member.fingerprint}</span>
    </li>
  );
}

/**
 * The lock of the call: its tone says whether the call is encrypted, and pressing it opens what
 * people compare out loud (the call code) and who is inside the encryption.
 */
export function CallLock({ security, members, onRetry }: { security: CallSecurity; members: MemberView[]; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const membersTitle = useId();
  const { state } = security;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector("button")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Outside a call there is nothing to lock.
  if (state === "off") return null;

  const byId = new Map(members.map((m) => [m.user_id, m]));
  const groups = security.code?.split(/\s+/).filter(Boolean) ?? [];

  return (
    <span className="call-lock" ref={root}>
      <IconButton
        label={LOCK_WORDS[state]}
        className={`call-lock-btn lock-${state}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <LockKeyhole size={16} />
      </IconButton>
      {open && (
        <div className="call-popover" role="dialog" aria-label="Шифрование звонка">
          <p className={`call-state lock-${state}`}>
            <LockKeyhole size={16} aria-hidden /> {LOCK_WORDS[state]}
          </p>
          {state === "failed" && (
            <>
              <p className="call-error" role="alert">
                {security.error ?? ENCRYPTION_FAILED}
              </p>
              <Button variant="primary" onClick={onRetry}>
                Повторить
              </Button>
            </>
          )}
          {groups.length > 0 && (
            <>
              <p className="call-code" role="group" aria-label="Код звонка">
                {groups.map((group, i) => (
                  <span key={i} className="call-code-group">
                    {group}
                  </span>
                ))}
              </p>
              <p className="hint">{CODE_HINT}</p>
            </>
          )}
          {security.members.length > 0 && (
            <>
              <h3 className="call-members-title" id={membersTitle}>
                В зашифрованной группе
              </h3>
              <ul className="call-members" aria-labelledby={membersTitle}>
                {security.members.map((id) => (
                  <GroupMember key={id} id={id} member={byId.get(id)} />
                ))}
              </ul>
            </>
          )}
          <p className="hint call-tls">{TLS_LINE}</p>
          <TunnelLine />
        </div>
      )}
    </span>
  );
}

/**
 * Whether a person's mark «не в шифровании» is drawn: they are in the room without a key of this
 * call. Only a secure call knows its group (while the keys are on their way everyone reads as
 * outside it), and we ourselves are never outside it.
 */
export function outsideEncryption(participant: ParticipantView, security: CallSecurity): boolean {
  return security.state === "secure" && !participant.isLocal && !participant.encrypted;
}

/** The mark itself: a person without the call's keys is not heard, and does not hear us. */
export function NotEncrypted() {
  return (
    <span className="not-encrypted" title="Не слышно: нет ключей этого звонка">
      <LockKeyholeOpen size={13} aria-hidden />
      не в шифровании
    </span>
  );
}
