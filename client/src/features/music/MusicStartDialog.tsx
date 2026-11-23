import { useEffect, useState } from "react";
import type { SoundSource } from "../../music/api";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import "./music.css";

/** How often the list of programs playing sound is read again while the dialog is open. */
const REFRESH_MS = 1000;

type Props = {
  open: boolean;
  onClose: () => void;
  /** The programs playing sound now (`music_sources`). */
  sources: () => Promise<SoundSource[]>;
  /** Whose music plays now, if a friend's: theirs stops when ours starts. */
  other: string | null;
  /** Plays `source` for the call; the error to show, or null. */
  onStart: (source: SoundSource) => Promise<string | null>;
  /** A phone: it may listen, not play (Android keeps other apps' sound from it). */
  phone?: boolean;
};

/** «Включить музыку для всех»: the programs playing sound, picked one goes to the call. */
export function MusicStartDialog({ open, onClose, sources, other, onStart, phone = false }: Props) {
  const [list, setList] = useState<SoundSource[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || phone) return;
    setError(null);
    let alive = true;
    const read = () =>
      void sources()
        .then((found) => alive && setList(found))
        .catch((e) => alive && setError(String(e)));
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, phone, sources]);

  // The first program playing now is picked until the person picks another (or it goes away).
  const chosen = list?.find((s) => s.pid === picked) ?? list?.[0] ?? null;

  const start = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    const why = await onStart(chosen);
    setBusy(false);
    if (why) setError(why);
    else onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Включить музыку для всех">
      {phone ? (
        <>
          <p className="music-start-lead">
            Включать музыку для всех можно с ПК на Windows: Android не даёт снимать звук других приложений. На телефоне её можно
            слушать — плеер появится над кнопками звонка.
          </p>
          <div className="row music-start-actions">
            <Button variant="primary" onClick={onClose}>
              Понятно
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="music-start-lead">Выбери программу, в которой играет музыка. Друзья услышат только её: ни уведомлений, ни игры, ни звонка.</p>
          {list !== null && list.length === 0 && <p className="hint">Сейчас ни одна программа не играет звук. Включи музыку в своём плеере — она появится здесь.</p>}
          <div className="music-sources" role="radiogroup" aria-label="Программы со звуком">
            {(list ?? []).map((source) => (
              <button
                key={source.pid}
                type="button"
                role="radio"
                aria-checked={chosen?.pid === source.pid}
                className={chosen?.pid === source.pid ? "music-source picked" : "music-source"}
                onClick={() => setPicked(source.pid)}
              >
                <span className="music-source-name">{source.name}</span>
                <small className="music-source-state">{source.active ? "играет сейчас" : "тихо"}</small>
                <span className="music-level" aria-hidden>
                  <i style={{ width: `${Math.round(Math.min(1, source.level * 1.6) * 100)}%` }} />
                </span>
              </button>
            ))}
          </div>
          {other && <p className="form-error">{other} уже включает музыку: твоя заиграет вместо неё.</p>}
          <p className="hint">В наушниках лучше: иначе микрофон ловит музыку из колонок, и друзья слышат её дважды.</p>
          {error && <p className="form-error">{error}</p>}
          <div className="row music-start-actions">
            <Button onClick={onClose}>Отмена</Button>
            <Button variant="primary" disabled={!chosen || busy} onClick={() => void start()}>
              ♪ {other ? "Включить вместо" : "Включить"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
