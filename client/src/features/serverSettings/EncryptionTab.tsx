import { useState } from "react";
import { chatReset } from "../../chat/api";
import { serverErrorText } from "../../server/session";
import { Button } from "../../ui/Button";
import { notify } from "../../ui/toasts";
import type { TabProps } from "./ServerSettingsModal";

/** How much of the chat a newcomer is given, in days. */
export const HISTORY_CHOICES: { days: number; label: string }[] = [
  { days: 0, label: "Не передавать" },
  { days: 7, label: "За неделю" },
  { days: 30, label: "За месяц" },
  { days: 90, label: "За 90 дней" },
];

/** The newcomers' history, and the owner's way out when nobody holds the keys of the chat any more. */
export function EncryptionTab({ address, state, post }: TabProps) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    try {
      await chatReset(address);
      notify.info("Группа шифрования пересоздана: участники войдут в неё сами");
      setConfirm(false);
    } catch (e) {
      notify.error(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="encryption-tab">
      <p className="hint">Ключи чата есть только у участников. Сервер хранит шифротекст. Новичка добавляет любой участник в сети.</p>
      <label className="field">
        <span>История для новичков</span>
        <select
          className="input"
          value={state.settings.history_days}
          onChange={(e) =>
            void post({ type: "server_settings", ...state.settings, history_days: Number(e.currentTarget.value) }).catch(() => {})
          }
        >
          {HISTORY_CHOICES.map((choice) => (
            <option key={choice.days} value={choice.days}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">Сообщения за этот срок передаёт участник, добавивший новичка. Они подписаны авторами, подделать их нельзя. Удалённые не передаются.</p>
      <p className="hint">
        Если чат ни у кого не подключается (например, все переустановили программу), группу можно пересоздать. Все
        войдут в неё заново; старые сообщения останутся только на тех ПК, где они уже есть.
      </p>
      {confirm ? (
        <div className="modal-actions">
          <span className="hint">Пересоздать группу шифрования для всех?</span>
          <Button variant="danger" disabled={busy} onClick={() => void reset()}>
            Пересоздать
          </Button>
          <Button onClick={() => setConfirm(false)}>Отмена</Button>
        </div>
      ) : (
        <Button onClick={() => setConfirm(true)}>Пересоздать группу шифрования</Button>
      )}
    </div>
  );
}
