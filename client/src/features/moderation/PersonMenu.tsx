import { useState } from "react";
import { Volume2 } from "lucide-react";
import {
  displayName,
  moderate,
  postEntry,
  serverErrorText,
  type MemberView,
  type ServerStateView,
} from "../../server/session";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { notify } from "../../ui/toasts";
import { KickBanDialog, type Punishment } from "./KickBanDialog";
import { menuItems, type MenuAction } from "./menu";
import { MuteDialog } from "./MuteDialog";
import "./moderation.css";

type Step = "menu" | "mute" | "move" | "kick" | "ban";

const DAY = 86_400;

type Props = {
  address: string;
  state: ServerStateView;
  target: MemberView;
  /** Server clock minus ours, seconds; without it the state's own clock is used. */
  clockOffset?: number;
  onClose: () => void;
  /** Opens our direct messages with them. */
  onWrite?: () => void;
};

/** Who the person is and what you may do to them, one step at a time. */
export function PersonMenu({ address, state, target, clockOffset, onClose, onWrite }: Props) {
  const [step, setStep] = useState<Step>("menu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = displayName(target);
  const serverNow = () => (clockOffset === undefined ? state.server_time : Math.floor(Date.now() / 1000 + clockOffset));

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      notify.info(done);
      onClose();
    } catch (e) {
      setError(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  function choose(id: MenuAction) {
    if (id === "unmute") void run(() => moderate(address, { action: "unmute", user: target.user_id }), `С ${name} снят мут`);
    else if (id === "disconnect") void run(() => moderate(address, { action: "disconnect", user: target.user_id }), `${name} выгнан из канала`);
    else setStep(id);
  }

  function punish(kind: "kick" | "ban", p: Punishment) {
    const media = p.media?.media ?? null;
    const body =
      kind === "kick"
        ? ({ type: "kick", user: target.user_id, reason: p.reason, media } as const)
        : ({ type: "ban", user: target.user_id, until: p.days === null ? null : serverNow() + p.days * DAY, reason: p.reason, media } as const);
    void run(() => postEntry(address, body), kind === "kick" ? `${name} кикнут` : `${name} забанен`);
  }

  const roleNames = target.roles.map((id) => state.roles.find((r) => r.id === id)?.name ?? id);
  const where = state.channels.find((c) => c.id === target.channel)?.name;

  const titles: Record<Step, string> = {
    menu: name,
    mute: `${name} — заглушить для всех`,
    move: `${name} — перенести в комнату`,
    kick: `${name} — кикнуть с сервера`,
    ban: `${name} — забанить`,
  };

  return (
    <Modal open onClose={onClose} title={titles[step]}>
      {step === "menu" && (
        <>
          <div className="person-head">
            <Avatar name={name} color={target.color} size={48} frame={target.frame} />
            <div>
              <div className="person-name" style={target.top_role_color ? { color: target.top_role_color } : undefined}>
                {name}
              </div>
              <div className="hint">
                {[target.is_owner ? "Владелец" : null, ...roleNames].filter(Boolean).join(", ") || "Участник"}
              </div>
              {where && <div className="hint">в «{where}»</div>}
              {target.activity && <div className="person-activity">играет в {target.activity}</div>}
            </div>
          </div>
          <div className="person-actions">
            {onWrite && target.user_id !== state.me.user_id && (
              <Button
                variant="primary"
                onClick={() => {
                  onWrite();
                  onClose();
                }}
              >
                Написать
              </Button>
            )}
            {menuItems(state.me, target).map((item) => (
              <Button
                key={item.id}
                variant={item.id === "kick" || item.id === "ban" ? "danger" : "secondary"}
                disabled={item.disabled || busy}
                title={item.hint}
                onClick={() => choose(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>
          {menuItems(state.me, target).some((i) => i.disabled) && <p className="hint">Его роль не ниже твоей</p>}
        </>
      )}
      {step === "mute" && (
        <MuteDialog
          busy={busy}
          onBack={() => setStep("menu")}
          onSubmit={(minutes, reason) =>
            void run(() => moderate(address, { action: "mute", user: target.user_id, minutes, reason }), `${name} заглушён`)
          }
        />
      )}
      {step === "move" && (
        <>
          <div className="person-actions">
            {state.channels
              .filter((c) => c.id !== target.channel)
              .map((c) => (
                <Button
                  key={c.id}
                  disabled={busy}
                  onClick={() =>
                    void run(() => moderate(address, { action: "move", user: target.user_id, channel: c.id }), `${name} перенесён в «${c.name}»`)
                  }
                >
                  <Volume2 size={16} aria-hidden /> {c.name}
                </Button>
              ))}
          </div>
          <div className="modal-actions">
            <Button onClick={() => setStep("menu")}>Назад</Button>
          </div>
        </>
      )}
      {(step === "kick" || step === "ban") && (
        <KickBanDialog kind={step} address={address} busy={busy} onBack={() => setStep("menu")} onSubmit={(p) => punish(step, p)} />
      )}
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}
