import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { MousePointerClick } from "lucide-react";
import { remoteScreens, type RemoteSession, type ScreenChoice } from "../../remote/api";
import { usePhoneControl } from "../../remote/phoneControl";
import type { RemoteAsk } from "../../remote/useRemote";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { Select } from "../../ui/Select";
import "./remote.css";

/** The keys that end control at once, on the host's own keyboard. */
export const STOP_KEYS = "Ctrl+Alt+Backspace";

type AskProps = {
  ask: RemoteAsk | null;
  name: string;
  /** We show our screen now: what they would control. */
  sharing: boolean;
  onAnswer: (allow: boolean, keyboard: boolean, screen: number | null) => void;
};

/** Someone asks to control our PC: let them, with or without the keyboard, or not. Closing it is a no. */
export function RemoteAskDialog({ ask, name, sharing, onAnswer }: AskProps) {
  const phone = usePhoneControl();
  const [screens, setScreens] = useState<ScreenChoice[]>([]);
  const [screen, setScreen] = useState<number | null>(null);
  const user = ask?.user ?? null;

  useEffect(() => {
    if (!user || !isTauri()) return;
    void remoteScreens()
      .then((list) => {
        setScreens(list);
        setScreen(list.find((s) => s.primary)?.index ?? list[0]?.index ?? null);
      })
      .catch(() => {});
  }, [user]);

  if (phone) {
    // A phone: a friend's PC taps, swipes and types through the accessibility service, which the person turns on.
    return (
      <Modal open={!!ask} onClose={() => onAnswer(false, false, null)} title="Управление твоим телефоном">
        <p>
          <b>{name}</b> просит управлять твоим телефоном со своего ПК: нажимать, листать и печатать, пока ты не остановишь.
        </p>
        {!sharing && <p className="form-error">Сначала покажи экран телефона: друг управляет тем, что видит.</p>}
        {!phone.ready && (
          <div className="remote-phone-setup">
            <p>
              Android даёт нажимать за тебя только службе специальных возможностей. Открой настройки и включи там
              «ХатаВойс — управление с ПК», потом вернись сюда.
            </p>
            <Button onClick={phone.openSettings}>Открыть настройки Android</Button>
            <p className="hint">
              Переключатель серый или Android пишет «Ограниченная настройка»? Открой «О приложении», там ⋮ вверху справа →
              «Разрешить ограниченные настройки», и включи службу снова.
            </p>
            <Button variant="ghost" onClick={phone.openAppInfo}>
              О приложении
            </Button>
          </div>
        )}
        <p className="hint">Остановить можно в любой момент кнопкой в ХатаВойс. Всё, что идёт от друга, зашифровано ключом только для вас двоих.</p>
        <div className="row remote-actions">
          <Button variant="primary" onClick={() => onAnswer(true, true, null)}>
            Разрешить нажатия и текст
          </Button>
          <Button onClick={() => onAnswer(true, false, null)}>Только нажатия</Button>
          <Button variant="ghost" onClick={() => onAnswer(false, false, null)}>
            Отказать
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={!!ask} onClose={() => onAnswer(false, false, null)} title="Управление твоим ПК">
      <p>
        <b>{name}</b> просит управлять твоим ПК: двигать мышь и нажимать клавиши, пока ты не остановишь.
      </p>
      {!sharing && <p className="form-error">Сначала покажи весь экран: друг управляет тем, что видит.</p>}
      {screens.length > 1 && (
        <Select<string>
          label="Какой экран ты показываешь"
          value={String(screen ?? "")}
          options={screens.map((s) => ({ value: String(s.index), label: `${s.name} · ${s.width}×${s.height}${s.primary ? " · основной" : ""}` }))}
          onChange={(v) => setScreen(Number(v))}
        />
      )}
      <p className="hint">
        Остановить можно в любой момент кнопкой или клавишами {STOP_KEYS}. Окна, открытые от имени администратора, друг не
        тронет. Всё, что идёт от друга, зашифровано ключом только для вас двоих.
      </p>
      <div className="row remote-actions">
        <Button variant="primary" onClick={() => onAnswer(true, true, screen)}>
          Разрешить мышь и клавиатуру
        </Button>
        <Button onClick={() => onAnswer(true, false, screen)}>Только мышь</Button>
        <Button variant="ghost" onClick={() => onAnswer(false, false, null)}>
          Отказать
        </Button>
      </div>
    </Modal>
  );
}

/** While someone controls our PC: who, how, and a way to stop it at once. */
export function RemoteBanner({ session, name, onStop }: { session: RemoteSession; name: string; onStop: () => void }) {
  const phone = usePhoneControl();
  return (
    <div className="remote-banner" role="alert">
      <MousePointerClick size={16} aria-hidden />
      <span>
        {phone ? (
          <>
            <b>{name}</b> управляет твоим телефоном · {session.keyboard ? "нажатия и текст" : "только нажатия"}
          </>
        ) : (
          <>
            <b>{name}</b> управляет твоим ПК · {session.keyboard ? "мышь и клавиатура" : "только мышь"}
          </>
        )}
      </span>
      {phone && !phone.ready && <Button onClick={phone.openSettings}>Включить управление в Android</Button>}
      <Button variant="danger" onClick={onStop}>
        Остановить
      </Button>
      {!phone && <span className="remote-keys">{STOP_KEYS}</span>}
    </div>
  );
}
