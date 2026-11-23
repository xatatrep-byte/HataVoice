import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { MediaRef } from "../../server/session";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { MediaView } from "./GifPicker";
import "./moderation.css";

type Props = {
  address: string;
  kind: "kick" | "ban";
  byName: string;
  reason: string;
  media: MediaRef | null;
  /** Ban end, unix seconds; null for a kick or a ban forever. */
  until: number | null;
  onClose: () => void;
};

const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

export function banEnd(until: number | null): string {
  return until === null ? "навсегда" : `до ${dateFormat.format(new Date(until * 1000))}`;
}

/** Full screen for the person who was kicked or banned: who, why, the GIF with its sound. */
export function KickedCard({ address, kind, byName, reason, media, until, onClose }: Props) {
  const [muted, setMuted] = useState(false);
  const title = kind === "kick" ? `Тебя кикнул ${byName}` : `Тебя забанил ${byName} — ${banEnd(until)}`;
  return (
    <div className="kicked-backdrop" role="alertdialog" aria-label={title}>
      <div className="kicked-card">
        {media && (
          <div className="kicked-media">
            <MediaView address={address} media={media} muted={muted} />
            {media.mime.startsWith("video/") && (
              <IconButton label={muted ? "Включить звук" : "Выключить звук"} onClick={() => setMuted((m) => !m)}>
                {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </IconButton>
            )}
          </div>
        )}
        <h1>{title}</h1>
        {reason && <p className="kicked-reason">{reason}</p>}
        <p className="hint">
          {kind === "kick" ? "Вернуться можно только по новому приглашению." : "Пока бан действует, войти нельзя даже по новой ссылке."}
        </p>
        <Button variant="primary" onClick={onClose}>
          Понятно
        </Button>
      </div>
    </div>
  );
}
