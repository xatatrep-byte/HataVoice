import { useEffect, useRef } from "react";
import type { VideoTrack } from "livekit-client";

type Props = {
  track: VideoTrack;
  /** Our own picture, as in a mirror. */
  mirror?: boolean;
  className?: string;
};

/** A person's camera on their tile. */
export function CameraVideo({ track, mirror = false, className = "tile-camera" }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);
  return <video ref={video} className={mirror ? `${className} mirrored` : className} autoPlay playsInline muted aria-hidden />;
}
