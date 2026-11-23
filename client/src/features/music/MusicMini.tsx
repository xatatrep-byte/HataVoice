import { useState } from "react";
import { Music, Settings2, Volume1, Volume2, VolumeX, X } from "lucide-react";
import type { MusicNow } from "../../music/useMusic";
import { usePrefs } from "../../state/prefs";
import { IconButton } from "../../ui/IconButton";
import { MUSIC_SEND, MUSIC_VOLUME, MusicSettings } from "./MusicSettings";
import "./music.css";

/** A cover, or a painted square with the track's first letters when Windows gave none. */
export function MusicCover({ playing, className }: { playing: MusicNow; className: string }) {
  if (playing.cover) return <img className={`music-cover ${className}`} src={playing.cover} alt="" draggable={false} />;
  const letters =
    (playing.title ?? playing.app ?? "♪")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => [...word][0]!.toUpperCase())
      .join("") || "♪";
  return (
    <span className={`music-cover music-cover-painted ${className}`} aria-hidden>
      {letters}
    </span>
  );
}

/** Bars in time: a light animation (the tab has the real ones). */
export function MusicBars() {
  return (
    <span className="music-bars" aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/** Who plays it and from where, as a line. */
export function musicFrom(playing: MusicNow, nameOf: (identity: string) => string): string {
  const who = playing.mine ? "Ты включаешь музыку" : `Музыку включает ${nameOf(playing.identity)}`;
  return playing.app ? `${who} · ${playing.app}` : who;
}

type Props = {
  playing: MusicNow | null;
  nameOf: (identity: string) => string;
  /** Stops our own music for everyone; picks another program for it. */
  onStop: () => void;
  onChange?: () => void;
};

/** The volume right on the mini-player: a friend's music for us, ours for everyone. */
function MiniVolume({ mine }: { mine: boolean }) {
  const prefs = usePrefs();
  const value = mine ? prefs.musicSend : prefs.musicVolume;
  const max = mine ? 150 : 200;
  // A friend's music: the speaker leaves it (and comes back), as a player's does.
  const off = !mine && prefs.musicMuted;
  const Icon = off || value === 0 ? VolumeX : value < 0.5 ? Volume1 : Volume2;
  return (
    <label className={off ? "music-mini-volume off" : "music-mini-volume"} title={`${mine ? MUSIC_SEND : MUSIC_VOLUME}: ${Math.round(value * 100)}%`}>
      {mine ? (
        <Icon size={15} aria-hidden />
      ) : (
        <button type="button" className="music-mini-mute" aria-label={off ? "Слушать музыку" : "Не слушать эту музыку"} aria-pressed={off} onClick={() => prefs.setMusicMuted(!off)}>
          <Icon size={15} aria-hidden />
        </button>
      )}
      <input
        className="range"
        type="range"
        min={0}
        max={max}
        step={5}
        value={Math.round(value * 100)}
        aria-label={mine ? MUSIC_SEND : MUSIC_VOLUME}
        onChange={(e) => (mine ? prefs.setMusicSend : prefs.setMusicVolume)(Number(e.currentTarget.value) / 100)}
      />
    </label>
  );
}

/**
 * Music played together, above the call's buttons: what plays, its volume right there, and its settings a click away.
 * Hidden, it leaves a ♪ in its place to bring it back.
 */
export function MusicCorner({ playing, nameOf, onStop, onChange }: Props) {
  const shown = usePrefs((s) => s.musicMini);
  const [open, setOpen] = useState(false);
  if (!playing) return null;
  if (!shown) {
    return (
      <div className="music-corner">
        <IconButton label="Показать плеер музыки" className="music-badge" onClick={() => usePrefs.getState().setMusicMini(true)}>
          <Music size={16} />
        </IconButton>
      </div>
    );
  }
  const title = playing.title ?? "Музыка";
  const subtitle = playing.artist ?? playing.app ?? "";
  return (
    <div className="music-corner">
      {open && (
        <div className="music-pop" role="dialog" aria-label="Настройки музыки">
          <p className="music-pop-from">♪ {musicFrom(playing, nameOf)}</p>
          <MusicSettings
            playing={playing}
            volume={false}
            onStop={() => {
              setOpen(false);
              onStop();
            }}
            onChange={
              onChange &&
              (() => {
                setOpen(false);
                onChange();
              })
            }
          />
        </div>
      )}
      <div className="music-mini">
        <button type="button" className="music-mini-main" aria-expanded={open} aria-label={`${title}${subtitle ? `, ${subtitle}` : ""}`} onClick={() => setOpen((on) => !on)}>
          <MusicCover playing={playing} className="music-cover-small" />
          <span className="music-mini-text">
            <b>{title}</b>
            {subtitle && <small>{subtitle}</small>}
          </span>
          <MusicBars />
        </button>
        <MiniVolume mine={playing.mine} />
        <IconButton label="Настройки музыки" className="music-mini-hide" aria-expanded={open} onClick={() => setOpen((on) => !on)}>
          <Settings2 size={15} />
        </IconButton>
        <IconButton label="Скрыть плеер" className="music-mini-hide" onClick={() => usePrefs.getState().setMusicMini(false)}>
          <X size={14} />
        </IconButton>
      </div>
    </div>
  );
}
