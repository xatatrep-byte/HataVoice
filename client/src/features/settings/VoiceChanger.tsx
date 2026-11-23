import { Sliders } from "lucide-react";
import { VOICE_QUALITIES, type AudioSettings, type VoiceQuality } from "../../audio/settings";
import { presetFx, VOICE_PRESETS, type VoiceFx } from "../../audio/voiceFx";
import { Select } from "../../ui/Select";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import { Emoji } from "../../ui/Emoji";

type Props = {
  settings: AudioSettings;
  onSettingsChange: (change: Partial<AudioSettings>) => void;
};

/** The presets as a grid of cards: a click changes the voice at once, in a call too. */
export function VoicePresets({ value, onPick, compact = false }: { value: string; onPick: (id: string) => void; compact?: boolean }) {
  return (
    <div className={compact ? "voice-presets compact" : "voice-presets"} role="radiogroup" aria-label="Голос">
      {[...VOICE_PRESETS, { id: "custom", name: "Свой", emoji: "🎛️" }].map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          className={value === p.id ? "voice-preset active" : "voice-preset"}
          onClick={() => onPick(p.id)}
        >
          <Emoji kind="voice" id={p.id} fallback={p.emoji} size={30} className="voice-emoji" />
          <span>{p.name}</span>
        </button>
      ))}
    </div>
  );
}

/** «Смена голоса» and «Качество голоса» in the voice settings. */
export function VoiceChanger({ settings, onSettingsChange }: Props) {
  const custom = settings.voiceCustom;
  const setCustom = (change: Partial<VoiceFx>) => onSettingsChange({ voicePreset: "custom", voiceCustom: { ...custom, ...change } });
  const percent = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <>
      <h3 className="settings-sub">Смена голоса</h3>
      <p className="hint">Друзья слышат голос уже изменённым; шифрование то же. Проверь кнопкой «Послушать себя» выше.</p>
      <VoicePresets
        value={settings.voicePreset}
        onPick={(id) => onSettingsChange(id === "custom" ? { voicePreset: "custom", voiceCustom: presetFx(settings.voicePreset, custom) } : { voicePreset: id })}
      />
      {settings.voicePreset === "custom" && (
        <div className="voice-custom">
          <span className="field-label">
            <Sliders size={14} aria-hidden /> Свой голос
          </span>
          <Slider
            label="Высота"
            min={-12}
            max={12}
            step={1}
            value={custom.pitch}
            format={(v) => (v === 0 ? "как есть" : `${v > 0 ? "+" : ""}${v} пт.`)}
            onChange={(pitch) => setCustom({ pitch })}
          />
          <Slider label="Робот" min={0} max={100} step={5} value={Math.round(custom.robot * 100)} format={(v) => percent(v / 100)} onChange={(v) => setCustom({ robot: v / 100 })} />
          <Slider label="Дрожь" min={0} max={100} step={5} value={Math.round(custom.wobble * 100)} format={(v) => percent(v / 100)} onChange={(v) => setCustom({ wobble: v / 100 })} />
          <Slider label="Эхо" min={0} max={100} step={5} value={Math.round(custom.echo * 100)} format={(v) => percent(v / 100)} onChange={(v) => setCustom({ echo: v / 100 })} />
          <Slider label="Пещера" min={0} max={100} step={5} value={Math.round(custom.reverb * 100)} format={(v) => percent(v / 100)} onChange={(v) => setCustom({ reverb: v / 100 })} />
          <Toggle label="Рация" hint="Тонкий голос с хрипом, как по рации" checked={custom.radio} onChange={(radio) => setCustom({ radio })} />
        </div>
      )}

      <h3 className="settings-sub">Качество голоса</h3>
      <Select<VoiceQuality>
        label="Битрейт Opus"
        value={settings.voiceQuality}
        options={VOICE_QUALITIES.map((q) => ({ value: q.id, label: q.label }))}
        onChange={(voiceQuality) => onSettingsChange({ voiceQuality })}
      />
      <p className="hint">
        Чем выше, тем чище и объёмнее голос. 32–64 кбит/с — если у тебя или у друзей слабый интернет.
      </p>
    </>
  );
}
