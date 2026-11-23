import { useState } from "react";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { Segmented } from "../../ui/Segmented";
import { pageLink, parseWatchLink, UNSUPPORTED } from "../../watch/links";
import { hostView } from "../../voice/ownCapture";

/** On a PC with Windows a site is watched right in the call (see `WatchTile`). */
const IN_CALL = hostView() !== null;

type Props = {
  open: boolean;
  onClose: () => void;
  /** Everyone in the call starts watching `url`. */
  onStart: (url: string) => void;
};

type Mode = "sync" | "stream";

/**
 * «Совместный просмотр»: a link everyone in the call watches together, in step. YouTube, Rutube, VK Video and video
 * files play right in the call; any other site opens in a window of its own, watched in step or shown as a stream.
 */
export function WatchDialog({ open, onClose, onStart }: Props) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("sync");
  const [problem, setProblem] = useState<string | null>(null);
  const link = parseWatchLink(text);
  const page = link?.kind === "page";

  function start() {
    if (!link) {
      setProblem(UNSUPPORTED);
      return;
    }
    onStart(link.kind === "page" ? pageLink(link.url, mode === "stream") : text.trim());
    setText("");
    setProblem(null);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Совместный просмотр">
      <form
        className="watch-form"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <label className="field">
          <span className="field-label">Ссылка на видео или на страницу с ним</span>
          <input
            className="input"
            autoFocus
            placeholder="https://…"
            value={text}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setProblem(null);
            }}
          />
        </label>
        {page && (
          <>
            <Segmented<Mode>
              label="Как смотреть"
              value={mode}
              options={[
                { value: "sync", label: "Синхронно" },
                { value: "stream", label: "Трансляцией" },
              ]}
              onChange={setMode}
            />
            <p className="hint">
              {mode === "sync"
                ? IN_CALL
                  ? "Сайт откроется прямо в звонке у каждого. Плеер, сезон, серия и озвучка — кнопками над видео, общие для всех. Картинка в полном качестве у каждого, пауза и перемотка общие."
                  : "Каждый откроет этот сайт у себя. Плеер, сезон, серия и озвучка встанут как у всех сами. Картинка в полном качестве у каждого, пауза и перемотка общие."
                : "Сайт откроется только у тебя. Ты выбираешь плеер и озвучку, а друзья видят твоё окно, как показ экрана. Работает с любым сайтом, но качество как у демонстрации экрана."}
            </p>
          </>
        )}
        {!page && (
          <p className="hint">
            {IN_CALL
              ? "YouTube, Rutube, VK Видео, ссылки на видеофайлы и любой сайт с видео играют прямо в звонке. На сайте ХатаВойс сам найдёт его плееры, сезоны, серии и озвучки."
              : "YouTube, Rutube, VK Видео и ссылки на видеофайлы играют прямо в звонке. Любой другой сайт откроется в отдельном окне."}
          </p>
        )}
        {problem && <p className="form-error">{problem}</p>}
        <p className="hint">Сервер не знает, что вы смотрите, а сайт с видео видит каждого зрителя.</p>
        <div className="modal-actions">
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" disabled={!text.trim()}>
            Смотреть вместе
          </Button>
        </div>
      </form>
    </Modal>
  );
}
