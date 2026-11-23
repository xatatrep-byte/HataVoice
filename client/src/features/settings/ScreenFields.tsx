import { useCodecAdvice } from "../../voice/codecAdvice";
import {
  SCREEN_CODEC_LABELS,
  SCREEN_CODECS,
  SCREEN_FPS,
  SCREEN_RESOLUTION_LABELS,
  SCREEN_RESOLUTIONS,
  type ScreenCodec,
  type ScreenFps,
  type ScreenResolution,
  type ScreenSettings,
} from "../../voice/screen";
import { Segmented } from "../../ui/Segmented";
import { Toggle } from "../../ui/Toggle";
import { CodecInfo } from "./CodecInfo";

type Props = {
  screen: ScreenSettings;
  onChange: (change: Partial<ScreenSettings>) => void;
  /** The computer's sound toggle too (our picker has its own, by what is shown). */
  audio?: boolean;
  /** A phone's screen: the sound is the phone's, and only of apps that allow it. */
  phone?: boolean;
};

/**
 * How our screen goes out: its size and its frames a second, each on its own, the codec and the computer's sound. The
 * same fields in the settings and in the panel the screen button opens in a call.
 */
export function ScreenFields({ screen, onChange, audio = true, phone = false }: Props) {
  // What suits this PC: each codec marked by what the video card can do, and one line about the card.
  const advice = useCodecAdvice(screen);
  // AV1 chosen where the card does not encode it: say how it will really go.
  const warning = advice && screen.codec === "av1" && advice.tone.av1 === "bad" ? advice.title.av1 : null;
  return (
    <>
      <Segmented<ScreenResolution>
        label="Разрешение"
        value={screen.resolution}
        options={SCREEN_RESOLUTIONS.map((value) => ({ value, label: SCREEN_RESOLUTION_LABELS[value] }))}
        onChange={(resolution) => onChange({ resolution })}
      />
      <Segmented<ScreenFps>
        label="Кадров в секунду"
        value={screen.fps}
        options={SCREEN_FPS.map((value) => ({ value, label: value }))}
        onChange={(fps) => onChange({ fps })}
      />
      <Segmented<ScreenCodec>
        label="Кодек"
        labelExtra={<CodecInfo best={advice?.best} />}
        value={screen.codec}
        options={SCREEN_CODECS.map((value) => ({ value, label: SCREEN_CODEC_LABELS[value], tone: advice?.tone[value], title: advice?.title[value] }))}
        onChange={(codec) => onChange({ codec })}
      />
      {advice && <p className={warning ? "hint warn" : "hint"}>{warning ?? advice.line}</p>}
      {audio && (
        <Toggle
          label={phone ? "Со звуком телефона" : "Со звуком компьютера"}
          hint={phone ? "Друзья слышат игру или видео. Android отдаёт звук с версии 10 и только тех программ, что это разрешают" : "Друзья слышат игру или фильм"}
          checked={screen.audio}
          onChange={(on) => onChange({ audio: on })}
        />
      )}
    </>
  );
}
