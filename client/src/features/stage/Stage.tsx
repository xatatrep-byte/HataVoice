import type { ParticipantVolume, VolumeMap } from "../../audio/volumes";
import type { CallSecurity } from "../../voice/callSecurity";
import { useEffect, useState, type CSSProperties } from "react";
import { Box, Monitor, Music, PenLine, Popcorn, Users, Video } from "lucide-react";
import type { BoardControls } from "../../board/useBoard";
import { BoardView } from "../board/BoardView";
import type { MusicNow } from "../../music/useMusic";
import { MusicTab } from "../music/MusicTab";
import type { ActControls } from "../../characters/useActs";
import type { PadControls } from "../../pads/usePads";
import type { RemoteControls } from "../../remote/useRemote";
import { usePrefs } from "../../state/prefs";
import { portraitFor } from "../../characters/members";
import { CharacterStage } from "./CharacterStage";
import type { ParticipantView } from "../../voice/participants";
import { screenVolumeKey, type ScreenView } from "../../voice/screen";
import type { WatchControls } from "../../watch/useWatch";
import { ScreenTile, type PadControl, type ScreenControl } from "./ScreenTile";
import { ScreenPeek } from "./ScreenPeek";
import { WatchTile } from "./WatchTile";
import { outsideEncryption } from "./CallLock";
import { stageGrid } from "./layout";
import { Tile } from "./Tile";
import "./stage.css";

/** What the «Музыка» tab shows (see `MusicTab`). */
export type StageMusic = {
  playing: MusicNow;
  nameOf: (identity: string) => string;
  /** Stops our own music for everyone; picks another program for it. */
  onStop: () => void;
  onChange?: () => void;
  track?: MediaStreamTrack | null;
};

/** The call's drawing board (see `BoardView`): the «Доска» tab while one is open. */
export type StageBoard = {
  controls: BoardControls;
  people: { id: string; name: string }[];
  nameOf: (id: string) => string;
  /** Grows each time the board is asked for (the call's menu): it comes in front. */
  wanted: number;
};

type Props = {
  /** Music played together while it plays: the «Музыка» tab. */
  music?: StageMusic | null;
  board?: StageBoard | null;
  participants: ParticipantView[];
  volumes: VolumeMap;
  /** Who is marked «не в шифровании» depends on the call being secure. */
  security: CallSecurity;
  onVolumeChange: (name: string, change: Partial<ParticipantVolume>) => void;
  /** Opens the person menu for a participant (identity = user id). */
  onPerson?: (identity: string) => void;
  /** Shared screens in the call, ours too. */
  screens?: ScreenView[];
  onWatchScreen?: (identity: string, watching: boolean) => void;
  /** What the call watches together, if anything. */
  watch?: WatchControls;
  /** Starts showing our screen: for watching a site «Трансляцией», its window. */
  onShareScreen?: () => void;
  /** The characters' acts: with them the call is a 3D stage (when «3D-персонажи» is on). */
  acts?: ActControls;
  /** Remote control: asking to control someone's PC from their screen, and doing it. */
  remote?: RemoteControls;
  /** Playing together: asking to play on someone's PC with a pad, and doing it. */
  pads?: PadControls;
};

/** What we may do about controlling the PC whose screen `s` is. */
export function controlOf(s: ScreenView, remote: RemoteControls | undefined): ScreenControl | undefined {
  // A phone's screen too: its «Управление с ПК» accessibility service plays the touches (ControlService.kt).
  if (!remote || s.isLocal) return undefined;
  const session = remote.session;
  const ours = !!session && !session.host && session.peer === s.identity;
  if (session && !ours) return undefined;
  return {
    state: ours ? "active" : remote.waiting === s.identity ? "waiting" : "idle",
    keyboard: ours && session.keyboard,
    onAsk: () => remote.ask(s.identity),
    onRelease: remote.stop,
    send: remote.send,
    phone: !!s.phone,
  };
}

/** What we may do about playing with a pad on the PC whose screen `s` is: one host at a time. */
export function padOf(s: ScreenView, pads: PadControls | undefined): PadControl | undefined {
  if (!pads || s.isLocal || s.phone) return undefined;
  const here = pads.playing?.peer === s.identity;
  if (pads.playing && !here) return undefined;
  return {
    state: here ? "active" : pads.waiting === s.identity ? "waiting" : "idle",
    player: here ? pads.playing!.player : null,
    device: pads.device,
    onAsk: () => pads.ask(s.identity),
    onRelease: pads.release,
    onKey: pads.key,
    onKeysUp: pads.keysUp,
    onTouch: pads.touch,
  };
}

const DEFAULT_VOLUME: ParticipantVolume = { volume: 1, muted: false };

export function Stage({ participants, volumes, security, onVolumeChange, onPerson, screens = [], onWatchScreen, watch, onShareScreen, acts, remote, pads, music = null, board = null }: Props) {
  const grid = stageGrid(participants.length);
  const alone = participants.length === 1;
  const [picked, setPicked] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const nameOf = (identity: string) => participants.find((p) => p.identity === identity)?.name ?? "Без ника";
  const watched = screens.filter((s) => s.watching);
  const shown = watched.find((s) => s.identity === picked) ?? watched[0];
  const closed = screens.filter((s) => !s.watching);
  const together = !!watch?.state;
  // While watching together the 3D stage may come in front: the watching steps back (it goes on, hidden) until its tab.
  const [watchAway, setWatchAway] = useState(false);
  useEffect(() => {
    if (!together) setWatchAway(false);
  }, [together]);
  const watchFront = together && !watchAway;
  const stage3d = usePrefs((s) => s.stage3d);
  const mine = usePrefs((s) => s.character);
  const [no3d, setNo3d] = useState(false);
  const anyCamera = participants.some((p) => !!p.camera);
  const can3d = stage3d && !!acts && !no3d;
  // What is in front when no screen is: a camera is there to be seen, so the cameras come first while one is on; the 3D
  // stage stays loaded behind them, and «3D-сцена» puts it in front with the cameras small along its bottom.
  const [front, setFront] = useState<"scene" | "cameras" | null>(null);
  const camerasFirst = anyCamera && (front !== "scene" || !can3d);
  // The stage or the cameras over an open screen: the screen keeps coming (small, in a corner). One click each way.
  const [scene, setScene] = useState(false);
  const onScene = (can3d || anyCamera) && scene && !together && !!shown;
  // Nothing shown any more: the next screen someone shares comes up big again.
  useEffect(() => {
    if (watched.length === 0) setScene(false);
  }, [watched.length]);
  const big = (!!shown || watchFront) && !onScene;
  // The «Музыка» tab in front, while music plays; it goes with the music.
  const [musicFront, setMusicFront] = useState(false);
  useEffect(() => {
    if (!music) setMusicFront(false);
  }, [music]);
  // The «Доска» tab in front: when a board opens (for everyone in the call) and when it is asked for; it goes with it.
  const boardOpen = !!board?.controls.board.owner;
  const [boardFront, setBoardFront] = useState(false);
  useEffect(() => {
    setBoardFront(boardOpen);
  }, [boardOpen]);
  useEffect(() => {
    if (board?.wanted) setBoardFront(true);
  }, [board?.wanted]);
  const boardShown = boardOpen && boardFront;
  const musicShown = !!music && musicFront && !boardShown;
  const characters = can3d && !big && !camerasFirst;
  // The stage, the cameras and the open screens, side by side in one row of tabs.
  const switchTo3d = can3d && (together || watched.length > 0 || anyCamera);
  const switchToCameras = anyCamera && !together && (watched.length > 0 || can3d);
  // The picture of the PC we control takes the room it can.
  const driving = !!shown && !shown.isLocal && remote?.session?.peer === shown.identity && !remote.session.host;
  useEffect(() => {
    if (driving) setExpanded(true);
  }, [driving]);
  const tiles = participants.map((p) => (
    <Tile
      key={p.identity}
      participant={p}
      volume={volumes[p.identity] ?? DEFAULT_VOLUME}
      outsideEncryption={outsideEncryption(p, security)}
      onVolumeChange={onVolumeChange}
      onPerson={onPerson && !p.isLocal ? () => onPerson(p.identity) : undefined}
      small={characters || big}
      picture={portraitFor(p.isLocal ? mine : p.character, p.identity)}
    />
  ));
  return (
    <div className={big ? (expanded ? "stage with-screen expanded" : "stage with-screen") : characters ? "stage with-characters" : "stage"}>
      {/* The stage stays loaded behind an open screen (drawing nothing): back to it in an instant. */}
      {can3d && <CharacterStage participants={participants} mine={mine} acts={acts!} onFail={() => setNo3d(true)} parked={!characters} />}
      {together && watch && <WatchTile watch={watch} byName={nameOf(watch.state!.by)} onShareScreen={onShareScreen} parked={!watchFront} />}
      {(switchTo3d || switchToCameras || watched.length > 1 || !!music || boardOpen) && (
        <div className="screen-switch" role="tablist" aria-label="Что на сцене" onClickCapture={() => setBoardFront(false)}>
          {together && (
            <button
              type="button"
              role="tab"
              aria-selected={watchFront && !musicShown && !boardShown}
              className="screen-switch-tab"
              onClick={() => {
                setWatchAway(false);
                setMusicFront(false);
              }}
            >
              <Popcorn size={15} aria-hidden /> Просмотр
            </button>
          )}
          {(!!music || boardOpen) && !together && !switchTo3d && !switchToCameras && watched.length <= 1 && (
            // Only the music or the board besides what is on the stage: one tab back to it.
            <button type="button" role="tab" aria-selected={!musicShown && !boardShown} className="screen-switch-tab" onClick={() => setMusicFront(false)}>
              <Users size={15} aria-hidden /> Звонок
            </button>
          )}
          {switchTo3d && (
            <button
              type="button"
              role="tab"
              aria-selected={characters && !musicShown && !boardShown}
              className="screen-switch-tab"
              onClick={() => {
                setFront("scene");
                setScene(true);
                setMusicFront(false);
                setWatchAway(true);
              }}
            >
              <Box size={15} aria-hidden /> 3D-сцена
            </button>
          )}
          {switchToCameras && (
            <button
              type="button"
              role="tab"
              aria-selected={!big && camerasFirst && !musicShown && !boardShown}
              className="screen-switch-tab"
              onClick={() => {
                setFront("cameras");
                setScene(true);
                setMusicFront(false);
              }}
            >
              <Video size={15} aria-hidden /> Камеры
            </button>
          )}
          {watched.map((s) => (
            <button
              key={s.identity}
              type="button"
              role="tab"
              aria-selected={!onScene && s === shown && !musicShown && !boardShown}
              className="screen-switch-tab"
              onClick={() => {
                setPicked(s.identity);
                setScene(false);
                setMusicFront(false);
              }}
            >
              <Monitor size={15} aria-hidden /> {s.isLocal ? "Твой экран" : nameOf(s.identity)}
            </button>
          ))}
          {!!music && (
            <button type="button" role="tab" aria-selected={musicShown} className="screen-switch-tab" onClick={() => setMusicFront(true)}>
              <Music size={15} aria-hidden /> Музыка
            </button>
          )}
          {boardOpen && (
            <button type="button" role="tab" aria-selected={boardShown} className="screen-switch-tab" onClick={() => setTimeout(() => setBoardFront(true))}>
              <PenLine size={15} aria-hidden /> Доска
            </button>
          )}
        </div>
      )}
      {boardShown && board && <BoardView controls={board.controls} people={board.people} nameOf={board.nameOf} />}
      {musicShown && music && (
        <MusicTab
          playing={music.playing}
          nameOf={music.nameOf}
          listeners={participants.filter((p) => p.identity !== music.playing.identity).map((p) => (p.isLocal ? "ты" : p.name))}
          onStop={music.onStop}
          onChange={music.onChange}
          track={music.track ?? null}
        />
      )}
      {onScene && shown && <ScreenPeek screen={shown} name={shown.isLocal ? "Твой экран" : nameOf(shown.identity)} onOpen={() => setScene(false)} />}
      {shown && !onScene && (
        <ScreenTile
          screen={shown}
          name={nameOf(shown.identity)}
          volume={volumes[screenVolumeKey(shown.identity)] ?? DEFAULT_VOLUME}
          expanded={expanded}
          onExpand={() => setExpanded((on) => !on)}
          onVolumeChange={(change) => onVolumeChange(screenVolumeKey(shown.identity), change)}
          onClose={() => onWatchScreen?.(shown.identity, false)}
          control={controlOf(shown, remote)}
          pad={padOf(shown, pads)}
        />
      )}
      {closed.map((s) => (
        <p key={s.identity} className="screen-closed">
          {s.isLocal ? "Ты показываешь экран" : `${nameOf(s.identity)} показывает экран`}
          <button type="button" className="link-button" onClick={() => onWatchScreen?.(s.identity, true)}>
            {s.isLocal ? "Посмотреть" : "Смотреть"}
          </button>
        </p>
      ))}
      {characters || big ? (
        <div className={characters ? "stage-grid strip" : "stage-grid"}>{tiles}</div>
      ) : (
        // The tiles fit into the stage both ways: never taller than the window, never the whole window for one person.
        <div className="stage-fit">
          <div
            className="stage-grid"
            style={{ "--cols": grid.columns, "--rows": grid.rows, "--tile-max": `${grid.maxWidth}px` } as CSSProperties}
          >
            {tiles}
          </div>
          {alone && <p className="stage-hint">Пока ты здесь один. Позвать друга: «Весь сервер» → «Позвать друга».</p>}
        </div>
      )}
    </div>
  );
}
