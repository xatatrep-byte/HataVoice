import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { notify } from "../../ui/toasts";
import { deleteHostedServer } from "./deleteServer";
import "./host.css";

type Props = {
  open: boolean;
  /** The server's name, as the owner sees it: typing it is the confirmation. */
  name: string;
  /** Its address on this PC (127.0.0.1:<port>). */
  address: string;
  onClose: () => void;
  onDeleted?: () => void;
};

/** Typed names compare as the owner would read them: case and spaces around do not matter. */
export const nameMatches = (typed: string, name: string) => typed.trim().toLowerCase() === name.trim().toLowerCase() && name.trim() !== "";

/** «Удалить сервер»: what goes, and the name typed to be sure. Over whatever window it was opened from. */
export function DeleteServerDialog({ open, name, address, onClose, onDeleted }: Props) {
  const fieldId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
    }
  }, [open]);

  async function remove() {
    if (!nameMatches(typed, name) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteHostedServer(address);
      notify.info(`Сервер «${name}» удалён`);
      onClose();
      onDeleted?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return createPortal(
    <Modal open onClose={busy ? () => {} : onClose} title={`Удалить сервер «${name}»?`}>
      <form
        className="delete-server"
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <p>Сервер выключится и навсегда сотрётся с этого ПК:</p>
        <ul className="delete-server-list">
          <li>комнаты и переписка в них;</li>
          <li>роли, участники и баны;</li>
          <li>приглашения — ссылки перестанут работать.</li>
        </ul>
        <p className="hint">
          Друзья больше не смогут зайти. Вернуть его нельзя: можно создать новый, но друзей придётся позвать заново.
        </p>
        <div className="field">
          <label className="field-label" htmlFor={fieldId}>
            Чтобы подтвердить, впиши название: <b className="delete-server-name">{name}</b>
          </label>
          <input
            id={fieldId}
            className="input"
            autoFocus
            value={typed}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setTyped(e.currentTarget.value)}
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="danger" type="submit" disabled={!nameMatches(typed, name) || busy}>
            <Trash2 size={15} aria-hidden /> {busy ? "Удаляю…" : "Удалить навсегда"}
          </Button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}

/** The bottom of the server's own settings: deleting it, set apart from everything else. */
export function DeleteServerZone({ name, address, onDeleted }: { name: string; address: string; onDeleted?: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <section className="danger-zone" aria-label="Удаление сервера">
      <div className="danger-zone-text">
        <strong>Удалить сервер</strong>
        <span className="hint">Сервер выключится и сотрётся с этого ПК вместе с комнатами, чатами, ролями и участниками.</span>
      </div>
      <Button variant="danger" onClick={() => setAsking(true)}>
        <Trash2 size={15} aria-hidden /> Удалить сервер
      </Button>
      <DeleteServerDialog open={asking} name={name} address={address} onClose={() => setAsking(false)} onDeleted={onDeleted} />
    </section>
  );
}
