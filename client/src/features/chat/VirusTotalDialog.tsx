import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, KeyRound, ShieldAlert, ShieldCheck, ShieldQuestion, Upload } from "lucide-react";
import type { FileView } from "../../chat/api";
import { serverErrorText } from "../../server/session";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import "./virustotal.css";

/** What the site says of a file (`virustotal.rs`). */
export type VtFlag = { engine: string; result: string; malicious: boolean };
export type VtReport =
  | { state: "no_key"; sha256: string }
  | { state: "unknown"; sha256: string }
  | { state: "known"; sha256: string; malicious: number; suspicious: number; engines: number; flagged: VtFlag[]; analysed_at: number | null };

type Step = { at: "asking" } | { at: "report"; report: VtReport } | { at: "sending" } | { at: "looking"; since: number; id: string } | { at: "failed"; why: string };

/** How often a file sent to the site is asked after (the free key takes 4 requests a minute), and for how long. */
const LOOK_EVERY_MS = 20_000;
const LOOK_FOR_MS = 10 * 60_000;
const JOIN_URL = "https://www.virustotal.com/gui/join-us";
/** The site takes up to 200 MB from this program. */
const MAX_UPLOAD = 200 * 1024 * 1024;

const reportUrl = (sha256: string) => `https://www.virustotal.com/gui/file/${sha256}`;

function when(seconds: number | null): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

/** The verdict as words and a look: dangerous, doubtful, or clean. */
function Verdict({ report }: { report: Extract<VtReport, { state: "known" }> }) {
  const tone = report.malicious > 0 ? "bad" : report.suspicious > 0 ? "doubt" : "clean";
  const Icon = tone === "clean" ? ShieldCheck : ShieldAlert;
  const title =
    tone === "bad"
      ? `Опасно: ${report.malicious} из ${report.engines} антивирусов нашли угрозу`
      : tone === "doubt"
        ? `Подозрительно: ${report.suspicious} из ${report.engines} антивирусов сомневаются`
        : `Чисто: ни один из ${report.engines} антивирусов не нашёл угрозы`;
  return (
    <div className={`vt-verdict ${tone}`}>
      <Icon size={28} aria-hidden />
      <div>
        <b>{title}</b>
        {report.analysed_at && <p className="hint">Последняя проверка — {when(report.analysed_at)}.</p>}
      </div>
    </div>
  );
}

/**
 * «Проверить на VirusTotal», in the program: the file is looked up by its fingerprint with the person's own free key of
 * the site, and the verdict is shown here. Without a key the fingerprint opens the site in the browser. A file the site
 * has never seen is sent only when the person ticks that they know it becomes the site's and its partners'.
 */
export function VirusTotalDialog({ address, file, onClose }: { address: string; file: FileView; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ at: "asking" });
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);

  const ask = async () => {
    setStep({ at: "asking" });
    try {
      setStep({ at: "report", report: await invoke<VtReport>("vt_check", { address, blob: file.blob }) });
    } catch (e) {
      setStep({ at: "failed", why: serverErrorText(e) });
    }
  };

  useEffect(() => {
    void ask();
  }, [address, file.blob]);

  // A file sent to the site: asked after every 20 seconds until it is done, then its verdict.
  useEffect(() => {
    if (step.at !== "looking") return;
    const { since, id } = step;
    let stop = false;
    const timer = setInterval(async () => {
      if (stop) return;
      if (Date.now() - since > LOOK_FOR_MS) {
        stop = true;
        setStep({ at: "failed", why: "VirusTotal проверяет слишком долго. Попробуй ещё раз позже — файл у него уже есть." });
        return;
      }
      try {
        if (await invoke<boolean>("vt_analysis", { id })) {
          stop = true;
          await ask();
        }
      } catch (e) {
        stop = true;
        setStep({ at: "failed", why: serverErrorText(e) });
      }
    }, LOOK_EVERY_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [step]);

  const saveKey = async () => {
    setKeyError(null);
    try {
      await invoke("vt_set_key", { key });
      setKey("");
      await ask();
    } catch (e) {
      setKeyError(serverErrorText(e));
    }
  };

  const send = async () => {
    setStep({ at: "sending" });
    try {
      const id = await invoke<string>("vt_upload", { address, blob: file.blob, name: file.name });
      setStep({ at: "looking", since: Date.now(), id });
    } catch (e) {
      setStep({ at: "failed", why: serverErrorText(e) });
    }
  };

  const report = step.at === "report" ? step.report : null;
  return (
    <Modal open onClose={onClose} title="Проверка на VirusTotal">
      <p className="vt-file">{file.name}</p>
      {step.at === "asking" && <p className="hint">Снимаю отпечаток файла и спрашиваю VirusTotal…</p>}
      {step.at === "sending" && <p className="hint">Отправляю файл на VirusTotal…</p>}
      {step.at === "looking" && (
        <p className="hint">VirusTotal проверяет файл десятками антивирусов. Обычно это 1–3 минуты — окно можно не закрывать, ответ появится сам.</p>
      )}
      {step.at === "failed" && (
        <>
          <p className="form-error">{step.why}</p>
          <Button onClick={() => void ask()}>Попробовать ещё раз</Button>
        </>
      )}
      {report?.state === "known" && (
        <>
          <Verdict report={report} />
          {report.flagged.length > 0 && (
            <ul className="vt-flags" aria-label="Что нашли антивирусы">
              {report.flagged.map((flag) => (
                <li key={flag.engine} className={flag.malicious ? "bad" : "doubt"}>
                  <b>{flag.engine}</b> <span>{flag.result}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <Button onClick={() => void openUrl(reportUrl(report.sha256))}>
              <ExternalLink size={16} aria-hidden /> Полный отчёт
            </Button>
            <Button variant="primary" onClick={onClose}>
              Готово
            </Button>
          </div>
        </>
      )}
      {report?.state === "unknown" && (
        <>
          <div className="vt-verdict unknown">
            <ShieldQuestion size={28} aria-hidden />
            <div>
              <b>VirusTotal ещё не видел этот файл</b>
              <p className="hint">Это не значит, что он опасен: его просто никто ещё не проверял. Так бывает со своими фото, документами и редкими программами.</p>
            </div>
          </div>
          {file.size > MAX_UPLOAD ? (
            <p className="hint">Файл больше 200 МБ — отправить его на проверку отсюда нельзя.</p>
          ) : (
            <>
              <p className="vt-warning">
                Чтобы проверить сам файл, его нужно отправить на VirusTotal. Файл станет доступен VirusTotal (Google) и компаниям-партнёрам, которые
                изучают вирусы. Не отправляй личные фото, документы и всё, что не должны видеть чужие.
              </p>
              <label className="check">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.currentTarget.checked)} />
                Понимаю: файл увидят VirusTotal и его партнёры
              </label>
              <div className="modal-actions">
                <Button onClick={onClose}>Не отправлять</Button>
                <Button variant="danger" disabled={!agreed} onClick={() => void send()}>
                  <Upload size={16} aria-hidden /> Отправить на проверку
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {report?.state === "no_key" && (
        <>
          <p className="hint">
            Чтобы проверять файлы прямо здесь и видеть ответ антивирусов, нужен свой бесплатный ключ VirusTotal. Ключ хранится только на этом ПК.
          </p>
          <ol className="vt-steps">
            <li>
              Зарегистрируйся на VirusTotal —{" "}
              <button type="button" className="vt-link" onClick={() => void openUrl(JOIN_URL)}>
                открыть страницу
              </button>
              .
            </li>
            <li>Нажми на свой профиль справа вверху → «API key».</li>
            <li>Скопируй ключ и вставь сюда.</li>
          </ol>
          <div className="field-row">
            <input
              className="input vt-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Ключ VirusTotal (64 знака)"
              aria-label="Ключ VirusTotal"
              value={key}
              onChange={(e) => setKey(e.currentTarget.value)}
            />
            <Button variant="primary" disabled={key.trim().length === 0} onClick={() => void saveKey()}>
              <KeyRound size={16} aria-hidden /> Сохранить
            </Button>
          </div>
          {keyError && <p className="form-error">{keyError}</p>}
          <p className="hint">
            Без ключа можно открыть отчёт в браузере: туда уйдёт только отпечаток файла. Если VirusTotal напишет «Item not found» — значит, этот файл
            там ещё никто не проверял.
          </p>
          <div className="modal-actions">
            <Button onClick={() => void openUrl(reportUrl(report.sha256))}>
              <ExternalLink size={16} aria-hidden /> Открыть в браузере
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
