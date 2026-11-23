import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { ChannelFx } from "../../studio/audio";
import { studio, useStudio } from "../../studio/engine";
import { IconButton } from "../../ui/IconButton";
import { Select } from "../../ui/Select";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";

/** How loud something is, as a row of LEDs: green, then amber, then red near the top. */
function Meter({ level, label }: { level: number; label: string }) {
  return (
    <span className="studio-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      <span style={{ clipPath: `inset(0 ${100 - Math.round(level * 100)}% 0 0)` }} />
    </span>
  );
}

type Channel = "mic" | "screen";

function Strip({ channel, name, level, advanced }: { channel: Channel; name: string; level: number; advanced: boolean }) {
  const mixer = useStudio((s) => s.mixer);
  const fx = mixer.fx[channel];
  const muted = mixer.muted[channel];
  const setFx = (change: Partial<ChannelFx>) => studio.setMixer({ fx: { ...mixer.fx, [channel]: { ...fx, ...change } } });
  const setBand = (band: 0 | 1 | 2, value: number) => setFx({ eq: fx.eq.map((v, i) => (i === band ? value : v)) as ChannelFx["eq"] });
  const db = (v: number) => (v === 0 ? "0" : `${v > 0 ? "+" : ""}${v} дБ`);
  return (
    <section className="studio-section" aria-label={name}>
      <div className="studio-strip-head">
        <h2>{name}</h2>
        <IconButton label={muted ? "Включить" : "Выключить"} tone={muted ? "off" : "default"} onClick={() => studio.setMixer({ muted: { ...mixer.muted, [channel]: !muted } })}>
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </IconButton>
      </div>
      <Meter level={level} label={`Уровень: ${name}`} />
      <Slider label="Громкость" min={0} max={200} step={5} value={Math.round(mixer.volumes[channel] * 100)} format={(v) => `${v}%`} onChange={(v) => studio.setMixer({ volumes: { ...mixer.volumes, [channel]: v / 100 } })} />
      {advanced && (
        <>
          <Slider label="Низкие" min={-12} max={12} value={fx.eq[0]} format={db} onChange={(v) => setBand(0, v)} />
          <Slider label="Средние" min={-12} max={12} value={fx.eq[1]} format={db} onChange={(v) => setBand(1, v)} />
          <Slider label="Высокие" min={-12} max={12} value={fx.eq[2]} format={db} onChange={(v) => setBand(2, v)} />
          <Toggle label="Компрессор" hint="Выравнивает громкие и тихие места" checked={fx.compressor} onChange={(compressor) => setFx({ compressor })} />
          {channel === "mic" && (
            <Slider label="Шумовые ворота" min={-100} max={-20} step={2} value={fx.gate} format={(v) => (v <= -100 ? "выключены" : `${v} дБ`)} onChange={(gate) => setFx({ gate })} />
          )}
          <Slider label="Задержка" min={0} max={1000} step={10} value={fx.delayMs} format={(v) => `${v} мс`} onChange={(delayMs) => setFx({ delayMs })} />
          <Toggle label="Моно" checked={fx.mono} onChange={(mono) => setFx({ mono })} />
        </>
      )}
    </section>
  );
}

/** «Звук»: the mixer, a strip for each source of sound. */
export function MixerTab() {
  const { mixer, micDevice } = useStudio();
  const [levels, setLevels] = useState({ mic: 0, screen: 0 });
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [advanced, setAdvanced] = useState(false);

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

  useEffect(() => {
    void navigator.mediaDevices?.enumerateDevices().then((all) => setMics(all.filter((d) => d.kind === "audioinput")));
  }, []);

  return (
    <>
      <section className="studio-section">
        <Select<string>
          label="Микрофон"
          value={micDevice ?? "off"}
          options={[{ value: "", label: "Как в Windows" }, ...mics.filter((m) => m.deviceId && m.deviceId !== "default").map((m) => ({ value: m.deviceId, label: m.label || "Микрофон" })), { value: "off", label: "Без микрофона" }]}
          onChange={(v) => void studio.setMic(v === "off" ? null : v)}
        />
        <Toggle label="Шумоподавление микрофона" checked={mixer.noiseSuppression} onChange={(noiseSuppression) => studio.setMixer({ noiseSuppression })} />
        <Toggle label="Эхоподавление" hint="Нужно, если звук идёт в колонки, а не в наушники" checked={mixer.echoCancellation} onChange={(echoCancellation) => studio.setMixer({ echoCancellation })} />
        <Toggle label="Приглушать звук компьютера, пока говоришь" checked={mixer.ducking} onChange={(ducking) => studio.setMixer({ ducking })} />
        <Toggle label="Показать настройки каналов" checked={advanced} onChange={setAdvanced} />
      </section>
      <Strip channel="mic" name="Микрофон" level={levels.mic} advanced={advanced} />
      <Strip channel="screen" name="Звук экрана" level={levels.screen} advanced={advanced} />
      <p className="hint studio-note">Звук экрана включает всё, что играет на компьютере, в том числе голоса звонка. На выходе стоит ограничитель: звук не хрипит, даже если каналы слишком громкие.</p>
    </>
  );
}
