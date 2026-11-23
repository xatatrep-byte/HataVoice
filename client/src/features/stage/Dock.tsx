import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AppWindow,
  ArrowLeft,
  ArrowUpRight,
  AudioLines,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  Headphones,
  HeadphoneOff,
  Lock,
  Megaphone,
  MessageSquare,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  Music,
  Move,
  PenLine,
  PhoneOff,
  Popcorn,
  Radio,
  Rotate3d,
  Smile,
  SwitchCamera,
  UserRoundPen,
  Video,
  VideoOff,
} from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { IconButton } from "../../ui/IconButton";
import type { ParticipantView } from "../../voice/participants";
import type { CallSecurity } from "../../voice/callSecurity";
import { MuteTimer, muteLabel, type ServerMute } from "../moderation/MuteTimer";
import { VOICE_PRESETS } from "../../audio/voiceFx";
import { BOARD, BOARD_PAUSE_MS } from "../../audio/soundboard";
import { VoicePresets } from "../settings/VoiceChanger";
import { useSince } from "../home/rooms";
import { EmoteMenu } from "./CharacterStage";
import { ScreenFields } from "../settings/ScreenFields";
import { Button } from "../../ui/Button";
import type { ScreenSettings } from "../../voice/screen";
import type { CameraSettings } from "../../voice/camera";
import { CameraFields } from "../settings/CameraFields";

export { callTime } from "../home/rooms";

/** Closes a menu on a click elsewhere or Escape. */
function useAway(open: boolean, close: () => void) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return box;
}

type MicProps = {
  micOn: boolean;
  transmitting: boolean;
  deafened: boolean;
  /** 0–1, draws a ring around the mic button while you're on air. */
  micLevel: number;
  /** A moderator muted us: the mic stays off and shows a lock and the time left. */
  serverMute?: ServerMute | null;
  /** Server clock minus ours, seconds. */
  clockOffset?: number;
  /** The mic waits while the call's keys are still on their way. */
  keysPending?: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
};

/** The two keys that work everywhere: the microphone and the sound. */
function MicKeys({ micOn, transmitting, deafened, micLevel, serverMute = null, clockOffset = 0, keysPending = false, onToggleMic, onToggleDeafen }: MicProps) {
  const micStyle = { "--level": transmitting ? micLevel : 0 } as CSSProperties;
  return (
    <span className="dock-group main">
      {serverMute ? (
        <span className="dock-mute">
          <IconButton label={muteLabel(serverMute)} tone="off" className="dock-btn" disabled>
            <Lock size={18} />
          </IconButton>
          <MuteTimer mute={serverMute} clockOffset={clockOffset} />
        </span>
      ) : (
        <IconButton
          label={keysPending ? "Ждём ключи шифрования" : micOn ? "Выключить микрофон" : "Включить микрофон"}
          tone={micOn ? "default" : "off"}
          className={transmitting ? "dock-btn mic live" : micOn ? "dock-btn mic on" : "dock-btn mic"}
          style={micStyle}
          disabled={keysPending}
          onClick={onToggleMic}
        >
          {micOn ? <Mic size={19} /> : <MicOff size={19} />}
        </IconButton>
      )}
      <IconButton label={deafened ? "Включить звук" : "Выключить звук"} active={deafened} tone={deafened ? "off" : "default"} className="dock-btn" onClick={onToggleDeafen}>
        {deafened ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
      </IconButton>
    </span>
  );
}

/** A row of the call's menu. */
function Row({ icon, children, end, onClick, role = "menuitem", checked, accent }: {
  icon: ReactNode;
  children: ReactNode;
  end?: ReactNode;
  onClick: () => void;
  role?: "menuitem" | "menuitemcheckbox";
  checked?: boolean;
  accent?: boolean;
}) {
  return (
    <button type="button" role={role} aria-checked={role === "menuitemcheckbox" ? checked : undefined} className={accent ? "call-menu-row accent" : "call-menu-row"} onClick={onClick}>
      {icon}
      <span className="call-menu-text">{children}</span>
      {role === "menuitemcheckbox" ? <span className="menu-switch" aria-hidden /> : end}
    </button>
  );
}

/** The head of a menu opened from the call's menu, with the way back. */
function SubHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="call-menu-head">
      <IconButton label="Назад" onClick={onBack}>
        <ArrowLeft size={16} />
      </IconButton>
      <span>{title}</span>
    </div>
  );
}

type Props = MicProps & {
  /** The lock of the call; the mic and the screen wait while its keys are still on their way. */
  security: CallSecurity;
  /** Our roles let us show the screen (`stream`). */
  canShare?: boolean;
  /** We show our screen now. */
  sharing?: boolean;
  onToggleScreen?: () => void;
  /** Music played together: ours goes now; the ♪ opens «Включить музыку для всех» or stops ours. */
  music?: { on: boolean; onToggle: () => void };
  /** What floats above the buttons (the music's mini-player). */
  above?: ReactNode;
  /**
   * The screen's quality, picked in a panel the screen button opens before Windows asks what to show; without it the
   * button starts at once.
   */
  screen?: { settings: ScreenSettings; onChange: (change: Partial<ScreenSettings>) => void; phone?: boolean };
  /** Our webcam: on or not, the switch, and which camera and how (a narrow key beside it opens them). */
  camera?: {
    on: boolean;
    /** The camera is opening (seconds on some webcams): the key says so. */
    starting?: boolean;
    settings: CameraSettings;
    devices: MediaDeviceInfo[];
    onToggle: () => void;
    onChange: (change: Partial<CameraSettings>) => void;
    /** A phone's camera: front or back, and a key to turn it round. */
    phone?: boolean;
  };
  /** Push-to-talk on a phone: a key on the screen held while speaking. */
  talk?: { open: boolean; press: () => void; release: () => void };
  /** The room's chat in the panel at the left: open or not, what is unread, and the switch. */
  chat?: { open: boolean; unread: number; mentions: number; onToggle: () => void };
  /** The voice changer's preset now, and a way to pick another in the call. */
  voicePreset?: string;
  onVoicePreset?: (id: string) => void;
  /** Opens «Совместный просмотр»: a link everyone in the call watches together. */
  onWatch?: () => void;
  /** Something is being watched together now. */
  watching?: boolean;
  /** Opens the call's drawing board (or shows the one open). */
  onBoard?: () => void;
  /** A board is open in the call now. */
  boarding?: boolean;
  /** Our 3D character does an emote for everyone. */
  onEmote?: (id: string) => void;
  /** A sound goes into the call with the voice. */
  onSound?: (id: string) => boolean;
  /** The call shows 3D characters, and a way to switch that. */
  stage3d?: boolean;
  onToggleStage3d?: () => void;
  /** The characters stand on the desktop too, and a way to switch that. */
  overlay?: boolean;
  onToggleOverlay?: () => void;
  /** They are being put in their places with the mouse, and a way to start and finish that. */
  arranging?: boolean;
  onArrange?: () => void;
  /** Settings → «Персонаж». */
  onEditCharacter?: () => void;
  /** «Запись и стрим». */
  onStudio?: () => void;
  /** The first call: one word over «⋯» on where everything else is, until «Понятно». */
  hint?: boolean;
  onHintDone?: () => void;
  onLeave: () => void;
};

type Menu = "main" | "voice" | "emote" | "board";

/** The call's panel: the few keys a call needs, floating at the bottom of the stage; the rest is behind «⋯». */
export function Dock(props: Props) {
  const {
    security,
    canShare = false,
    sharing = false,
    onToggleScreen,
    screen,
    camera,
    chat,
    onWatch,
    watching = false,
    onBoard,
    boarding = false,
    onEmote,
    onSound,
    stage3d = false,
    onToggleStage3d,
    overlay = false,
    onToggleOverlay,
    arranging = false,
    onArrange,
    voicePreset = "none",
    onVoicePreset,
    onEditCharacter,
    onStudio,
    hint = false,
    onHintDone,
    onLeave,
    micOn,
    talk,
  } = props;
  const keysPending = security.state === "pending";
  const [menu, setMenu] = useState<Menu | null>(null);
  const close = () => setMenu(null);
  const box = useAway(menu !== null, close);
  const [screenOpen, setScreenOpen] = useState(false);
  const closeScreen = () => setScreenOpen(false);
  const screenBox = useAway(screenOpen, closeScreen);
  const [cameraOpen, setCameraOpen] = useState(false);
  const closeCamera = () => setCameraOpen(false);
  const cameraBox = useAway(cameraOpen, closeCamera);
  const lastSound = useRef(0);
  const voice = voicePreset === "custom" ? { emoji: "🎛️", name: "Свой" } : (VOICE_PRESETS.find((p) => p.id === voicePreset) ?? VOICE_PRESETS[0]!);
  const fun = !!onVoicePreset || !!onEmote || !!onSound || !!onWatch || !!onBoard;
  const characters = !!onToggleStage3d || !!onToggleOverlay || !!onEditCharacter;
  const busy = watching || arranging || voicePreset !== "none";
  const chatCount = chat ? (chat.mentions > 0 ? `@${chat.mentions}` : chat.unread > 0 ? (chat.unread > 99 ? "99+" : String(chat.unread)) : null) : null;
  const run = (what: () => void) => () => {
    close();
    what();
  };

  return (
    <div className="dock" role="toolbar" aria-label="Управление звонком">
      {props.above}
      <MicKeys {...props} keysPending={keysPending} />
      {talk && (
        <button
          type="button"
          className={talk.open ? "dock-talk on" : "dock-talk"}
          aria-label="Говорить, пока держишь"
          aria-pressed={talk.open}
          disabled={!micOn || keysPending}
          onPointerDown={(e) => {
            talk.press();
            try {
              e.currentTarget.setPointerCapture?.(e.pointerId);
            } catch {
              // A pointer the browser no longer knows: the key is held all the same.
            }
          }}
          onPointerUp={talk.release}
          onPointerCancel={talk.release}
          onContextMenu={(e) => e.preventDefault()}
        >
          <Mic size={18} aria-hidden /> Говорить
        </button>
      )}
      {(canShare || camera || chat) && <span className="dock-sep" aria-hidden />}
      {camera && (
        <span className="dock-more dock-split" ref={cameraBox}>
          <IconButton
            label={keysPending ? "Камера: ждём ключи шифрования" : camera.starting ? "Включаю камеру…" : camera.on ? "Выключить камеру" : "Включить камеру"}
            active={camera.on}
            className={camera.starting ? "dock-btn starting" : "dock-btn"}
            disabled={keysPending || camera.starting}
            onClick={camera.onToggle}
          >
            {camera.on ? <Video size={19} /> : <VideoOff size={19} />}
          </IconButton>
          {camera.phone && camera.on && (
            <IconButton
              label={camera.settings.facing === "user" ? "Задняя камера" : "Передняя камера"}
              className="dock-btn"
              onClick={() => camera.onChange({ facing: camera.settings.facing === "user" ? "environment" : "user" })}
            >
              <SwitchCamera size={19} />
            </IconButton>
          )}
          <IconButton
            label="Какая камера и качество"
            active={cameraOpen}
            className="dock-btn dock-split-more"
            aria-haspopup="dialog"
            aria-expanded={cameraOpen}
            onClick={() => setCameraOpen((open) => !open)}
          >
            <ChevronUp size={14} />
          </IconButton>
          {cameraOpen && (
            <div className="call-menu wide screen-menu" role="dialog" aria-label="Камера">
              <b className="screen-menu-title">Камера</b>
              <CameraFields camera={camera.settings} devices={camera.devices} onChange={camera.onChange} phone={camera.phone} />
              {!camera.on && (
                <Button
                  variant="primary"
                  disabled={keysPending}
                  onClick={() => {
                    closeCamera();
                    camera.onToggle();
                  }}
                >
                  <Video size={16} /> Включить камеру
                </Button>
              )}
            </div>
          )}
        </span>
      )}
      {props.music && (
        <IconButton label={props.music.on ? "Остановить музыку" : "Музыка для всех"} active={props.music.on} className="dock-btn" onClick={props.music.onToggle}>
          <Music size={19} />
        </IconButton>
      )}
      {canShare && (
        <span className="dock-more" ref={screenBox}>
          <IconButton
            label={keysPending ? "Показать экран: ждём ключи шифрования" : sharing ? "Остановить демонстрацию" : "Показать экран"}
            active={sharing || screenOpen}
            className="dock-btn"
            disabled={keysPending}
            aria-haspopup={screen && !sharing ? "dialog" : undefined}
            aria-expanded={screen && !sharing ? screenOpen : undefined}
            onClick={() => {
              if (screen && !sharing) setScreenOpen((open) => !open);
              else onToggleScreen?.();
            }}
          >
            {sharing ? <MonitorOff size={19} /> : <MonitorUp size={19} />}
          </IconButton>
          {screenOpen && screen && !sharing && (
            <div className="call-menu wide screen-menu" role="dialog" aria-label="Демонстрация экрана">
              <b className="screen-menu-title">Демонстрация экрана</b>
              <ScreenFields screen={screen.settings} onChange={screen.onChange} phone={screen.phone} />
              <Button
                variant="primary"
                onClick={() => {
                  closeScreen();
                  onToggleScreen?.();
                }}
              >
                <MonitorUp size={16} /> {screen.phone ? "Показать экран телефона" : "Выбрать экран или окно"}
              </Button>
            </div>
          )}
        </span>
      )}
      {chat && (
        <IconButton label={chatCount ? `Чат комнаты, новых: ${chatCount}` : "Чат комнаты"} active={chat.open} className="dock-btn dock-chat" onClick={chat.onToggle}>
          <MessageSquare size={19} />
          {chatCount && <span className={chat.mentions > 0 ? "dock-count mention" : "dock-count"}>{chatCount}</span>}
        </IconButton>
      )}
      <span className="dock-more" ref={box}>
        <IconButton
          label="Ещё"
          active={menu !== null || busy}
          className="dock-btn"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={() => {
            onHintDone?.();
            setMenu((open) => (open ? null : "main"));
          }}
        >
          <Ellipsis size={19} />
        </IconButton>
        {hint && menu === null && (
          <div className="dock-hint" role="note">
            <b>Всё остальное здесь</b>
            <span>Смена голоса, эмоции, звуки, совместный просмотр и твой персонаж</span>
            <button type="button" className="dock-hint-ok" onClick={onHintDone}>
              Понятно
            </button>
          </div>
        )}
        {menu === "main" && (
          <div className="call-menu" role="menu" aria-label="Ещё">
            {onVoicePreset && (
              <Row icon={<AudioLines size={18} />} onClick={() => setMenu("voice")} end={<span className="call-menu-end">{voice.name} <ChevronRight size={15} /></span>}>
                Смена голоса
              </Row>
            )}
            {onEmote && (
              <Row icon={<Smile size={18} />} onClick={() => setMenu("emote")} end={<ChevronRight size={15} className="call-menu-end" />}>
                Эмоции персонажа
              </Row>
            )}
            {onSound && (
              <Row icon={<Megaphone size={18} />} onClick={() => setMenu("board")} end={<ChevronRight size={15} className="call-menu-end" />}>
                Звуковая панель
              </Row>
            )}
            {onWatch && (
              <Row icon={<Popcorn size={18} />} accent={watching} onClick={run(onWatch)} end={watching ? <span className="call-menu-end">идёт</span> : undefined}>
                Совместный просмотр
              </Row>
            )}
            {onBoard && (
              <Row icon={<PenLine size={18} />} accent={boarding} onClick={run(onBoard)} end={boarding ? <span className="call-menu-end">открыта</span> : undefined}>
                Доска для рисования
              </Row>
            )}
            {fun && characters && <div className="menu-sep" role="separator" />}
            {onToggleStage3d && (
              <Row icon={<Rotate3d size={18} />} role="menuitemcheckbox" checked={stage3d} onClick={onToggleStage3d}>
                3D-сцена
              </Row>
            )}
            {onToggleOverlay && (
              <Row icon={<AppWindow size={18} />} role="menuitemcheckbox" checked={overlay} onClick={onToggleOverlay}>
                Персонажи на рабочем столе
              </Row>
            )}
            {overlay && onArrange && (
              <Row icon={<Move size={18} />} accent={arranging} onClick={run(onArrange)}>
                {arranging ? "Готово, оставить так" : "Расставить на экране"}
              </Row>
            )}
            {onEditCharacter && (
              <Row icon={<UserRoundPen size={18} />} accent onClick={run(onEditCharacter)} end={<ArrowUpRight size={15} className="call-menu-end" />}>
                Изменить персонажа
              </Row>
            )}
            {onStudio && (
              <>
                <div className="menu-sep" role="separator" />
                <Row icon={<Radio size={18} />} onClick={run(onStudio)}>
                  Запись и стрим
                </Row>
              </>
            )}
          </div>
        )}
        {menu === "voice" && onVoicePreset && (
          <div className="call-menu wide" role="dialog" aria-label="Смена голоса">
            <SubHead title="Смена голоса" onBack={() => setMenu("main")} />
            <VoicePresets
              compact
              value={voicePreset}
              onPick={(id) => {
                onVoicePreset(id);
                close();
              }}
            />
          </div>
        )}
        {menu === "emote" && onEmote && (
          <div className="call-menu wide" role="dialog" aria-label="Эмоции персонажа">
            <SubHead title="Эмоции персонажа" onBack={() => setMenu("main")} />
            <EmoteMenu
              onAct={(id) => {
                onEmote(id);
                close();
              }}
            />
          </div>
        )}
        {menu === "board" && onSound && (
          <div className="call-menu" role="dialog" aria-label="Звуковая панель">
            <SubHead title="Звуковая панель" onBack={() => setMenu("main")} />
            <div className="board-grid">
              {BOARD.map((sound) => (
                <button
                  key={sound.id}
                  type="button"
                  className="board-pad"
                  disabled={!micOn}
                  onClick={() => {
                    const now = Date.now();
                    if (now - lastSound.current < BOARD_PAUSE_MS) return;
                    if (onSound(sound.id)) lastSound.current = now;
                  }}
                >
                  {sound.label}
                </button>
              ))}
            </div>
            <p className="hint board-hint">{micOn ? "Звук слышат все в комнате" : "Включи микрофон: звуки идут вместе с голосом"}</p>
          </div>
        )}
      </span>
      <span className="dock-sep" aria-hidden />
      <button type="button" className="dock-leave" aria-label="Выйти из комнаты" title="Выйти из комнаты" onClick={onLeave}>
        <PhoneOff size={19} aria-hidden />
      </button>
    </div>
  );
}

type MiniProps = MicProps & {
  name: string;
  people: ParticipantView[];
  /** When we joined (ms): the call's time goes on from it. */
  since: number | null;
  /** Our own character as set now, and the faces of the others. */
  pictureOf: (p: ParticipantView) => string | null;
  onOpen: () => void;
  onLeave: () => void;
};

/** The call while its stage is out of sight: which room and how long, the mic, the sound, and a way out. */
export function MiniCall({ name, people, since, pictureOf, onOpen, onLeave, ...keys }: MiniProps) {
  const time = useSince(since);
  return (
    <div className="mini-call" role="toolbar" aria-label="Звонок">
      <button type="button" className="mini-call-room" aria-label={`Комната «${name}»`} title="Вернуться в комнату" onClick={onOpen}>
        <span className="mini-call-faces" aria-hidden>
          {people.slice(0, 3).map((p) => (
            <Avatar key={p.identity} name={p.name} color={p.color} size={26} speaking={p.speaking} level={p.level} picture={pictureOf(p)} />
          ))}
        </span>
        <span className="mini-call-text">
          <span className="mini-call-name">{name}</span>
          <span className="mini-call-time">{time ?? ""}</span>
        </span>
      </button>
      <MicKeys {...keys} />
      <IconButton label="Выйти из комнаты" tone="danger" className="dock-btn leave" onClick={onLeave}>
        <PhoneOff size={18} />
      </IconButton>
    </div>
  );
}
