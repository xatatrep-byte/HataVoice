import { Gamepad2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DRIVER_PAGE, type PlayView } from "../../pads/api";
import type { PadAsk } from "../../pads/usePads";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { STOP_KEYS } from "../remote/RemoteHost";
import "./pads.css";

type AskProps = {
  ask: PadAsk | null;
  name: string;
  /** We show our screen now: what they would play. */
  sharing: boolean;
  onAnswer: (allow: boolean) => void;
};

/** Someone asks to play on our PC with a pad: let them or not. Closing it is a no. */
export function PadAskDialog({ ask, name, sharing, onAnswer }: AskProps) {
  return (
    <Modal open={!!ask} onClose={() => onAnswer(false)} title="Игра геймпадом">
      <p>
        <b>{name}</b> хочет играть на твоём ПК своим геймпадом, как второй игрок рядом с тобой.
      </p>
      {!sharing && <p className="form-error">Сначала покажи экран с игрой: друг играет тем, что видит.</p>}
      <p className="hint">
        Для твоего ПК это обычный геймпад Xbox: он жмёт кнопки там, где слушают геймпады (в играх, в Steam), но не печатает и не двигает мышь.
        Отключить можно кнопкой или клавишами {STOP_KEYS}. Данные от друга зашифрованы ключом только для вас двоих.
      </p>
      <div className="row pad-actions">
        <Button variant="primary" onClick={() => onAnswer(true)}>
          Пустить
        </Button>
        <Button variant="ghost" onClick={() => onAnswer(false)}>
          Отказать
        </Button>
      </div>
    </Modal>
  );
}

type PlayersProps = {
  guests: PlayView[];
  nameOf: (user: string) => string;
  onKick: (user: string) => void;
  onStopAll: () => void;
  /** The remote-control banner is over the top too: go below it. */
  lower?: boolean;
};

/** Who plays on our PC with a pad, each with «Отключить». */
export function PadPlayers({ guests, nameOf, onKick, onStopAll, lower = false }: PlayersProps) {
  if (guests.length === 0) return null;
  return (
    <div className={lower ? "pad-players lower" : "pad-players"} role="status" aria-label="Геймпады друзей">
      <Gamepad2 size={16} aria-hidden />
      {guests.map((g) => (
        <span key={g.peer} className="pad-player">
          {nameOf(g.peer)} · игрок {g.player}
          <button type="button" className="link-button" onClick={() => onKick(g.peer)}>
            Отключить
          </button>
        </span>
      ))}
      {guests.length > 1 && (
        <Button variant="danger" onClick={onStopAll}>
          Отключить всех
        </Button>
      )}
      <span className="remote-keys">{STOP_KEYS}</span>
    </div>
  );
}

/** A friend asked to play, and this PC has no driver for pads: what it is and where the owner gets it. */
export function NoDriverCard({ name, onClose }: { name: string | null; onClose: () => void }) {
  return (
    <Modal open={name !== null} onClose={onClose} title="Нужен драйвер геймпадов">
      <p>
        <b>{name}</b> хочет поиграть на твоём ПК своим геймпадом. Для этого нужен бесплатный драйвер ViGEmBus 1.22.0, тот же, что у
        Steam, DS4Windows и Parsec.
      </p>
      <p className="hint">Поставь его сам: нужны права администратора. Потом друг попросит ещё раз. ХатаВойс сам драйвер не ставит и не скачивает.</p>
      <div className="row pad-actions">
        <Button variant="primary" onClick={() => void openUrl(DRIVER_PAGE).catch(() => {})}>
          Открыть страницу драйвера
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </Modal>
  );
}
