import { useState } from "react";
import { Button } from "../../ui/Button";

const DURATIONS: { minutes: number | null; label: string }[] = [
  { minutes: 5, label: "5 минут" },
  { minutes: 15, label: "15 минут" },
  { minutes: 60, label: "1 час" },
  { minutes: 1440, label: "1 день" },
  { minutes: null, label: "До снятия" },
];

export const MAX_REASON = 200;

/** One choice out of a few, as a row of chips. */
export function Choice<T>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="field choice">
      <legend className="field-label">{legend}</legend>
      {options.map((o) => (
        <label key={o.label} className={o.value === value ? "chip selected" : "chip"}>
          <input type="radio" checked={o.value === value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

export function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor="moderation-reason">
        Причина
      </label>
      <input
        id="moderation-reason"
        className="input"
        value={value}
        maxLength={MAX_REASON}
        placeholder="Её увидит человек и журнал"
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </div>
  );
}

export function MuteDialog({ busy, onSubmit, onBack }: { busy: boolean; onSubmit: (minutes: number | null, reason: string) => void; onBack: () => void }) {
  const [minutes, setMinutes] = useState<number | null>(15);
  const [reason, setReason] = useState("");
  return (
    <>
      <Choice legend="На сколько" options={DURATIONS.map((d) => ({ value: d.minutes, label: d.label }))} value={minutes} onChange={setMinutes} />
      <ReasonField value={reason} onChange={setReason} />
      <div className="modal-actions">
        <Button onClick={onBack}>Назад</Button>
        <Button variant="primary" disabled={busy} onClick={() => onSubmit(minutes, reason.trim())}>
          Заглушить
        </Button>
      </div>
    </>
  );
}
