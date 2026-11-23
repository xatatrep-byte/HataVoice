import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { placeNear, type MenuPlace } from "./menuPlace";
import { BellOff, HeadphoneOff, Mic, MicOff } from "lucide-react";
import { MAX_VOLUME, type ParticipantVolume } from "../../audio/volumes";
import { usePrefs } from "../../state/prefs";
import { Avatar, avatarFill } from "../../ui/Avatar";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import type { ParticipantView, Quality } from "../../voice/participants";
import { serverBars, type NetJudgement } from "../../voice/netQuality";
import { NotEncrypted } from "./CallLock";
import { NetBars } from "./NetBars";
import { CameraVideo } from "./CameraVideo";
import { mirrored } from "../../voice/camera";
import { IS_ANDROID, IS_MOBILE } from "../../platform";

type Props = {
  participant: ParticipantView;
  volume: ParticipantVolume;
  /** In the room without a key of this call: not heard, and does not hear us. */
  outsideEncryption?: boolean;
  onVolumeChange: (name: string, change: Partial<ParticipantVolume>) => void;
  /** Opens the person menu (moderation); absent when there is nothing to offer. */
  onPerson?: () => void;
  /** A small one, in the strip over the 3D characters. */
  small?: boolean;
  /** The face of the person's 3D character, big on the tile. */
  picture?: string | null;
};

const QUALITY_LABEL: Record<Quality, string> = {
  excellent: "Связь отличная",
  good: "Связь хорошая",
  poor: "Связь плохая",
  lost: "Связь потеряна",
  unknown: "",
};

/** The call's measured judgement, or, before the first measurement, the server's word alone. */
function netOf(p: ParticipantView): NetJudgement | null {
  if (p.net && p.net.bars !== null) return p.net;
  const bars = serverBars(p.quality);
  return bars === null ? null : { bars, blame: "unknown", summary: QUALITY_LABEL[p.quality], details: [] };
}

function TileBody({
  participant: p,
  volume,
  outsideEncryption,
  small,
  picture,
}: {
  participant: ParticipantView;
  volume: ParticipantVolume;
  outsideEncryption: boolean;
  small: boolean;
  picture: string | null;
}) {
  const compact = usePrefs((s) => s.appearance.compact);
  const mirror = usePrefs((s) => mirrored(s.camera, IS_MOBILE));
  const camera = p.camera ? <CameraVideo track={p.camera} mirror={p.isLocal && mirror} /> : null;
  const name = (
    <span className="tile-name" title={p.name}>
      {p.name}
      {p.isLocal && <span className="tile-you"> (ты)</span>}
    </span>
  );
  const status = (
    <span className="tile-status">
      {p.deafened && <HeadphoneOff size={15} aria-label="Звук выключен" />}
      {!p.isLocal && volume.muted && <BellOff size={15} aria-label="Заглушён у тебя" />}
      <NetBars net={netOf(p)} label={p.isLocal ? "Твоя связь" : "Связь"} />
    </span>
  );
  const mic = p.muted ? <MicOff className="tile-mic off" size={14} aria-label="Микрофон выключен" /> : <Mic className="tile-mic" size={14} aria-hidden />;
  if (small && camera) {
    // A small card of the picture, the name over it.
    return (
      <>
        {camera}
        <span className="tile-tag">
          {mic}
          {name}
        </span>
        {status}
        {outsideEncryption && <NotEncrypted />}
      </>
    );
  }
  if (small) {
    return (
      <>
        <Avatar name={p.name} color={p.color} size={26} speaking={p.speaking} level={p.level} frame={p.frame} picture={picture} />
        {name}
        {p.muted && mic}
        {status}
        {outsideEncryption && <NotEncrypted />}
      </>
    );
  }
  return (
    <>
      <span className="tile-art" aria-hidden>
        {camera ? (
          camera
        ) : picture ? (
          <img className="tile-portrait" src={picture} alt="" draggable={false} />
        ) : (
          <Avatar name={p.name} color={p.color} size={compact ? 56 : 88} speaking={p.speaking} level={p.level} frame={p.frame} />
        )}
      </span>
      <span className="tile-tag">
        {mic}
        {name}
      </span>
      {status}
      {outsideEncryption && <NotEncrypted />}
      {p.speaking && <span className="tile-level" style={{ "--level": p.level } as CSSProperties} aria-hidden />}
    </>
  );
}

export function Tile({ participant, volume, outsideEncryption = false, onVolumeChange, onPerson, small = false, picture = null }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Where the open menu goes: by the tile, whole inside the window (under a tile at the bottom it went off the screen).
  const [place, setPlace] = useState<MenuPlace | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const fit = () => {
      const tile = button.current?.getBoundingClientRect();
      const box = menu.current;
      if (!tile || !box) return;
      setPlace(placeNear(tile, { width: box.offsetWidth, height: box.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    fit();
    // A click anywhere else closes it.
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("resize", fit);
    document.addEventListener("pointerdown", away);
    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("pointerdown", away);
    };
  }, [open]);
  const tint = { "--tint": avatarFill(participant.color) } as CSSProperties;
  const classes = ["tile-main", participant.speaking ? "speaking" : "", participant.camera ? "camera" : picture ? "pictured" : ""].filter(Boolean).join(" ");
  const outer = [small ? "tile small" : "tile", participant.camera ? "with-camera" : ""].filter(Boolean).join(" ");

  if (participant.isLocal) {
    return (
      <div className={outer} style={tint}>
        <div className={classes}>
          <TileBody participant={participant} volume={volume} outsideEncryption={outsideEncryption} small={small} picture={picture} />
        </div>
      </div>
    );
  }

  return (
    <div className={outer} style={tint}>
      <button
        ref={button}
        type="button"
        className={classes}
        aria-label={`${participant.name} — громкость`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <TileBody participant={participant} volume={volume} outsideEncryption={outsideEncryption} small={small} picture={picture} />
      </button>
      {open && (
        <div
          ref={menu}
          className="tile-menu"
          style={
            place
              ? { position: "fixed", left: place.left, top: place.top, bottom: "auto", maxHeight: place.maxHeight, overflowY: "auto", zIndex: 50 }
              : { position: "fixed", visibility: "hidden", left: 0, top: 0, bottom: "auto" }
          }
        >
          <Slider
            label="Громкость"
            min={0}
            max={(IS_ANDROID ? 1 : MAX_VOLUME) * 100}
            step={5}
            value={Math.round(volume.volume * 100)}
            format={(v) => `${v}%`}
            disabled={volume.muted}
            onChange={(v) => onVolumeChange(participant.identity, { volume: v / 100 })}
          />
          <Toggle
            label="Заглушить у себя"
            checked={volume.muted}
            onChange={(muted) => onVolumeChange(participant.identity, { muted })}
          />
          {onPerson && (
            <button type="button" className="btn btn-secondary tile-person" onClick={onPerson}>
              Действия…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
