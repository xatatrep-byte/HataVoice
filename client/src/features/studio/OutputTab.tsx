import { useEffect, useState } from "react";
import { studio, useStudio } from "../../studio/engine";
import {
  AUDIO_BITRATES,
  FRAME_RATES,
  MAX_KBPS,
  MIN_KBPS,
  QUALITIES,
  RESOLUTIONS,
  suggestedKbps,
  type EncoderChoice,
  type Latency,
  type Output,
  type Profile,
  type Quality,
  type RateControl,
  type VideoCodec,
  videoCodec,
} from "../../studio/layout";
import { isLive, useStream } from "../../studio/stream";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { Select } from "../../ui/Select";
import { Slider } from "../../ui/Slider";

const ENCODERS: { value: EncoderChoice; label: string }[] = [
  { value: "auto", label: "Авто" },
  { value: "hardware", label: "Видеокарта" },
  { value: "software", label: "Процессор" },
];

const RATES: { value: RateControl; label: string }[] = [
  { value: "cbr", label: "Постоянный (CBR)" },
  { value: "vbr", label: "Переменный (VBR)" },
];

const PROFILES: { value: Profile; label: string }[] = [
  { value: "high", label: "High" },
  { value: "main", label: "Main" },
  { value: "baseline", label: "Baseline" },
];

const CODECS: { value: VideoCodec; label: string }[] = [
  { value: "h264", label: "H.264" },
  { value: "av1", label: "AV1" },
];

/** Whether this PC's video card encodes AV1 at this size and rate; null while it is not known. */
function useAv1Card(output: Output): boolean | null {
  const [card, setCard] = useState<boolean | null>(null);
  useEffect(() => {
    setCard(null);
    if (output.codec !== "av1" || typeof VideoEncoder === "undefined") return;
    let current = true;
    void VideoEncoder.isConfigSupported({ codec: videoCodec(output), width: output.width, height: output.height, framerate: output.fps, hardwareAcceleration: "prefer-hardware" })
      .then((r) => current && setCard(!!r.supported))
      .catch(() => current && setCard(false));
    return () => {
      current = false;
    };
  }, [output]);
  return card;
}

const LATENCIES: { value: Latency; label: string }[] = [
  { value: "quality", label: "Качество" },
  { value: "realtime", label: "Скорость" },
];

/** «Вывод»: the frame, the encoder and the sound's bitrate, everything an encoder lets one choose. */
export function OutputTab() {
  const { output, recording } = useStudio();
  const live = isLive(useStream((s) => s.states));
  const locked = !!recording || live;
  const change = (part: Partial<Output>) => {
    if (!locked) studio.setOutput({ ...output, ...part });
  };
  const preset = RESOLUTIONS.find((r) => r.width === output.width && r.height === output.height)?.id ?? "custom";
  const av1Card = useAv1Card(output);
  const size = (value: string, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 320 && n <= 3840 ? n - (n % 2) : fallback;
  };
  return (
    <section className="studio-section" aria-label="Вывод">
      {locked && <p className="hint warn">Пока идёт запись или стрим, эти настройки не меняются.</p>}
      <h3 className="settings-sub">Кадр</h3>
      <Select<string>
        label="Размер"
        value={preset}
        options={[...RESOLUTIONS.map((r) => ({ value: r.id as string, label: r.name })), { value: "custom", label: "Свой размер" }]}
        onChange={(id) => {
          const r = RESOLUTIONS.find((x) => x.id === id);
          if (r) change({ width: r.width, height: r.height });
        }}
      />
      {preset === "custom" && (
        <div className="studio-size">
          <input className="input" type="number" aria-label="Ширина" min={320} max={3840} step={2} value={output.width} disabled={locked} onChange={(e) => change({ width: size(e.currentTarget.value, output.width) })} />
          <span>×</span>
          <input className="input" type="number" aria-label="Высота" min={320} max={3840} step={2} value={output.height} disabled={locked} onChange={(e) => change({ height: size(e.currentTarget.value, output.height) })} />
        </div>
      )}
      <Select<string> label="Кадров в секунду" value={String(output.fps)} options={FRAME_RATES.map((fps) => ({ value: String(fps), label: `${fps}` }))} onChange={(v) => change({ fps: Number(v) })} />

      <h3 className="settings-sub">Видео</h3>
      <Segmented<VideoCodec> label="Кодек" value={output.codec} options={CODECS} onChange={(codec) => change({ codec })} />
      {output.codec === "av1" && (
        <p className={av1Card === false ? "hint warn" : "hint"}>
          {av1Card === false
            ? "Видеокарта этого ПК не кодирует AV1: будет кодировать процессор, и кадры могут теряться. Нужна RTX 40 и новее, Radeon RX 7000 и новее или Intel Arc."
            : "AV1 даёт ту же картинку на 30–50% меньшим битрейтом. Его принимает YouTube и запись в файл; Twitch, VK и Kick пока ждут H.264."}
        </p>
      )}
      <Slider label="Битрейт" min={MIN_KBPS} max={MAX_KBPS} step={100} value={output.kbps} format={(v) => `${v} кбит/с`} disabled={locked} onChange={(kbps) => change({ kbps })} />
      <div className="field-row">
        <span className="hint">Подобрать под кадр:</span>
        {QUALITIES.map((q: { id: Quality; name: string }) => (
          <Button key={q.id} disabled={locked} onClick={() => change({ kbps: suggestedKbps(output.width, output.height, output.fps, q.id) })}>
            {q.name}
          </Button>
        ))}
      </div>
      <Segmented<EncoderChoice> label="Кодировщик" value={output.encoder} options={ENCODERS} onChange={(encoder) => change({ encoder })} />
      <Segmented<RateControl> label="Управление битрейтом" value={output.rate} options={RATES} onChange={(rate) => change({ rate })} />
      <p className="hint">Для стримов нужен постоянный, так требуют площадки. Переменный лучше для записи.</p>
      {output.codec === "h264" && <Segmented<Profile> label="Профиль H.264" value={output.profile} options={PROFILES} onChange={(profile) => change({ profile })} />}
      <Slider label="Ключевой кадр" min={1} max={10} value={output.keySeconds} format={(v) => `раз в ${v} с`} disabled={locked} onChange={(keySeconds) => change({ keySeconds })} />
      <Segmented<Latency> label="Режим кодировщика" value={output.latency} options={LATENCIES} onChange={(latency) => change({ latency })} />

      <h3 className="settings-sub">Звук, AAC</h3>
      <Select<string> label="Битрейт" value={String(output.audioKbps)} options={AUDIO_BITRATES.map((k) => ({ value: String(k), label: `${k} кбит/с` }))} onChange={(v) => change({ audioKbps: Number(v) })} />
    </section>
  );
}
