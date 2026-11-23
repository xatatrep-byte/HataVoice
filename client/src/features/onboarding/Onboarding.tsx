import { CAN_HOST, THIS_DEVICE } from "../../platform";
import { useState } from "react";
import { Server, Users } from "lucide-react";
import type { AudioSettings } from "../../audio/settings";
import { useDevices } from "../../audio/useDevices";
import { pttAvailable } from "../../audio/usePtt";
import { AVATAR_COLORS, MAX_NICKNAME_CHARS, usePrefs, type AvatarColor } from "../../state/prefs";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { Select } from "../../ui/Select";
import { Swatches } from "../../ui/Swatches";
import { Toggle } from "../../ui/Toggle";
import { COLOR_NAMES, ListenToYourself, MicTestMeter, PttKeyField } from "../settings/sections";
import type { PttControls } from "../settings/SettingsModal";
import "../settings/settings.css";

type Props = {
  onDone: () => void;
  settings: AudioSettings;
  onSettingsChange: (change: Partial<AudioSettings>) => void;
  onAddServer: (tab: "connect" | "create") => void;
  ptt: PttControls;
};

const STEPS = 3;

export function Onboarding({ onDone, settings, onSettingsChange, onAddServer, ptt }: Props) {
  const prefs = usePrefs();
  const [step, setStep] = useState(0);
  const [nickname, setNickname] = useState(prefs.nickname);
  const [nickError, setNickError] = useState<string | null>(null);
  const devices = useDevices();

  const finish = () => {
    prefs.finishOnboarding();
    onDone();
  };

  const dots = (
    <div className="onboarding-dots" aria-hidden>
      {Array.from({ length: STEPS }, (_, i) => (
        <span key={i} className={i <= step ? "done" : ""} />
      ))}
    </div>
  );

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        {dots}
        {step === 0 && (
          <>
            <h1>Как тебя зовут?</h1>
            <p className="onboarding-lead">Ник и цвет увидят друзья.</p>
            <div className="profile-preview">
              <Avatar name={nickname || "?"} color={prefs.color} size={56} />
              <div className="profile-name">{nickname || "Твой ник"}</div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="onboarding-nick">
                Ник
              </label>
              <input
                id="onboarding-nick"
                className="input"
                autoFocus
                value={nickname}
                maxLength={MAX_NICKNAME_CHARS}
                placeholder="Петя"
                onChange={(e) => {
                  setNickname(e.currentTarget.value);
                  setNickError(null);
                }}
              />
              {nickError && <span className="form-error">{nickError}</span>}
            </div>
            <Swatches
              label="Цвет"
              value={prefs.color as AvatarColor}
              options={AVATAR_COLORS}
              colorOf={(c) => `var(--av-${c})`}
              nameOf={(c) => COLOR_NAMES[c]}
              onChange={prefs.setColor}
            />
            <div className="onboarding-actions">
              <span />
              <Button
                variant="primary"
                onClick={() => {
                  if (!nickname.trim()) {
                    setNickError("Введи ник");
                    return;
                  }
                  prefs.setNickname(nickname.trim());
                  setStep(1);
                }}
              >
                Дальше
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>Проверим звук</h1>
            <p className="onboarding-lead">Скажи что-нибудь: полоска должна двигаться.</p>
            <Select
              label="Микрофон"
              value={settings.inputDeviceId}
              options={[
                { value: "default", label: "По умолчанию" },
                ...devices.inputs
                  .filter((d) => d.deviceId && d.deviceId !== "default")
                  .map((d) => ({ value: d.deviceId, label: d.label || "Микрофон без названия" })),
              ]}
              onChange={(inputDeviceId) => onSettingsChange({ inputDeviceId })}
            />
            <div className="field">
              <MicTestMeter deviceId={settings.inputDeviceId} />
            </div>
            <ListenToYourself settings={settings} />
            <Toggle
              label="Я в наушниках"
              hint="Без эхоподавления звук чище"
              checked={!settings.echoCancellation}
              onChange={(headphones) => onSettingsChange({ echoCancellation: !headphones })}
            />
            <Segmented
              label="Как передавать голос"
              value={settings.mode}
              options={[
                { value: "voice", label: "Голосом" },
                { value: "ptt", label: "По кнопке (PTT)", disabled: !pttAvailable },
              ]}
              onChange={(mode) => onSettingsChange({ mode })}
            />
            {settings.mode === "ptt" && <PttKeyField ptt={ptt} binding={settings.pttBinding} />}
            <div className="onboarding-actions">
              <Button variant="ghost" onClick={() => setStep(0)}>
                Назад
              </Button>
              <Button variant="primary" onClick={() => setStep(2)}>
                Дальше
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Куда подключимся?</h1>
            <p className="onboarding-lead">Зайди к другу по ссылке или создай свой сервер на {THIS_DEVICE}.</p>
            <div className="onboarding-choices">
              <Button
                variant="secondary"
                onClick={() => {
                  onAddServer("connect");
                  finish();
                }}
              >
                <Users size={20} /> Подключиться к другу
              </Button>
              {CAN_HOST && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onAddServer("create");
                    finish();
                  }}
                >
                  <Server size={20} /> Создать свой сервер
                </Button>
              )}
            </div>
            <div className="onboarding-actions">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Назад
              </Button>
              <Button variant="ghost" onClick={finish}>
                Позже
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
