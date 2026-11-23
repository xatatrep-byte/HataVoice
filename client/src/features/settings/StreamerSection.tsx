import { IS_MOBILE } from "../../platform";
import { usePrefs } from "../../state/prefs";
import { streamerActive, useStreaming, type StreamerMode } from "../../state/streamer";
import { Segmented } from "../../ui/Segmented";

/**
 * What a stream must not show, hidden by hand or by itself: on a PC while OBS runs, on a phone while its screen is shown
 * (there is no OBS there, and what is on the phone's screen is exactly what friends see) or the studio streams.
 */
export function StreamerSection() {
  const mode = usePrefs((s) => s.streamer);
  const setMode = usePrefs((s) => s.setStreamer);
  const live = useStreaming((s) => (IS_MOBILE ? s.sharing || s.studio : s.obs || s.studio));
  const active = streamerActive(mode, live);
  return (
    <>
      <Segmented<StreamerMode>
        label="Режим стримера"
        value={mode}
        options={[
          { value: "off", label: "Выключен" },
          { value: "on", label: "Включён" },
          { value: "auto", label: IS_MOBILE ? "Сам, когда показываю экран" : "Сам, когда запущен OBS" },
        ]}
        onChange={setMode}
      />
      <p className="hint">
        {active ? "Сейчас включён." : "Сейчас выключен."}{" "}
        {IS_MOBILE
          ? live
            ? "Ты показываешь экран телефона или стримишь."
            : "Включится сам, пока ты показываешь экран телефона в звонке или стримишь из «Записи и стрима»."
          : live
            ? "Программа для стрима запущена."
            : "Программ для стрима (OBS, Streamlabs, XSplit, Twitch Studio, PRISM) не видно."}
      </p>
      <ul className="notes">
        <li>Адреса серверов, IP и ссылки скрыты, но копируются как обычно.</li>
        <li>{IS_MOBILE ? "В уведомлениях телефона" : "В уведомлениях Windows"} вместо текста только «Новое сообщение».</li>
        <li>Вверху {IS_MOBILE ? "экрана" : "окна"} видна полоска: режим включён.</li>
      </ul>
    </>
  );
}
