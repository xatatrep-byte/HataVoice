import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppWindow, Check, ChevronDown, Monitor, X } from "lucide-react";
import { screenQualityLabel, SCREEN_CODEC_LABELS, type ScreenSettings } from "../../voice/screen";
import type { OwnSource } from "../../voice/ownCapture";
import { ScreenFields } from "../settings/ScreenFields";
import { IconButton } from "../../ui/IconButton";
import { Toggle } from "../../ui/Toggle";
import { Button } from "../../ui/Button";

/** A window or a screen as Rust lists it (screen_sources.rs). */
export type PickerSource = OwnSource & { app: string | null; width: number; height: number; primary: boolean; thumb: string | null; icon: string | null };

/** The pictures go stale while the picker is open: they are taken again this often, ms. */
export const REFRESH_MS = 3000;

type Props = {
  open: boolean;
  settings: ScreenSettings;
  onChange: (change: Partial<ScreenSettings>) => void;
  onPick: (source: OwnSource) => void;
  onClose: () => void;
  /** Where the list comes from; Rust in the app. */
  load?: () => Promise<PickerSource[]>;
};

const loadSources = () => invoke<PickerSource[]>("capture_sources", { thumbs: true });

/** «Экран 1 · 2560 × 1440 · основной». */
export function sourceLine(s: PickerSource): string {
  return s.kind === "monitor" ? [s.title, `${s.width} × ${s.height}`, s.primary ? "основной" : null].filter(Boolean).join(" · ") : s.title;
}

/** Our own picker of what to show: the windows and the screens with their pictures, the quality and the sound below. */
export function ScreenPicker({ open, settings, onChange, onPick, onClose, load = loadSources }: Props) {
  const [sources, setSources] = useState<PickerSource[] | null>(null);
  const [tab, setTab] = useState<"window" | "monitor">("window");
  const [chosen, setChosen] = useState<string | null>(null);
  const [quality, setQuality] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!open) {
      setSources(null);
      setChosen(null);
      setQuality(false);
      return;
    }
    let alive = true;
    const refresh = () =>
      void loadRef.current()
        .then((list) => alive && setSources(list))
        .catch(() => alive && setSources((old) => old ?? []));
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const windows = sources?.filter((s) => s.kind === "window") ?? [];
  const monitors = sources?.filter((s) => s.kind === "monitor") ?? [];
  // No windows at all: the screens are what there is.
  const shownTab = tab === "window" && sources && windows.length === 0 && monitors.length > 0 ? "monitor" : tab;
  const list = shownTab === "window" ? windows : monitors;
  const key = (s: PickerSource) => `${s.kind}:${s.id}`;
  const picked = list.find((s) => key(s) === chosen) ?? (shownTab === "monitor" ? (list.find((s) => s.primary) ?? list[0]) : list[0]);
  const start = (s: PickerSource | undefined) => s && onPick({ kind: s.kind, id: s.id, title: s.title });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal picker" role="dialog" aria-modal="true" aria-label="Что показать друзьям">
        <div className="picker-head">
          <div>
            <h2>Что показать друзьям</h2>
            <p className="hint">{shownTab === "window" ? "Друзья увидят только выбранное окно — остальное останется у тебя." : "Друзья увидят весь экран."}</p>
          </div>
          <IconButton label="Закрыть" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="picker-bar">
          <div className="segmented picker-tabs" role="tablist" aria-label="Что показать">
            {(
              [
                ["window", "Окна", windows.length, <AppWindow key="w" size={15} aria-hidden />],
                ["monitor", "Экраны", monitors.length, <Monitor key="m" size={15} aria-hidden />],
              ] as const
            ).map(([id, label, count, icon]) => (
              <button key={id} type="button" role="tab" aria-selected={shownTab === id} className={shownTab === id ? "segment active" : "segment"} onClick={() => setTab(id)}>
                {icon} {label}
                {sources && <span className="picker-count">{count}</span>}
              </button>
            ))}
          </div>
          {shownTab === "window" && <span className="hint">Окна ХатаВойс и свёрнутые окна сюда не попадают</span>}
        </div>
        <div className="picker-grid" role="listbox" aria-label={shownTab === "window" ? "Окна" : "Экраны"}>
          {sources === null && <p className="hint picker-empty">Собираю окна…</p>}
          {sources && list.length === 0 && <p className="hint picker-empty">{shownTab === "window" ? "Открытых окон нет: разверни нужное или покажи экран." : "Экраны не нашлись."}</p>}
          {list.map((s) => {
            const on = picked && key(s) === key(picked);
            return (
              <button
                key={key(s)}
                type="button"
                role="option"
                aria-selected={!!on}
                className={on ? "picker-card on" : "picker-card"}
                data-source={key(s)}
                title={sourceLine(s)}
                onClick={() => setChosen(key(s))}
                onDoubleClick={() => start(s)}
              >
                <span className="picker-thumb">
                  {s.thumb ? <img src={s.thumb} alt="" draggable={false} /> : s.icon ? <img className="picker-thumb-icon" src={s.icon} alt="" draggable={false} /> : null}
                  {on && (
                    <span className="picker-check" aria-hidden>
                      <Check size={14} strokeWidth={3} />
                    </span>
                  )}
                </span>
                <span className="picker-name">
                  {s.kind === "monitor" ? <Monitor size={16} aria-hidden className="picker-icon" /> : s.icon ? <img className="picker-icon" src={s.icon} alt="" /> : <AppWindow size={16} aria-hidden className="picker-icon" />}
                  <span>{sourceLine(s)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="picker-foot">
          <div className="picker-quality">
            <button type="button" className="picker-chip" aria-expanded={quality} onClick={() => setQuality((q) => !q)}>
              {screenQualityLabel(settings)} к/с <small>{SCREEN_CODEC_LABELS[settings.codec]}</small> <ChevronDown size={14} aria-hidden />
            </button>
            {quality && (
              <div className="call-menu wide screen-menu picker-quality-menu" role="dialog" aria-label="Качество демонстрации">
                <ScreenFields screen={settings} onChange={onChange} audio={false} />
              </div>
            )}
          </div>
          <div className="picker-sound">
            <Toggle label={shownTab === "window" ? "Звук этого окна" : "Звук компьютера"} checked={settings.audio} onChange={(audio) => onChange({ audio })} />
          </div>
          <span className="picker-grow" />
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={!picked} onClick={() => start(picked)}>
            Показать
          </Button>
        </div>
      </div>
    </div>
  );
}
