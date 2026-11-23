import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import type { ScreenView } from "../../voice/screen";

type Props = {
  screen: ScreenView;
  /** «Твой экран» or who shows it. */
  name: string;
  /** Back to the screen, big. */
  onOpen: () => void;
};

/** An open screen, small in a corner of the 3D stage: it keeps going, and a click brings it back big. */
export function ScreenPeek({ screen, name, onOpen }: Props) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    const track = screen.track;
    if (!video || !track) return;
    track.attach(video);
    return () => {
      track.detach(video);
    };
  }, [video, screen.track]);
  return (
    <button type="button" className="screen-peek" onClick={onOpen} aria-label={`Вернуться к демонстрации: ${name}`}>
      <video ref={setVideo} autoPlay playsInline muted />
      <span className="screen-peek-label">
        <span>{name}</span>
        <Maximize2 size={14} aria-hidden />
      </span>
    </button>
  );
}
