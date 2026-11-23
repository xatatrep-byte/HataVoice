import { useState } from "react";
import { Button } from "../../ui/Button";
import { GifPicker, type ChosenMedia } from "./GifPicker";
import { Choice, ReasonField } from "./MuteDialog";

const BAN_DAYS: { days: number | null; label: string; button: string }[] = [
  { days: 1, label: "1 день", button: "Забанить на 1 день" },
  { days: 7, label: "7 дней", button: "Забанить на 7 дней" },
  { days: 30, label: "30 дней", button: "Забанить на 30 дней" },
  { days: null, label: "Навсегда", button: "Забанить навсегда" },
];

export type Punishment = { reason: string; media: ChosenMedia | null; days: number | null };

/** Reason, an optional GIF or clip, and for a ban how long. */
export function KickBanDialog({
  kind,
  address,
  busy,
  onSubmit,
  onBack,
}: {
  kind: "kick" | "ban";
  address: string;
  busy: boolean;
  onSubmit: (p: Punishment) => void;
  onBack: () => void;
}) {
  const [reason, setReason] = useState("");
  const [media, setMedia] = useState<ChosenMedia | null>(null);
  const [days, setDays] = useState<number | null>(1);
  const choice = BAN_DAYS.find((d) => d.days === days)!;
  return (
    <>
      {kind === "ban" && (
        <Choice legend="Срок" options={BAN_DAYS.map((d) => ({ value: d.days, label: d.label }))} value={days} onChange={setDays} />
      )}
      <ReasonField value={reason} onChange={setReason} />
      <GifPicker address={address} value={media} onChange={setMedia} />
      <div className="modal-actions">
        <Button onClick={onBack}>Назад</Button>
        <Button variant="danger" disabled={busy} onClick={() => onSubmit({ reason: reason.trim(), media, days })}>
          {kind === "kick" ? "Кикнуть" : choice.button}
        </Button>
      </div>
    </>
  );
}
