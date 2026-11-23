import { useState } from "react";
import { Button } from "../../ui/Button";
import { Choice } from "../moderation/MuteDialog";
import type { TabProps } from "./ServerSettingsModal";

const MINUTES: { value: number; label: string }[] = [
  { value: 0, label: "Выключено" },
  { value: 5, label: "5 минут" },
  { value: 15, label: "15 минут" },
  { value: 30, label: "30 минут" },
  { value: 60, label: "1 час" },
];

/** The AFK channel and how long without input before someone is moved there. */
export function LimitsTab({ state, post }: TabProps) {
  const [channel, setChannel] = useState(state.settings.afk_channel ?? "");
  const [minutes, setMinutes] = useState(state.settings.afk_minutes);
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="afk-channel">
          АФК-комната
        </label>
        <select id="afk-channel" className="select" value={channel} onChange={(e) => setChannel(e.currentTarget.value)}>
          <option value="">Нет</option>
          {state.channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <Choice legend="Без активности" options={MINUTES} value={minutes} onChange={setMinutes} />
      <p className="hint">Кто столько не трогал клавиатуру и мышь и молчал, сам перейдёт в АФК-комната.</p>
      <div className="modal-actions">
        <Button
          variant="primary"
          onClick={() =>
            void post({ type: "server_settings", afk_channel: channel || null, afk_minutes: channel ? minutes : 0, history_days: state.settings.history_days }).catch(() => {})
          }
        >
          Сохранить
        </Button>
      </div>
    </>
  );
}
