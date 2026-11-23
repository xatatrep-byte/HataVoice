import { useEffect, useState } from "react";
import { MusicSettingsBlock } from "../music/MusicSettings";
import { hostView } from "../../voice/ownCapture";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { APP_NAME } from "../../config";
import { applyOutputDevice, getAudioContext } from "../../audio/audioContext";
import { bindingLabel } from "../../audio/keyLabels";
import { dbToMeter } from "../../audio/levels";
import { MAX_TAIL_MS, MAX_VAD_DB, MIN_VAD_DB, type AudioSettings, type NoiseSuppression } from "../../audio/settings";
import { playSound } from "../../audio/sounds";
import { useDevices } from "../../audio/useDevices";
import { useMicLoopback } from "../../audio/useMicLoopback";
import { useMicTest } from "../../audio/useMicTest";
import { phoneKeyLabel, pttAvailable, pttPhone } from "../../audio/usePtt";
import { PHONE_ROUTE_LABELS, PHONE_ROUTES, usePrefs, type PhoneRoute } from "../../state/prefs";
import { useAudioRoutes } from "../phone/useAndroid";
import { CHANGELOG } from "./changelog";
import type { NotifyMode } from "../../chat/notify";
import { useServers } from "../../state/servers";
import { Button } from "../../ui/Button";
import { LevelMeter } from "../../ui/LevelMeter";
import { Segmented } from "../../ui/Segmented";
import { Select } from "../../ui/Select";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import { HostCard } from "../host/HostCard";
import { ScreenFields } from "./ScreenFields";
import { CameraFields } from "./CameraFields";
import { canUseCamera, IS_ANDROID, IS_MOBILE } from "../../platform";
import { VoiceChanger } from "./VoiceChanger";
import type { PttControls, VoiceControls } from "./SettingsModal";

export { COLOR_NAMES, ProfileSection } from "./ProfileSection";

const NOISE_OPTIONS: { value: NoiseSuppression; label: string }[] = [
  { value: "rnnoise", label: "RNNoise, нейросеть" },
  { value: "browser", label: "Встроенный в WebView" },
  { value: "off", label: "Выключен" },
];

function deviceOptions(devices: MediaDeviceInfo[], unnamed: string) {
  const options = [{ value: "default", label: "По умолчанию" }];
  for (const d of devices) {
    if (d.deviceId && d.deviceId !== "default") options.push({ value: d.deviceId, label: d.label || unnamed });
  }
  return options;
}

/** The push-to-talk key with its assign button; the key lights up while it is held. */
export function PttKeyField({ ptt, binding }: { ptt: PttControls; binding: string[] }) {
  if (pttPhone) return <PhonePttField ptt={ptt} />;
  return (
    <div className="field">
      <span className="field-label">Клавиша</span>
      <div className="field-row">
        <div className={ptt.open ? "binding live" : "binding"}>
          {ptt.capturing ? "Нажми клавишу или кнопку мыши…" : bindingLabel(binding)}
        </div>
        {ptt.capturing ? (
          <Button onClick={ptt.cancelCapture}>Отмена</Button>
        ) : (
          <Button onClick={ptt.startCapture}>Назначить</Button>
        )}
      </div>
      <span className="hint">{ptt.open ? "● В эфире" : "Работает и в игре, клавиша остаётся за игрой"}</span>
    </div>
  );
}

/**
 * A phone's push-to-talk: the «Говорить» key on the call's screen always, and a key of the phone itself if one is set
 * (volume, a headset's button, a Bluetooth keyboard's key), while the app is in front.
 */
function PhonePttField({ ptt }: { ptt: PttControls }) {
  const key = usePrefs((s) => s.phonePttKey);
  const setKey = usePrefs((s) => s.setPhonePttKey);
  return (
    <div className="field">
      <span className="field-label">Клавиша телефона</span>
      <div className="field-row">
        <div className={ptt.open ? "binding live" : "binding"}>{ptt.capturing ? "Нажми клавишу на телефоне или гарнитуре…" : phoneKeyLabel(key)}</div>
        {ptt.capturing ? (
          <Button onClick={ptt.cancelCapture}>Отмена</Button>
        ) : (
          <>
            <Button onClick={ptt.startCapture}>Назначить</Button>
            {key && <Button onClick={() => setKey(null)}>Убрать</Button>}
          </>
        )}
      </div>
      <span className="hint">{ptt.open ? "● В эфире" : "Кнопка «Говорить» есть в звонке всегда. Клавиша телефона работает, пока ХатаВойс на экране"}</span>
    </div>
  );
}

/** Where a phone plays the call: the earpiece, the loudspeaker or a headset. */
function PhoneRouteField() {
  const route = usePrefs((s) => s.phoneRoute);
  const setRoute = usePrefs((s) => s.setPhoneRoute);
  const routes = useAudioRoutes();
  const available = new Set<PhoneRoute>(["auto", route, ...(routes?.available ?? ["earpiece", "speaker"])]);
  return (
    <Select<PhoneRoute>
      label="Звук звонка"
      value={route}
      options={PHONE_ROUTES.filter((r) => available.has(r)).map((value) => ({ value, label: PHONE_ROUTE_LABELS[value] }))}
      onChange={setRoute}
    />
  );
}

/** What only a phone has: the small window over other apps. */
export function PhoneCallBlock() {
  const pip = usePrefs((s) => s.phonePip);
  const setPip = usePrefs((s) => s.setPhonePip);
  return (
    <>
      <h3 className="settings-sub">Телефон</h3>
      <Toggle
        label="Звонок в маленьком окне"
        hint="Выйдешь из ХатаВойса во время звонка — звонок останется в окошке поверх других программ, с персонажами"
        checked={pip}
        onChange={setPip}
      />
    </>
  );
}

/** Plays your voice back the way a call would send it. Only in headphones, or speakers feed it back. */
export function ListenToYourself({ settings, disabled = false }: { settings: AudioSettings; disabled?: boolean }) {
  const [on, setOn] = useState(false);
  const active = on && !disabled;
  const { error } = useMicLoopback(active, settings);
  return (
    <div className="field">
      <div className="field-row">
        <Button onClick={() => setOn((v) => !v)} disabled={disabled}>
          {active ? "Остановить" : "Послушать себя"}
        </Button>
        <span className="hint">
          {disabled ? "Недоступно во время звонка" : "Только в наушниках: услышишь себя так, как тебя слышат в звонке (через колонки зазвенит)"}
        </span>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

/** Mic level outside of a call (opens the mic just for the test). */
export function MicTestMeter({ deviceId, marker }: { deviceId: string; marker?: number }) {
  const { level, error } = useMicTest(deviceId);
  return (
    <>
      <LevelMeter level={level} marker={marker} />
      {error && <p className="form-error">{error}</p>}
    </>
  );
}

export function VoiceSection({
  voice,
  ptt,
  settings,
  onSettingsChange,
}: {
  voice: VoiceControls;
  ptt: PttControls;
  settings: AudioSettings;
  onSettingsChange: (change: Partial<AudioSettings>) => void;
}) {
  const devices = useDevices();
  const inCall = voice.status === "connected";
  const inputs = deviceOptions(inCall && voice.inputs.length ? voice.inputs : devices.inputs, "Микрофон без названия");
  const outputs = deviceOptions(inCall && voice.outputs.length ? voice.outputs : devices.outputs, "Динамики без названия");
  const marker = settings.mode === "voice" ? dbToMeter(settings.vadThresholdDb) : undefined;
  const testSpeakers = async () => {
    const context = getAudioContext();
    // In a call LiveKit has already put the shared context on the chosen speakers.
    if (!inCall) await applyOutputDevice(context, settings.outputDeviceId).catch(() => {});
    playSound("join", context);
  };

  return (
    <>
      <Select
        label="Микрофон"
        value={settings.inputDeviceId}
        options={inputs}
        onChange={(inputDeviceId) => onSettingsChange({ inputDeviceId })}
      />
      <div className="field">
        <span className="field-label">Проверка микрофона{marker !== undefined && ": зелёный значит, что тебя слышно"}</span>
        {inCall ? <LevelMeter level={voice.micLevel} marker={marker} /> : <MicTestMeter deviceId={settings.inputDeviceId} marker={marker} />}
      </div>
      <ListenToYourself settings={settings} disabled={voice.status !== "idle"} />
      <div className="field-row">
        {IS_ANDROID ? (
          <PhoneRouteField />
        ) : (
          <Select
            label="Динамики"
            value={settings.outputDeviceId}
            options={outputs}
            onChange={(id) => {
              onSettingsChange({ outputDeviceId: id });
              voice.selectOutput(id);
            }}
          />
        )}
        <Button onClick={() => void testSpeakers()}>Проверить</Button>
      </div>

      <h3 className="settings-sub">Обработка</h3>
      <Select
        label="Шумодав"
        value={settings.noiseSuppression}
        options={NOISE_OPTIONS}
        onChange={(noiseSuppression) => onSettingsChange({ noiseSuppression })}
      />
      <Toggle
        label="Эхоподавление"
        hint="В наушниках лучше выключить: звук станет чище"
        checked={settings.echoCancellation}
        onChange={(echoCancellation) => onSettingsChange({ echoCancellation })}
      />

      <h3 className="settings-sub">Передача голоса</h3>
      <Segmented
        label="Режим"
        value={settings.mode}
        options={[
          { value: "voice", label: "Голосом" },
          {
            value: "ptt",
            label: "Push-to-talk",
            disabled: !pttAvailable,
            title: pttAvailable ? undefined : "Push-to-talk работает в Windows, на Mac и в Android",
          },
        ]}
        onChange={(mode) => onSettingsChange({ mode })}
      />
      {settings.mode === "voice" ? (
        <Slider
          label="Чувствительность"
          min={MIN_VAD_DB}
          max={MAX_VAD_DB}
          step={1}
          value={settings.vadThresholdDb}
          format={(v) => `${v} дБ`}
          onChange={(vadThresholdDb) => onSettingsChange({ vadThresholdDb })}
        />
      ) : (
        <>
          <PttKeyField ptt={ptt} binding={settings.pttBinding} />
          <Slider
            label="Задержка после отпускания"
            min={0}
            max={MAX_TAIL_MS}
            step={50}
            value={settings.pttTailMs}
            format={(v) => `${v} мс`}
            onChange={(pttTailMs) => onSettingsChange({ pttTailMs })}
          />
        </>
      )}
      {ptt.error && <p className="form-error">{ptt.error}</p>}

      <VoiceChanger settings={settings} onSettingsChange={onSettingsChange} />

      <h3 className="settings-sub">Звуки</h3>
      <Toggle
        label="Звуки событий"
        hint="Кто зашёл, кто вышел, микрофон и звук"
        checked={settings.sounds}
        onChange={(sounds) => onSettingsChange({ sounds })}
      />
      <Toggle
        label="Звук гифок модерации"
        hint="Видео в уведомлениях о кике играет со звуком"
        checked={settings.moderationGifSound}
        onChange={(moderationGifSound) => onSettingsChange({ moderationGifSound })}
      />

      <MusicSettingsBlock dj={hostView() !== null} />

      <ScreenSettingsBlock />
      {canUseCamera() && <CameraSettingsBlock cameras={devices.cameras} />}
      {IS_ANDROID && <PhoneCallBlock />}
    </>
  );
}

/** Our webcam in a call. A camera that is on takes a change at once. */
export function CameraSettingsBlock({ cameras }: { cameras: MediaDeviceInfo[] }) {
  const camera = usePrefs((s) => s.camera);
  const setCamera = usePrefs((s) => s.setCamera);
  return (
    <>
      <h3 className="settings-sub">Камера</h3>
      <CameraFields camera={camera} devices={cameras} onChange={setCamera} phone={IS_MOBILE} />
      <p className="hint">Включается кнопкой с камерой в звонке. Друзья видят тебя в твоей плитке, картинка зашифрована, как и голос.</p>
    </>
  );
}

/** How our screen goes out when we show it in a call. */
export function ScreenSettingsBlock() {
  const screen = usePrefs((s) => s.screen);
  const setScreen = usePrefs((s) => s.setScreen);
  const remoteBanner = usePrefs((s) => s.remoteBanner);
  const setRemoteBanner = usePrefs((s) => s.setRemoteBanner);
  return (
    <>
      <h3 className="settings-sub">Демонстрация экрана</h3>
      <ScreenFields screen={screen} onChange={setScreen} phone={IS_ANDROID} />
      {/* A phone is never controlled by a friend (Android lets no app do it): there is nothing to show a banner for. */}
      {!IS_MOBILE && (
        <Toggle
          label="Плашка поверх всех окон, когда тобой управляют"
          hint="Кто управляет твоим ПК или играет на нём геймпадом, и кнопка «Остановить». Без неё остановить можно в окне ХатаВойс или клавишами Ctrl+Alt+Backspace"
          checked={remoteBanner}
          onChange={setRemoteBanner}
        />
      )}
    </>
  );
}


/** Windows notifications about the chat. */
export function NotificationsSection() {
  const mode = usePrefs((s) => s.notifyMode);
  const showText = usePrefs((s) => s.notifyText);
  const setMode = usePrefs((s) => s.setNotifyMode);
  const setShowText = usePrefs((s) => s.setNotifyText);
  const online = usePrefs((s) => s.phoneOnline);
  const setOnline = usePrefs((s) => s.setPhoneOnline);
  return (
    <>
      <Segmented<NotifyMode>
        label={IS_MOBILE ? "Уведомления о чате" : "Уведомления Windows о чате"}
        value={mode}
        options={[
          { value: "mentions", label: "Упоминания" },
          { value: "all", label: "Все сообщения" },
          { value: "off", label: "Выключены" },
        ]}
        onChange={setMode}
      />
      <p className="hint">
        «Все сообщения» значит о каждом сообщении и упоминании. «Упоминания» значит только когда зовут тебя.
      </p>
      {mode !== "off" && (
        <Toggle
          checked={showText}
          onChange={setShowText}
          label="Показывать текст сообщения"
          hint={IS_MOBILE ? "Выключи, чтобы в уведомлениях телефона было только «Новое сообщение»" : "Выключи, чтобы в центре уведомлений Windows было только «Новое сообщение»"}
        />
      )}
      {IS_ANDROID && mode !== "off" && (
        <Toggle
          checked={online}
          onChange={setOnline}
          label="Получать сообщения, когда ХатаВойс свёрнут"
          hint="Android усыпляет свёрнутые программы, и сообщения перестают приходить. С этим ХатаВойс остаётся в сети: в шторке висит тихое уведомление, батарея тратится чуть больше"
        />
      )}
    </>
  );
}

export function ServerSection({ onDone, onCreateServer }: { onDone: () => void; onCreateServer?: () => void }) {
  const add = useServers((s) => s.add);
  const select = useServers((s) => s.select);
  const clipboardInvites = usePrefs((s) => s.clipboardInvites);
  const autoJoin = usePrefs((s) => s.autoJoin);
  return (
    <>
      <Toggle
        label="Замечать приглашения в буфере обмена"
        hint="Скопируй ссылку, переключись на ХатаВойс, и сервер предложится сам. Ничего другого из буфера программа не видит"
        checked={clipboardInvites}
        onChange={usePrefs.getState().setClipboardInvites}
      />
      <Toggle
        label="Заходить в последнюю комнату при запуске"
        hint="Открыл программу и уже с друзьями"
        checked={autoJoin}
        onChange={usePrefs.getState().setAutoJoin}
      />
      <HostCard
        onCreate={onCreateServer}
        onConnectLocal={(address, name) => {
          add({ address, name, color: "green" });
          select(address);
          onDone();
        }}
      />
    </>
  );
}

export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri()) void getVersion().then(setVersion).catch(() => {});
  }, []);
  return (
    <div className="about">
      <div className="about-name">{APP_NAME}</div>
      <p className="hint">{isTauri() ? `Версия ${version ?? "…"}` : "Веб-режим для разработки"}</p>
      <h3 className="about-heading">Что нового</h3>
      {CHANGELOG.slice(0, 5).map((release) => (
        <section key={release.version} className="about-release">
          <div className="about-release-head">
            <b>{release.version}</b> <span className="hint">{release.date}</span>
          </div>
          <ul>
            {release.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </section>
      ))}
      <h3 className="about-heading">Как приходят обновления</h3>
      <p className="about-fact">
        Установщик сам закрывает программу, ставит новую версию поверх старой и открывает её снова: настройки, ключи и переписка остаются. Сервер того, кто обновился,
        предлагает новую версию своим участникам кнопкой вверху окна. Программа проверяет подпись издателя и не поставит чужой файл, даже если он придёт с сервера друга.
      </p>
      <h3 className="about-heading">Откуда персонажи</h3>
      <p className="about-fact">
        Модели галереи выпущены их авторами под лицензией CC0: VRoid (pixiv) и 100Avatars (Polygonal Mind); «Герои» сделаны с нуля для ХатаВойс и тоже под CC0. Своя модель шифруется на твоём ПК, сервер хранит её как файл чата и не может прочитать. Значки голосов, действий и реакций — Fluent Emoji от Microsoft (лицензия MIT). Движения записаны на живых актёрах: Universal Animation Library от Quaternius (CC0) и Bandai Namco Research Motion Dataset (© Bandai Namco Research Inc., CC BY-NC 4.0 — только для некоммерческого использования).
      </p>
      <h3 className="about-heading">Что защищено</h3>
      <p className="about-fact">
        <b>Голос, экран, чат и файлы</b>
        Шифруются на твоём ПК. Ключей нет ни у сервера, ни у провайдера.
      </p>
      <p className="about-fact">
        <b>Вход, роли, кики и баны</b>
        Подписаны личными ключами. Подделать их не может никто, даже владелец сервера.
      </p>
      <p className="about-fact">
        <b>Ники и статус «Играет в»</b>
        Идут через зашифрованную группу, сервер их не видит.
      </p>
      <h3 className="about-heading">Что видит сервер</h3>
      <p className="about-fact">Кто зашёл и когда, кто и сколько пишет, кто и когда говорит, названия каналов. Содержимого он не видит.</p>
      <p className="about-fact">Взломанный сервер может не пустить в звонок или оборвать его, но не подслушает.</p>
      <h3 className="about-heading">Без белого IP</h3>
      <p className="about-fact">
        Приложения соединяются напрямую. Если сеть этого не даёт, поток идёт через общий ретранслятор n0: он видит, какие
        устройства соединились и сколько данных идёт, но не их содержимое. Адреса для первого соединения приложения находят
        через сервис n0. Выключается в настройках сервера.
      </p>
      <h3 className="about-heading">Что видит провайдер</h3>
      <p className="about-fact">Что на адрес сервера идёт звонок и сколько в нём данных.</p>
      <h3 className="about-heading">Вне защиты</h3>
      <p className="about-fact">Заражённый ПК участника и запись звонка самим участником.</p>
      <p className="about-fact">
        Личный ключ на этом устройстве запечатан средствами Windows. На Linux и Mac он запечатан ключом в файле, который может
        прочитать только твоя учётная запись, на телефоне лежит в закрытой папке приложения.
      </p>
      <p className="hint">Данные лежат в папке приложения: в Windows это %APPDATA%\\com.hatavoice.app.</p>
    </div>
  );
}
