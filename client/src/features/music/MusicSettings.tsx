import type { MusicNow } from "../../music/useMusic";
import { usePrefs } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import "./music.css";

/** A friend's music, as loud as the listener wants it: one knob, whoever plays it. */
export const MUSIC_VOLUME = "Громкость музыки";
/** Our own music, as loud as everyone hears it. */
export const MUSIC_SEND = "Громкость для всех";

const percent = (v: number) => `${v}%`;

type Props = {
  playing: MusicNow;
  /** Stops our own music for everyone. */
  onStop: () => void;
  /** Opens «Включить музыку для всех» to pick another program. */
  onChange?: () => void;
  /** Leave the volume out: it is in sight already (the mini-player has it on itself). */
  volume?: boolean;
};

/**
 * Everything one can set about the music playing now. A friend's: its volume and «Тише, когда говорят». Ours: how loud
 * everyone hears it, another program, stop. Both: whether the mini-player is shown.
 */
export function MusicSettings({ playing, onStop, onChange, volume = true }: Props) {
  const prefs = usePrefs();
  return (
    <div className="music-settings">
      {!playing.mine && (
        <>
          <Toggle label="Не слушать" hint="Музыка друга не играет у тебя, остальные слушают дальше" checked={prefs.musicMuted} onChange={prefs.setMusicMuted} />
          {volume && <Slider label={MUSIC_VOLUME} min={0} max={200} step={5} value={Math.round(prefs.musicVolume * 100)} format={percent} onChange={(v) => prefs.setMusicVolume(v / 100)} />}
          <Toggle label="Тише, когда говорят" hint="Музыка приглушается, пока кто-то говорит" checked={prefs.musicDuck} onChange={prefs.setMusicDuck} />
        </>
      )}
      {playing.mine && (
        <>
          {volume && <Slider label={MUSIC_SEND} min={0} max={150} step={5} value={Math.round(prefs.musicSend * 100)} format={percent} onChange={(v) => prefs.setMusicSend(v / 100)} />}
          <p className="hint">Громкость в самом плеере тоже меняет то, что слышат друзья. Себе музыку ХатаВойс не повторяет: ты слышишь свой плеер.</p>
          <div className="music-settings-actions">
            {onChange && <Button onClick={onChange}>Сменить программу</Button>}
            <Button variant="danger" onClick={onStop}>
              Остановить для всех
            </Button>
          </div>
        </>
      )}
      <Toggle label="Мини-плеер над кнопками звонка" checked={prefs.musicMini} onChange={prefs.setMusicMini} />
    </div>
  );
}

/** «Музыка вместе» in the settings: the same knobs while nothing plays. `dj`: this device can play music for everyone (a PC on Windows). */
export function MusicSettingsBlock({ dj }: { dj: boolean }) {
  const prefs = usePrefs();
  return (
    <>
      <h3 className="settings-sub">Музыка вместе</h3>
      <Slider label="Громкость музыки друзей" min={0} max={200} step={5} value={Math.round(prefs.musicVolume * 100)} format={percent} onChange={(v) => prefs.setMusicVolume(v / 100)} />
      <Toggle label="Тише, когда говорят" hint="Музыка друзей приглушается, пока кто-то говорит" checked={prefs.musicDuck} onChange={prefs.setMusicDuck} />
      <Toggle label="Мини-плеер над кнопками звонка" hint="Скрытый плеер оставляет на своём месте значок ♪" checked={prefs.musicMini} onChange={prefs.setMusicMini} />
      {dj && (
        <Slider label="Громкость моей музыки для всех" min={0} max={150} step={5} value={Math.round(prefs.musicSend * 100)} format={percent} onChange={(v) => prefs.setMusicSend(v / 100)} />
      )}
    </>
  );
}
