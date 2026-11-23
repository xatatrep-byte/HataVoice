import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Camera,
  Circle,
  Clock,
  Columns2,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  History,
  Image,
  Lock,
  LockOpen,
  Maximize2,
  Monitor,
  Palette,
  PersonStanding,
  Plus,
  Radio,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { reorder, toFrame, type StudioSource, type TransitionKind } from "../../studio/layout";
import { studio, useStudio } from "../../studio/engine";
import { centered, dragHold, HANDLES, holdAt, nudge, type Handle, type Hold } from "../../studio/transform";
import { isLive, streaming, useStream } from "../../studio/stream";
import { Button } from "../../ui/Button";
import { Floating } from "../../ui/Floating";
import { IconButton } from "../../ui/IconButton";
import { Modal } from "../../ui/Modal";
import { Segmented } from "../../ui/Segmented";
import { Select } from "../../ui/Select";
import { Slider } from "../../ui/Slider";
import { MixerTab } from "./MixerTab";
import { OutputTab } from "./OutputTab";
import { SaveFolder } from "./SaveFolder";
import { SourceProperties } from "./SourceProperties";
import { StreamTab } from "./StreamPanel";
import "./studio.css";

const ICONS = { screen: Monitor, camera: Camera, character: PersonStanding, text: Type, image: Image, color: Palette, clock: Clock };

const KINDS: { kind: keyof typeof ICONS; name: string }[] = [
  { kind: "screen", name: "Экран или окно" },
  { kind: "camera", name: "Камера" },
  { kind: "character", name: "3D-персонаж" },
  { kind: "text", name: "Текст" },
  { kind: "image", name: "Картинка" },
  { kind: "clock", name: "Часы" },
  { kind: "color", name: "Цветной фон" },
];

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

function size(bytes: number): string {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} ГБ` : `${Math.round(bytes / (1 << 20))} МБ`;
}

const REPLAYS = [
  { value: "0", label: "Выключен" },
  { value: "30", label: "30 секунд" },
  { value: "60", label: "1 минута" },
  { value: "120", label: "2 минуты" },
  { value: "300", label: "5 минут" },
];

const TRANSITIONS: { value: TransitionKind; label: string }[] = [
  { value: "cut", label: "Сразу" },
  { value: "fade", label: "Наплыв" },
  { value: "slide", label: "Сдвиг" },
];

type SettingsTab = "output" | "stream" | "record" | "sound";

/** How close (screen pixels) a press must be to a handle to take it, and how near an edge sticks to a frame line. */
const HANDLE_REACH = 9;
const SNAP = 10;

const CURSORS: Record<Handle | "move", string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", move: "move" };

/**
 * «Запись и стрим», laid out as OBS is: the preview on top (the chosen source with eight handles, sticking to the frame's
 * edges and middle), and under it the docks — scenes, sources, the mixer, the transition, the controls — with what is
 * going on along the bottom. Output, stream, recording and sound settings are in one window.
 */
export function StudioPage({ onClose }: { onClose: () => void }) {
  const { scenes, activeScene, studioMode, editScene, sources, transition, output, recording, recorded, stats, replaySeconds, error } = useStudio();
  const streams = useStream((s) => s.states);
  const since = useStream((s) => s.since);
  const streamError = useStream((s) => s.error);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [properties, setProperties] = useState(false);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [, setTick] = useState(0);
  const preview = useRef<HTMLDivElement>(null);
  const hold = useRef<Hold | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const plus = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const programCanvas = useRef<HTMLCanvasElement>(null);
  const live = isLive(streams);

  // The canvas that is edited shows the air, or in studio mode the scene being prepared, with the air beside it.
  useEffect(() => {
    if (studioMode) {
      studio.attachEditPreview(canvas.current);
      void studio.attachPreview(programCanvas.current);
    } else {
      studio.attachEditPreview(null);
      void studio.attachPreview(canvas.current);
    }
    return () => {
      studio.attachEditPreview(null);
      void studio.attachPreview(null);
    };
  }, [studioMode]);

  // The clocks, while the page is open.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, []);

  const chosen = sources.find((s) => s.id === selected) ?? null;

  useEffect(() => {
    if (!adding) return;
    const away = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && (target.closest(".obs-menu") || plus.current?.contains(target))) return;
      setAdding(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setAdding(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [adding]);

  // Keys, as in OBS: 1–9 switch scenes, the arrows nudge the chosen source, Delete removes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof Element && (target.closest("input, textarea, select, [contenteditable='true']") || target.closest(".modal"))) return;
      if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
        const scene = scenes[Number(e.key) - 1];
        if (scene) studio.switchScene(scene.id);
        return;
      }
      if (!chosen) return;
      const moved = nudge(chosen.rect, e.key, e.shiftKey);
      if (moved && !chosen.locked) {
        e.preventDefault();
        studio.update(chosen.id, { rect: moved });
      } else if (e.key === "Delete") {
        studio.remove(chosen.id);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scenes, chosen]);

  const box = () => preview.current!.getBoundingClientRect();
  const frameOf = (e: PointerEvent) => {
    const b = box();
    return toFrame({ x: e.clientX - b.left, y: e.clientY - b.top }, b, output);
  };
  /** Frame pixels per screen pixel: handles and sticking are as big on screen whatever the frame. */
  const scale = () => output.width / Math.max(1, box().width);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    const taken = holdAt(sources, selected, frameOf(e), HANDLE_REACH * scale());
    setSelected(taken?.id ?? null);
    hold.current = taken?.hold ?? null;
    if (hold.current) e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!hold.current) {
      // What a press here would take, shown by the pointer: a resize arrow over a handle, a cross over a source.
      const under = holdAt(sources, selected, frameOf(e), HANDLE_REACH * scale());
      e.currentTarget.style.cursor = under?.hold ? CURSORS[under.hold.part] : "default";
      return;
    }
    studio.update(hold.current.id, { rect: dragHold(hold.current, frameOf(e), { frame: output, snap: SNAP * scale(), free: e.shiftKey }) });
  };
  const onUp = () => {
    hold.current = null;
  };

  const pct = (s: StudioSource) => ({
    left: `${(s.rect.x / output.width) * 100}%`,
    top: `${(s.rect.y / output.height) * 100}%`,
    width: `${(s.rect.width / output.width) * 100}%`,
    height: `${(s.rect.height / output.height) * 100}%`,
  });
  const onAir = scenes.find((s) => s.id === activeScene);
  const scene = scenes.find((s) => s.id === editScene);
  const frameStyle = { aspectRatio: `${output.width} / ${output.height}`, "--frame-ratio": output.width / output.height } as CSSProperties;
  const transitionName = TRANSITIONS.find((t) => t.value === transition.kind)?.label ?? "";

  // Nowhere to stream to yet: the stream settings, where the place and its key are chosen.
  const startStream = async () => {
    await streaming.start();
    const after = useStream.getState();
    if (after.error && !isLive(after.states)) setSettings("stream");
  };

  const add = (kind: keyof typeof ICONS) => {
    setAdding(false);
    if (kind === "image") return picker.current?.click();
    const adders = { screen: studio.addScreen, camera: studio.addCamera, character: studio.addCharacter, text: studio.addText, clock: studio.addClock, color: studio.addColor };
    void adders[kind]();
  };

  return (
    <div className="obs">
      <header className="obs-top">
        <h1>Запись и стрим</h1>
        {live && since && (
          <span className="obs-pill live" role="status">
            <Circle size={8} fill="currentColor" aria-hidden /> В ЭФИРЕ {duration(Date.now() - since)}
          </span>
        )}
        {recording && (
          <span className="obs-pill rec" role="status">
            <Circle size={8} fill="currentColor" aria-hidden /> ЗАПИСЬ {duration(Date.now() - recording.startedAt)} · {size(recording.bytes)}
          </span>
        )}
        <span className="obs-spacer" />
        {onAir && <span className="obs-scene-now">В эфире «{onAir.name}»</span>}
        <IconButton label="Настройки записи и стрима" onClick={() => setSettings("output")}>
          <Settings size={16} />
        </IconButton>
        <IconButton label="Закрыть" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      {(error || streamError) && (
        <p className="form-error obs-error" role="alert">
          {error ?? streamError}
        </p>
      )}

      <div className={studioMode ? "obs-stage two" : "obs-stage"}>
        <div className="obs-screen">
        {studioMode && (
          <div className="obs-screen-head">
            Предпросмотр <b>{scene?.name}</b>
          </div>
        )}
        <div className="obs-frame">
        <div className="obs-preview" ref={preview} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={() => chosen && setProperties(true)} style={frameStyle}>
          <canvas ref={canvas} className="studio-canvas" aria-label={studioMode ? "Предпросмотр" : "Кадр студии"} />
          {sources.length === 0 && <p className="studio-empty">В этой сцене пока пусто. Добавь источник кнопкой «+» в «Источниках».</p>}
          {chosen && chosen.visible && (
            <div className={chosen.locked ? "obs-selection locked" : "obs-selection"} style={pct(chosen)}>
              {!chosen.locked && HANDLES.map((h) => <span key={h} className={`obs-handle h-${h}`} />)}
            </div>
          )}
        </div>
        </div>
        </div>
        {studioMode && (
          <>
            <div className="obs-take">
              <Button variant="primary" disabled={editScene === activeScene} onClick={() => studio.goLive()}>
                Перевести <ArrowRight size={15} />
              </Button>
              <span className="hint">{transitionName}{transition.kind === "cut" ? "" : ` · ${transition.ms} мс`}</span>
            </div>
            <div className="obs-screen">
              <div className="obs-screen-head on-air">
                <Circle size={8} fill="currentColor" aria-hidden /> Программа <b>{onAir?.name}</b>
              </div>
              <div className="obs-frame">
                <div className="obs-preview program" style={frameStyle}>
                  <canvas ref={programCanvas} className="studio-canvas" aria-label="Программа: что в эфире" />
                </div>
              </div>
            </div>
          </>
        )}
        {properties && chosen && (
          <aside className="obs-properties" aria-label="Свойства источника">
            <div className="obs-dock-head">
              <span>Свойства: {chosen.kind === "text" ? chosen.text?.text || chosen.name : chosen.name}</span>
              <IconButton label="Закрыть свойства" onClick={() => setProperties(false)}>
                <X size={14} />
              </IconButton>
            </div>
            <div className="obs-properties-body">
              <SourceProperties source={chosen} />
            </div>
          </aside>
        )}
      </div>

      <div className="obs-docks">
        <section className="obs-dock" aria-label="Сцены">
          <div className="obs-dock-head">
            <span>Сцены</span>
            <span className="obs-dock-tools">
              <IconButton label="Новая сцена" onClick={() => studio.addScene()}>
                <Plus size={15} />
              </IconButton>
              <IconButton label="Копия этой сцены" onClick={() => studio.duplicateScene()}>
                <Copy size={14} />
              </IconButton>
              {scenes.length > 1 && scene && (
                <IconButton label="Удалить эту сцену" onClick={() => studio.removeScene(scene.id)}>
                  <Trash2 size={14} />
                </IconButton>
              )}
            </span>
          </div>
          <div className="obs-list" role="tablist" aria-label="Сцены">
            {scenes.map((s, i) =>
              renaming === s.id ? (
                <input
                  key={s.id}
                  className="input obs-rename"
                  autoFocus
                  value={s.name}
                  aria-label="Название сцены"
                  maxLength={32}
                  onChange={(e) => studio.renameScene(s.id, e.currentTarget.value)}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(e) => e.key === "Enter" && setRenaming(null)}
                />
              ) : (
                <button key={s.id} type="button" role="tab" aria-selected={s.id === editScene} className={s.id === editScene ? "obs-item on" : "obs-item"} title="Два щелчка — переименовать" onClick={() => studio.switchScene(s.id)} onDoubleClick={() => setRenaming(s.id)}>
                  <span className="obs-item-name">{s.name}</span>
                  {studioMode && s.id === activeScene && <span className="obs-air">в эфире</span>}
                  {i < 9 && <kbd className="obs-key">{i + 1}</kbd>}
                </button>
              ),
            )}
          </div>
        </section>

        <section className="obs-dock" aria-label="Источники">
          <div className="obs-dock-head">
            <span>Источники</span>
            <span className="obs-dock-tools">
              <span className="obs-add" ref={plus}>
                <IconButton label="Добавить источник" active={adding} onClick={() => setAdding((a) => !a)}>
                  <Plus size={15} />
                </IconButton>
                {adding && (
                  <Floating anchor={plus} className="menu-panel obs-menu" role="menu">
                    {KINDS.map(({ kind, name }) => {
                      const Icon = ICONS[kind];
                      return (
                        <button key={kind} type="button" role="menuitem" className="menu-item" onClick={() => add(kind)}>
                          <Icon size={16} aria-hidden /> {name}
                        </button>
                      );
                    })}
                  </Floating>
                )}
              </span>
              <IconButton label="Свойства и фильтры" disabled={!chosen} onClick={() => setProperties(true)}>
                <SlidersHorizontal size={14} />
              </IconButton>
              <IconButton label="Выше" disabled={!chosen} onClick={() => chosen && studio.setSources(reorder(sources, chosen.id, true))}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton label="Ниже" disabled={!chosen} onClick={() => chosen && studio.setSources(reorder(sources, chosen.id, false))}>
                <ArrowDown size={14} />
              </IconButton>
              <IconButton label="Убрать" disabled={!chosen} onClick={() => chosen && (studio.remove(chosen.id), setSelected(null))}>
                <Trash2 size={14} />
              </IconButton>
            </span>
          </div>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) void studio.addImage(file);
              e.currentTarget.value = "";
            }}
          />
          <ul className="obs-list" aria-label="Источники кадра">
            {[...sources].reverse().map((s) => {
              const Icon = ICONS[s.kind];
              return (
                <li key={s.id} className={s.id === selected ? "obs-item on" : "obs-item"}>
                  <button type="button" className="obs-item-name" onClick={() => setSelected(s.id)} onDoubleClick={() => (setSelected(s.id), setProperties(true))}>
                    <Icon size={14} aria-hidden /> {s.kind === "text" ? s.text?.text || s.name : s.name}
                  </button>
                  <IconButton label={s.visible ? "Скрыть" : "Показать"} onClick={() => studio.update(s.id, { visible: !s.visible })}>
                    {s.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </IconButton>
                  <IconButton label={s.locked ? "Разблокировать" : "Заблокировать на месте"} onClick={() => studio.update(s.id, { locked: !s.locked })}>
                    {s.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                  </IconButton>
                </li>
              );
            })}
            {sources.length === 0 && <li className="obs-empty">Нажми «+», чтобы добавить экран, камеру, персонажа, текст…</li>}
          </ul>
          {chosen && (
            <div className="obs-quick">
              <IconButton label="Во весь кадр" disabled={chosen.locked} onClick={() => studio.fill(chosen.id)}>
                <Maximize2 size={14} />
              </IconButton>
              <IconButton label="По центру" disabled={chosen.locked} onClick={() => studio.update(chosen.id, { rect: centered(chosen.rect, output) })}>
                <Crosshair size={14} />
              </IconButton>
              <span className="hint">Shift — растянуть без пропорций, стрелки — сдвиг</span>
            </div>
          )}
        </section>

        <MixerDock onSettings={() => setSettings("sound")} />

        <section className="obs-dock" aria-label="Переход">
          <div className="obs-dock-head">
            <span>Переход</span>
          </div>
          <div className="obs-dock-body">
            <Segmented<TransitionKind> label="Вид" value={transition.kind} options={TRANSITIONS} onChange={(kind) => studio.setTransition({ ...transition, kind })} />
            <Slider label="Длительность" min={100} max={2000} step={50} value={transition.ms} format={(v) => `${v} мс`} disabled={transition.kind === "cut"} onChange={(ms) => studio.setTransition({ ...transition, ms })} />
          </div>
        </section>

        <section className="obs-dock" aria-label="Управление">
          <div className="obs-dock-head">
            <span>Управление</span>
          </div>
          <div className="obs-controls">
            {live ? (
              <Button variant="danger" onClick={() => streaming.stop()}>
                <Radio size={15} /> Остановить стрим
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void startStream()}>
                <Radio size={15} /> Начать стрим
              </Button>
            )}
            {recording ? (
              <Button variant="danger" onClick={() => studio.stopRecording()}>
                <Square size={14} /> Остановить запись
              </Button>
            ) : (
              <Button onClick={() => void studio.startRecording()}>
                <Circle size={14} fill="currentColor" /> Начать запись
              </Button>
            )}
            <Button disabled={replaySeconds === 0} title={replaySeconds === 0 ? "Включи повтор в настройках записи" : undefined} onClick={() => studio.saveReplay()}>
              <History size={14} /> Сохранить повтор{replaySeconds > 0 ? ` (${replaySeconds} с)` : ""}
            </Button>
            <Button onClick={() => void studio.snapshot()}>
              <Camera size={14} /> Снимок
            </Button>
            <Button className={studioMode ? "obs-toggle on" : "obs-toggle"} aria-pressed={studioMode} title="Готовить следующую сцену, пока в эфире идёт другая" onClick={() => studio.setStudioMode(!studioMode)}>
              <Columns2 size={14} /> Студийный режим
            </Button>
          </div>
        </section>
      </div>

      <footer className="obs-status" aria-label="Состояние">
        <span className={stats.fps >= output.fps - 2 ? "obs-stat" : "obs-stat warn"} title="Кадров в секунду в студии">
          Кадры <b>{stats.fps}/{output.fps}</b>
        </span>
        <span className={stats.dropped > 0 ? "obs-stat warn" : "obs-stat"} title="Кадры, которые кодировщик не успел взять">
          Пропущено <b>{stats.dropped}</b>
        </span>
        <span className="obs-stat" title="Сколько рисуется один кадр">
          Кадр рисуется <b>{stats.renderMs} мс</b>
        </span>
        {stats.kbps > 0 && (
          <span className="obs-stat" title="Сколько сейчас выдаёт кодировщик">
            Поток <b>{stats.kbps} кбит/с</b>
          </span>
        )}
        <span className="obs-stat">
          Кадр <b>{output.width}×{output.height}</b>
        </span>
      </footer>

      <Modal open={settings !== null} onClose={() => setSettings(null)} title="Настройки записи и стрима">
        <div className="obs-settings">
          <div className="tabs" role="tablist" aria-label="Разделы настроек">
            {(
              [
                ["output", "Вывод"],
                ["stream", "Стрим"],
                ["record", "Запись"],
                ["sound", "Звук"],
              ] as [SettingsTab, string][]
            ).map(([id, name]) => (
              <button key={id} type="button" role="tab" aria-selected={settings === id} className="tab" onClick={() => setSettings(id)}>
                {name}
              </button>
            ))}
          </div>
          <div className="obs-settings-body">
            {settings === "output" && <OutputTab />}
            {settings === "stream" && <StreamTab />}
            {settings === "sound" && <MixerTab />}
            {settings === "record" && (
              <section className="studio-section">
                <p className="hint">Запись идёт в файл MP4, снимок — в PNG. Файл пишется кусками, поэтому при сбое ПК записанное не пропадёт.</p>
                <SaveFolder last={recorded} />
                <h3 className="settings-sub">Повтор</h3>
                <Select<string> label="Держать в памяти" value={String(replaySeconds)} options={REPLAYS} onChange={(v) => void studio.setReplay(Number(v))} />
                <p className="hint">Случилось что-то классное, а запись не шла? «Повтор» в управлении сохранит последние секунды отдельным файлом.</p>
              </section>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** The mixer dock: each source of sound with its level, a mute and a fader; the rest of the sound in the settings. */
function MixerDock({ onSettings }: { onSettings: () => void }) {
  const mixer = useStudio((s) => s.mixer);
  const [levels, setLevels] = useState({ mic: 0, screen: 0 });
  useEffect(() => {
    let frame = 0;
    let last = 0;
    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      if (time - last < 60) return;
      last = time;
      setLevels(studio.levels());
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);
  const channels: { id: "mic" | "screen"; name: string }[] = [
    { id: "screen", name: "Звук ПК" },
    { id: "mic", name: "Микрофон" },
  ];
  return (
    <section className="obs-dock" aria-label="Микшер">
      <div className="obs-dock-head">
        <span>Микшер</span>
        <span className="obs-dock-tools">
          <IconButton label="Настройки звука" onClick={onSettings}>
            <SlidersHorizontal size={14} />
          </IconButton>
        </span>
      </div>
      <div className="obs-dock-body">
        {channels.map(({ id, name }) => {
          const muted = mixer.muted[id];
          const level = muted ? 0 : levels[id];
          const db = level > 0 ? Math.max(-60, Math.round(20 * Math.log10(level))) : null;
          return (
            <div key={id} className="obs-channel">
              <div className="obs-channel-head">
                <span className="obs-channel-name">{name}</span>
                <span className="obs-db">{db === null ? "−∞" : `${db} дБ`}</span>
                <IconButton label={muted ? `Включить: ${name}` : `Выключить: ${name}`} tone={muted ? "off" : "default"} onClick={() => studio.setMixer({ muted: { ...mixer.muted, [id]: !muted } })}>
                  {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </IconButton>
              </div>
              <span className="obs-meter" role="meter" aria-label={`Уровень: ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
                <span style={{ clipPath: `inset(0 ${100 - Math.round(Math.min(1, level) * 100)}% 0 0)` }} />
              </span>
              <input
                className="obs-fader"
                type="range"
                min={0}
                max={200}
                step={5}
                value={Math.round(mixer.volumes[id] * 100)}
                aria-label={`Громкость: ${name}`}
                onChange={(e) => studio.setMixer({ volumes: { ...mixer.volumes, [id]: Number(e.currentTarget.value) / 100 } })}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
