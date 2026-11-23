import { useEffect, useRef, useState } from "react";
import { coverColor } from "../../music/cover";
import type { MusicNow } from "../../music/useMusic";
import { IS_ANDROID } from "../../platform";
import { MusicCover, musicFrom } from "./MusicMini";
import { MusicSettings } from "./MusicSettings";
import "./music.css";

const BARS = 28;

/** Bars in time with the music: from the track itself on a PC, a light animation on a phone (Web Audio there is costly). */
function Visualizer({ track }: { track: MediaStreamTrack | null }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!track || IS_ANDROID || typeof AudioContext !== "function") return;
    const context = new AudioContext();
    const clone = track.clone();
    const source = context.createMediaStreamSource(new MediaStream([clone]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    source.connect(analyser);
    const levels = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(levels);
      const bars = box.current?.children;
      if (!bars) return;
      for (let i = 0; i < bars.length; i++) {
        const level = levels[Math.floor((i / bars.length) * levels.length * 0.7)] ?? 0;
        (bars[i] as HTMLElement).style.height = `${8 + Math.round((level / 255) * 52)}px`;
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      clone.stop();
      void context.close();
    };
  }, [track]);
  return (
    <div ref={box} className={track && !IS_ANDROID ? "music-viz" : "music-viz music-viz-idle"} aria-hidden>
      {Array.from({ length: BARS }, (_, i) => (
        <i key={i} style={{ animationDelay: `${(i % 7) * 90}ms` }} />
      ))}
    </div>
  );
}

type Props = {
  playing: MusicNow;
  nameOf: (identity: string) => string;
  /** Who listens: the call's others, by name. */
  listeners: string[];
  onStop: () => void;
  onChange?: () => void;
  /** The music's track, for the bars. */
  track?: MediaStreamTrack | null;
};

/** The «Музыка» tab of the stage: the cover big, its colours behind, bars in time, who listens, and every setting of it. */
export function MusicTab({ playing, nameOf, listeners, onStop, onChange, track = null }: Props) {
  const [tint, setTint] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setTint(null);
    if (playing.cover) void coverColor(playing.cover).then((color) => alive && setTint(color));
    return () => {
      alive = false;
    };
  }, [playing.cover]);
  return (
    <div className="music-tab" style={tint ? { ["--music-tint" as string]: tint } : undefined}>
      <div className="music-tab-body">
        <div className="music-tab-art">
          <MusicCover playing={playing} className="music-cover-big" />
          <b className="music-tab-title">{playing.title ?? "Музыка"}</b>
          {playing.artist && <span className="music-tab-artist">{playing.artist}</span>}
          <span className="music-tab-from">♪ {musicFrom(playing, nameOf)}</span>
          <Visualizer track={track} />
          <span className="music-tab-listeners">{listeners.length > 0 ? `Слушают: ${listeners.join(", ")}` : "Слушают все в звонке"}</span>
        </div>
        <div className="music-tab-settings">
          <MusicSettings playing={playing} onStop={onStop} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}
