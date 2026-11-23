import { useState } from "react";
import { Check, Copy, Palette } from "lucide-react";
import { usePrefs } from "../../state/prefs";
import { MAX_SCALE, MIN_SCALE, resolveCore, themeCore } from "../../theme/appearance";
import { galleryPicture } from "../../characters/gallery";
import { BUILTIN_THEMES, parseThemeCode, themeCode, tokensOf, type ThemeCore } from "../../theme/themes";
import { Button } from "../../ui/Button";
import { ColorPicker } from "../../ui/ColorPicker";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import { notify } from "../../ui/toasts";

const prefersDark = () => typeof window === "undefined" || window.matchMedia?.("(prefers-color-scheme: dark)").matches !== false;

const FACES = ["shino", "vita", "teddy"].map(galleryPicture);

/** A small picture of the program in a theme: the bar, the list of rooms with ours lit, a room card with faces and «Войти». */
function ThemeCard({ name, core, active, onPick }: { name: string; core: ThemeCore; active: boolean; onPick: () => void }) {
  const t = tokensOf(core);
  return (
    <button type="button" role="radio" aria-checked={active} className={active ? "theme-card active" : "theme-card"} onClick={onPick}>
      <span className="theme-mini" style={{ background: t.bg, borderColor: t.border, color: t.text }} aria-hidden>
        <span className="tm-top" style={{ background: t.panel, borderColor: t.border }}>
          <span className="tm-logo" style={{ background: t.accent }} />
          <span className="tm-title" style={{ background: t.text }} />
        </span>
        <span className="tm-body">
          <span className="tm-side" style={{ background: t.panel, borderColor: t.border }}>
            <span className="tm-item on" style={{ background: `color-mix(in oklab, ${t.accent} 20%, ${t.card})` }} />
            <span className="tm-item" style={{ background: t.muted }} />
            <span className="tm-item" style={{ background: t.muted }} />
          </span>
          <span className="tm-main">
            <span className="tm-card" style={{ background: t.card, borderColor: t.border }}>
              <span className="tm-faces">
                {FACES.map((src) => (
                  <img key={src} src={src} alt="" style={{ borderColor: t.card, background: t.panel }} />
                ))}
              </span>
              <span className="tm-btn" style={{ background: t.accent }} />
            </span>
            <span className="tm-line" style={{ background: t.text }} />
            <span className="tm-line short" style={{ background: t.text }} />
          </span>
        </span>
      </span>
      <span className="theme-name">
        {active && <Check size={14} aria-hidden />} {name}
        <span className="theme-base">{core.base === "light" ? "светлая" : "тёмная"}</span>
      </span>
    </button>
  );
}

const PARTS: { key: keyof Omit<ThemeCore, "base">; label: string }[] = [
  { key: "bg", label: "Фон" },
  { key: "panel", label: "Панели" },
  { key: "card", label: "Карточки" },
  { key: "text", label: "Текст" },
  { key: "accent", label: "Акцент" },
];

export function AppearanceSection() {
  const appearance = usePrefs((s) => s.appearance);
  const setAppearance = usePrefs((s) => s.setAppearance);
  const [editing, setEditing] = useState<keyof Omit<ThemeCore, "base"> | null>(null);
  const [accentOpen, setAccentOpen] = useState(false);
  const [code, setCode] = useState("");
  const dark = prefersDark();
  const current = resolveCore(appearance, dark);
  const custom = appearance.custom;

  function makeOwn() {
    setAppearance({ custom: current, theme: "custom", mixWith: null, accent: null });
  }

  function editOwn(change: Partial<ThemeCore>) {
    setAppearance({ custom: { ...(custom ?? current), ...change }, theme: "custom" });
  }

  function paste() {
    const core = parseThemeCode(code);
    if (!core) {
      notify.error("Это не код темы ХатаВойс");
      return;
    }
    setAppearance({ custom: core, theme: "custom", mixWith: null, accent: null });
    setCode("");
    notify.info("Тема друга включена и стала твоей");
  }

  const choices = [
    ...BUILTIN_THEMES.map((t) => ({ id: t.id, name: t.name, core: t as ThemeCore })),
    { id: "system", name: "Как в системе", core: themeCore("system", null, dark) },
    ...(custom ? [{ id: "custom", name: "Своя", core: custom }] : []),
  ];

  return (
    <>
      <div className="field">
        <span className="field-label">Тема</span>
        <div className="theme-gallery" role="radiogroup" aria-label="Тема">
          {choices.map((c) => (
            <ThemeCard key={c.id} name={c.name} core={c.core} active={appearance.theme === c.id} onPick={() => setAppearance({ theme: c.id })} />
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">Цвет акцента</span>
        <div className="row accent-row">
          <span className="cp-preview" style={{ background: current.accent }} aria-hidden />
          <Button onClick={() => setAccentOpen((open) => !open)}>
            <Palette size={16} /> {accentOpen ? "Готово" : "Свой цвет"}
          </Button>
          {appearance.accent && <Button onClick={() => setAppearance({ accent: null })}>Как в теме</Button>}
        </div>
        {accentOpen && <ColorPicker label="Цвет акцента" value={current.accent} onChange={(accent) => setAppearance({ accent })} />}
      </div>

      <div className="field">
        <label className="field-label" htmlFor="theme-mix">
          Смешать с темой
        </label>
        <select
          id="theme-mix"
          className="select"
          value={appearance.mixWith ?? ""}
          onChange={(e) => setAppearance({ mixWith: e.currentTarget.value || null })}
        >
          <option value="">Не смешивать</option>
          {choices
            .filter((c) => c.id !== appearance.theme)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </div>
      {appearance.mixWith && (
        <Slider
          label="Сколько второй темы"
          min={0}
          max={100}
          step={5}
          value={appearance.mixAmount}
          format={(v) => `${v}%`}
          onChange={(mixAmount) => setAppearance({ mixAmount })}
        />
      )}

      <h3 className="settings-sub">Своя тема</h3>
      {appearance.theme === "custom" && custom ? (
        <div className="own-theme">
          <div className="segmented" role="group" aria-label="Основа">
            {(["dark", "light"] as const).map((base) => (
              <button key={base} type="button" aria-pressed={custom.base === base} className={custom.base === base ? "segment active" : "segment"} onClick={() => editOwn({ base })}>
                {base === "dark" ? "Тёмная основа" : "Светлая основа"}
              </button>
            ))}
          </div>
          <div className="own-theme-parts">
            {PARTS.map((part) => (
              <button
                key={part.key}
                type="button"
                className={editing === part.key ? "own-part active" : "own-part"}
                aria-pressed={editing === part.key}
                onClick={() => setEditing((now) => (now === part.key ? null : part.key))}
              >
                <span className="cp-preview" style={{ background: custom[part.key] }} aria-hidden /> {part.label}
              </button>
            ))}
          </div>
          {editing && (
            <ColorPicker
              label={PARTS.find((p) => p.key === editing)!.label}
              value={custom[editing]}
              onChange={(hex) => editOwn({ [editing]: hex })}
            />
          )}
        </div>
      ) : (
        <>
          <p className="hint">Начни с текущей темы и поменяй пять цветов. Остальное подстроится.</p>
          <Button onClick={makeOwn}>
            <Palette size={16} /> Сделать свою из текущей
          </Button>
        </>
      )}

      <div className="field theme-code">
        <span className="field-label">Код темы</span>
        <div className="row">
          <Button
            onClick={() =>
              void navigator.clipboard
                .writeText(themeCode(current))
                .then(() => notify.info("Код темы скопирован"))
                .catch(() => notify.error("Не удалось скопировать"))
            }
          >
            <Copy size={16} /> Скопировать код этой темы
          </Button>
        </div>
        <div className="row">
          <input className="input" aria-label="Код темы от друга" placeholder="hvtheme1:…" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Button disabled={!code.trim()} onClick={paste}>
            Включить
          </Button>
        </div>
      </div>

      <Slider
        label="Масштаб"
        min={MIN_SCALE}
        max={MAX_SCALE}
        step={5}
        value={appearance.scale}
        format={(v) => `${v}%`}
        onChange={(scale) => setAppearance({ scale })}
      />
      <div className="field">
        <span className="field-label">Вкладки настроек</span>
        <div className="segmented" role="group" aria-label="Вкладки настроек">
          {(
            [
              ["top", "Сверху"],
              ["left", "Слева"],
            ] as const
          ).map(([where, label]) => (
            <button
              key={where}
              type="button"
              aria-pressed={appearance.settingsTabs === where}
              className={appearance.settingsTabs === where ? "segment active" : "segment"}
              onClick={() => setAppearance({ settingsTabs: where })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <Toggle
        label="Компактный режим"
        hint="Меньше отступов, больше влезает на экран"
        checked={appearance.compact}
        onChange={(compact) => setAppearance({ compact })}
      />
    </>
  );
}
