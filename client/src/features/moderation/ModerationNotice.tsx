import { X } from "lucide-react";
import type { MediaRef } from "../../server/session";
import { IconButton } from "../../ui/IconButton";
import { MediaView } from "./GifPicker";
import "./moderation.css";

export type Notice = { userName: string; kind: "kick" | "ban"; reason: string; media: MediaRef | null };

/**
 * What the others in the punished person's channel see: «Вася кикнут: причина» with the same
 * GIF; its sound follows «Звук гифок модерации».
 */
export function ModerationNotice({ address, notice, gifSound, onClose }: { address: string; notice: Notice; gifSound: boolean; onClose: () => void }) {
  const verb = notice.kind === "kick" ? "кикнут" : "забанен";
  const text = notice.reason ? `${notice.userName} ${verb}: ${notice.reason}` : `${notice.userName} ${verb}`;
  return (
    <div className="moderation-notice" role="status">
      {notice.media && <MediaView address={address} media={notice.media} muted={!gifSound} />}
      <span className="moderation-notice-text">{text}</span>
      <IconButton label="Закрыть" onClick={onClose}>
        <X size={16} />
      </IconButton>
    </div>
  );
}
