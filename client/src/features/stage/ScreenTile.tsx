import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Gamepad2, Hourglass, Keyboard, Maximize, Minimize, Minimize2, MousePointerClick, Scaling, Volume2, VolumeX, X } from "lucide-react";
import type { ParticipantVolume } from "../../audio/volumes";
import { KEY_LAYOUT, type PadState } from "../../pads/state";
import { IS_ANDROID, IS_MOBILE } from "../../platform";
import { android } from "../../platform/android";
import { holdBack } from "../../ui/backStack";
import { TouchPad } from "../pads/TouchPad";
import { RemoteKeys } from "./RemoteKeys";
import type { RemoteInput } from "../../remote/api";
import { pictureBox } from "../../remote/capture";
import { ModifierLatch } from "../../remote/modifiers";
import { TouchpadControl } from "../../remote/touchpad";
import { useCapture } from "../../remote/useCapture";
import { IconButton } from "../../ui/IconButton";
import type { ScreenView } from "../../voice/screen";
import { screenStatsLine, useScreenStats } from "../../voice/screenStats";

/** Remote control of the PC whose screen this is, from our side. */
export type ScreenControl = {
  state: "idle" | "waiting" | "active";
  keyboard: boolean;
  onAsk: () => void;
  onRelease: () => void;
  send: (input: RemoteInput, lossy: boolean) => void;
  /** The screen is a phone's: text goes as letters, and Back, Home and Recents are buttons. */
  phone?: boolean;
};

/** Playing on the PC whose screen this is with a pad (or the keyboard as one), from our side. */
export type PadControl = {
  state: "idle" | "waiting" | "active";
  player: number | null;
  /** The pad we play with; null: the keyboard. */
  device: string | null;
  onAsk: () => void;
  onRelease: () => void;
  /** A key went down or up on the picture: whether the keyboard pad took it. */
  onKey: (code: string, down: boolean) => boolean;
  onKeysUp: () => void;
  /** The pad on a phone's screen as it is held (null: gone). */
  onTouch?: (state: PadState | null) => void;
};

type Props = {
  screen: ScreenView;
  /** Who shows it. */
  name: string;
  /** The volume of its sound on this PC. */
  volume: ParticipantVolume;
  expanded: boolean;
  onExpand: () => void;
  onVolumeChange: (change: Partial<ParticipantVolume>) => void;
  /** Stop watching it (its frames stop coming). */
  onClose: () => void;
  /** Someone else's screen: we may ask to control their PC. */
  control?: ScreenControl;
  /** Someone else's screen: we may ask to play on their PC with a pad. */
  pad?: PadControl;
};

const IGNORE = () => {};

/** A shared screen, big: the picture, who shows it, and what the viewer can do with it. */
export function ScreenTile({ screen, name, volume, expanded, onExpand, onVolumeChange, onClose, control, pad }: Props) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [typing, setTyping] = useState(false);
  // A phone's own «во весь экран» (see the effect below).
  const [whole, setWhole] = useState(false);
  const active = control?.state === "active";
  // A phone controls a PC as a touchpad (`TouchpadControl`), with Ctrl, Alt, Shift and Win from the keyboard's bar.
  const touchpad = active && IS_MOBILE;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [hint, setHint] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const videoRef = useRef(video);
  videoRef.current = video;
  const sendRef = useRef(control?.send ?? IGNORE);
  sendRef.current = control?.send ?? IGNORE;
  const drawRef = useRef(() => {});
  const zoomShown = useRef(1);
  const latch = useMemo(() => (touchpad ? new ModifierLatch((input, lossy) => sendRef.current(input, lossy), redraw) : null), [touchpad]);
  const trackpad = useMemo(() => {
    if (!touchpad) return null;
    const shown = () => {
      const v = videoRef.current;
      return (v && pictureBox({ left: 0, top: 0, width: v.offsetWidth, height: v.offsetHeight }, v.videoWidth, v.videoHeight)) ?? { width: 0, height: 0 };
    };
    return new TouchpadControl(shown, (input, lossy) => sendRef.current(input, lossy), () => drawRef.current(), () => latch?.after());
  }, [touchpad, latch]);
  useCapture(video, active, !!control?.keyboard, control?.send ?? IGNORE, trackpad, !!control?.phone);
  // A phone's own keys, for one who controls it.
  const phoneKey = (code: string) => {
    control?.send({ t: "key", code, down: true }, false);
    control?.send({ t: "key", code, down: false }, false);
  };

  // Our arrow where the friend's will be, and the picture zoomed about it: drawn straight on the elements, as often as the
  // finger moves, with no render of the whole tile.
  drawRef.current = () => {
    const v = videoRef.current;
    if (!v || !trackpad) return;
    const box = pictureBox({ left: v.offsetLeft, top: v.offsetTop, width: v.offsetWidth, height: v.offsetHeight }, v.videoWidth, v.videoHeight);
    if (!box) return;
    const x = box.left + (trackpad.cursor.x / 65535) * box.width;
    const y = box.top + (trackpad.cursor.y / 65535) * box.height;
    const arrow = arrowRef.current;
    if (arrow) {
      arrow.style.left = `${x}px`;
      arrow.style.top = `${y}px`;
    }
    v.style.transformOrigin = `${x - v.offsetLeft}px ${y - v.offsetTop}px`;
    v.style.transform = trackpad.zoom > 1 ? `scale(${trackpad.zoom})` : "";
    if (trackpad.zoom !== zoomShown.current) {
      zoomShown.current = trackpad.zoom;
      redraw();
    }
  };

  useEffect(() => {
    if (!trackpad) return;
    const v = video;
    const again = () => drawRef.current();
    again();
    window.addEventListener("resize", again);
    v?.addEventListener("resize", again);
    v?.addEventListener("loadedmetadata", again);
    return () => {
      window.removeEventListener("resize", again);
      v?.removeEventListener("resize", again);
      v?.removeEventListener("loadedmetadata", again);
      trackpad.cancel();
      latch?.releaseAll();
      if (v) {
        v.style.transform = "";
        v.style.transformOrigin = "";
      }
    };
  }, [trackpad, latch, video]);

  // Control from a phone opens on the whole screen, with a word on the gestures for a few seconds.
  useEffect(() => {
    if (!touchpad) return;
    if (IS_ANDROID) setWhole(true);
    setHint(true);
    const timer = setTimeout(() => setHint(false), 7000);
    return () => clearTimeout(timer);
  }, [touchpad]);
  const stats = useScreenStats(screen.track, active || pad?.state === "active");

  useEffect(() => {
    const track = screen.track;
    if (!video || !track) return;
    track.attach(video);
    return () => {
      track.detach(video);
    };
  }, [video, screen.track]);

  // WebView on Android has no full screen of its own (requestFullscreen does nothing there): the picture covers the whole
  // app, Android hides its bars and turns the screen the picture's way; back or the button brings it back.
  useEffect(() => {
    if (!whole) return;
    const bridge = android();
    const wide = !video || !video.videoHeight || video.videoWidth >= video.videoHeight;
    bridge?.send({ op: "fullscreen", on: true, landscape: wide });
    const release = holdBack(() => setWhole(false));
    return () => {
      release();
      bridge?.send({ op: "fullscreen", on: false });
    };
  }, [whole]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = screen.isLocal ? "Твой экран" : `Экран: ${name}`;
  const frozenNote = screen.frozen && !screen.isLocal;
  const playing = pad?.state === "active";
  // The keyboard as a pad takes its keys while the picture has the focus (on a PC; a phone gets a pad on its screen).
  const keyboardPad = playing && !pad.device && !IS_MOBILE;
  const screenPad = playing && !pad.device && IS_MOBILE;
  const padKey = (down: boolean) => (e: React.KeyboardEvent) => {
    if (pad?.onKey(e.code, down)) e.preventDefault();
  };
  const className = ["screen-tile", expanded && "expanded", whole && "whole", active && "controlled", playing && "playing", trackpad && typing && "typing"].filter(Boolean).join(" ");
  return (
    <figure
      className={className}
      aria-label={label}
      tabIndex={keyboardPad ? 0 : undefined}
      onKeyDown={keyboardPad ? padKey(true) : undefined}
      onKeyUp={keyboardPad ? padKey(false) : undefined}
      onBlur={keyboardPad ? pad.onKeysUp : undefined}
    >
      {screen.track ? (
        <video ref={setVideo} className="screen-video" autoPlay playsInline muted aria-label={active ? `Управление ПК: ${name}` : undefined} />
      ) : (
        <div className="screen-wait">Подключаю картинку…</div>
      )}
      {trackpad && control && (
        <>
          <svg ref={arrowRef} className="touchpad-cursor" viewBox="0 0 20 26" aria-hidden>
            <path d="M2 2 L2 21 L7 16.5 L10.5 24 L13.6 22.7 L10.2 15.3 L17 15.3 Z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          {hint && <p className="touchpad-hint">Веди пальцем в любом месте — стрелка едет за ним. Тап — клик, двумя пальцами — правый клик и прокрутка</p>}
          <div className="touchpad-bar" role="toolbar" aria-label="Мышь ПК друга">
            {control.keyboard && (
              <button type="button" className={typing ? "touchpad-button on" : "touchpad-button"} aria-pressed={typing} aria-label={typing ? "Спрятать клавиатуру" : "Клавиатура ПК друга"} onClick={() => setTyping((t) => !t)}>
                <Keyboard size={17} aria-hidden />
              </button>
            )}
            <button type="button" className="touchpad-button" onClick={() => trackpad.click("left")}>
              Левая
            </button>
            <button type="button" className="touchpad-button" onClick={() => trackpad.click("right")}>
              Правая
            </button>
            <button type="button" className={trackpad.wheel ? "touchpad-button on" : "touchpad-button"} aria-pressed={trackpad.wheel} title="Палец вверх-вниз крутит колесо" onClick={() => (trackpad.toggleWheel(), redraw())}>
              Колесо ⇕
            </button>
            <button type="button" className={trackpad.holding ? "touchpad-button on" : "touchpad-button"} aria-pressed={trackpad.holding} title="Левая кнопка зажата: перетаскивай пальцем, нажми ещё раз — отпустить" onClick={() => (trackpad.toggleHold(), redraw())}>
              Держать
            </button>
            <button type="button" className={trackpad.zoom > 1 ? "touchpad-button on" : "touchpad-button"} aria-label="Приблизить картинку" onClick={() => (trackpad.stepZoom(), drawRef.current(), redraw())}>
              {trackpad.zoom > 1 ? `🔍 ${Math.round(trackpad.zoom * 10) / 10}×` : "🔍"}
            </button>
          </div>
        </>
      )}
      {frozenNote && (
        <p className="screen-frozen" role="status">
          <b>Кадр застыл.</b> {name} играет на весь экран, а в этом режиме Windows не отдаёт картинку окна. Пусть переключит
          игру в «оконный без рамки» — в Minecraft это F11, а потом развернуть окно.
        </p>
      )}
      <figcaption className="screen-bar">
        <span className="screen-name">{label}</span>
        {active && <span className="screen-control-note">{control?.keyboard ? "Ты управляешь: мышь и клавиатура" : "Ты управляешь мышью"}</span>}
        {playing && (
          <span className="screen-control-note" title={keyboardPad ? KEY_LAYOUT : undefined}>
            Ты — игрок {pad.player} · {pad.device ?? (IS_MOBILE ? "геймпад на экране" : "клавиатура: нажми на картинку")}
          </span>
        )}
        {stats && (
          <span className={stats.tcp ? "screen-stats warn" : "screen-stats"} title={stats.tcp ? "Канал идёт через TCP: UDP закрыт, поэтому задержка и рывки больше обычного" : undefined}>
            {screenStatsLine(stats)}
          </span>
        )}
        {screen.hasAudio && !screen.isLocal && (
          <span className="screen-volume">
            <IconButton
              label={volume.muted ? "Включить звук демонстрации" : "Выключить звук демонстрации"}
              onClick={() => onVolumeChange({ muted: !volume.muted })}
            >
              {volume.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </IconButton>
            <input
              type="range"
              aria-label="Громкость демонстрации"
              min={0}
              max={200}
              value={Math.round(volume.volume * 100)}
              onChange={(e) => onVolumeChange({ volume: Number(e.currentTarget.value) / 100 })}
            />
          </span>
        )}
        <IconButton label={expanded ? "Свернуть" : "Развернуть"} onClick={onExpand}>
          {expanded ? <Minimize2 size={16} /> : <Scaling size={16} />}
        </IconButton>
        {control?.state === "idle" && (
          <IconButton label="Попросить управление" onClick={control.onAsk}>
            <MousePointerClick size={16} />
          </IconButton>
        )}
        {control?.state === "waiting" && (
          <IconButton label="Ждём ответа на просьбу об управлении. Нажми, чтобы попросить ещё раз" onClick={control.onAsk}>
            <Hourglass size={16} />
          </IconButton>
        )}
        {active && IS_MOBILE && control.keyboard && (
          <IconButton label={typing ? "Спрятать клавиатуру" : "Клавиатура ПК друга"} active={typing} onClick={() => setTyping((t) => !t)}>
            <Keyboard size={16} />
          </IconButton>
        )}
        {active && control.phone && (
          <span className="screen-phone-keys" role="group" aria-label="Кнопки телефона">
            <button type="button" className="screen-phone-key" onClick={() => phoneKey("AndroidBack")}>
              Назад
            </button>
            <button type="button" className="screen-phone-key" onClick={() => phoneKey("AndroidHome")}>
              Домой
            </button>
            <button type="button" className="screen-phone-key" onClick={() => phoneKey("AndroidRecents")}>
              Недавние
            </button>
          </span>
        )}
        {active && (
          <IconButton label="Отпустить управление" active onClick={control.onRelease}>
            <MousePointerClick size={16} />
          </IconButton>
        )}
        {pad?.state === "idle" && (
          <IconButton label="Играть геймпадом" onClick={pad.onAsk}>
            <Gamepad2 size={16} />
          </IconButton>
        )}
        {pad?.state === "waiting" && (
          <IconButton label="Ждём ответа на просьбу о геймпаде" disabled>
            <Hourglass size={16} />
          </IconButton>
        )}
        {playing && (
          <IconButton label="Отпустить геймпад" active onClick={pad.onRelease}>
            <Gamepad2 size={16} />
          </IconButton>
        )}
        <IconButton
          label={whole ? "Выйти из полного экрана" : "Во весь экран"}
          active={whole}
          onClick={() => (IS_ANDROID ? setWhole((on) => !on) : void video?.requestFullscreen?.().catch(() => {}))}
        >
          {whole ? <Minimize size={16} /> : <Maximize size={16} />}
        </IconButton>
        <IconButton label={screen.isLocal ? "Скрыть свой экран" : "Закрыть демонстрацию"} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </figcaption>
      {active && IS_MOBILE && control.keyboard && typing && <RemoteKeys send={control.send} latch={latch ?? undefined} phone={!!control.phone} />}
      {screenPad && pad.onTouch && <TouchPad onChange={pad.onTouch} />}
    </figure>
  );
}
