import { isVoiceNote } from "../../chat/voiceNote";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { pickSave } from "../../files/pick";
import { Download, FileText, Film, ShieldCheck, X } from "lucide-react";
import { chatFileSave, chatFileUrl, onFileProgress, type FileView } from "../../chat/api";
import { serverErrorText } from "../../server/session";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { notify } from "../../ui/toasts";
import { VirusTotalDialog } from "./VirusTotalDialog";

const UNAVAILABLE = "Файл недоступен";

/** «512 Б», «12 КБ», «1,4 МБ», «1,25 ГБ». */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
  return `${Number((bytes / 1024 ** 3).toFixed(2)).toString().replace(".", ",")} ГБ`;
}

/** Asks where, then has Rust write the file there, opened. */
export async function saveFile(address: string, file: FileView): Promise<void> {
  const where = await pickSave("any", file.name).catch(() => null);
  if (!where) return;
  try {
    await chatFileSave(address, file.blob, where.token);
    notify.info("Файл сохранён");
  } catch (e) {
    notify.error(serverErrorText(e));
  }
}

/** A file of a message: a picture or a video in place, anything else as a card to save or to check. */
export function MessageFile({ address, file, onOpen }: { address: string; file: FileView; onOpen: (file: FileView) => void }) {
  const [broken, setBroken] = useState(false);
  const url = chatFileUrl(address, file.blob);
  if (broken) return <div className="msg-file broken">{UNAVAILABLE}</div>;
  if (file.big) return <BigFile address={address} file={file} />;
  if (isVoiceNote(file.name)) {
    return <audio className="msg-voice" src={url} controls preload="metadata" aria-label="Голосовое сообщение" onError={() => setBroken(true)} />;
  }
  if (file.mime.startsWith("image/")) {
    return (
      <button type="button" className="msg-picture" aria-label={`Открыть «${file.name}»`} onClick={() => onOpen(file)}>
        <img src={url} alt={file.name} loading="lazy" onError={() => setBroken(true)} />
      </button>
    );
  }
  if (file.mime.startsWith("video/")) {
    return <video className="msg-video" src={url} controls muted preload="metadata" aria-label={file.name} onError={() => setBroken(true)} />;
  }
  return (
    <div className="msg-file">
      <FileText size={22} aria-hidden />
      <span className="msg-file-text">
        <span className="msg-file-name">{file.name}</span>
        <span className="msg-file-size">{sizeLabel(file.size)}</span>
      </span>
      <CheckButton address={address} file={file} />
      <IconButton label="Сохранить" onClick={() => void saveFile(address, file)}>
        <Download size={16} />
      </IconButton>
    </div>
  );
}

/** «Проверить на VirusTotal»: the shield, and the check in its own window. */
function CheckButton({ address, file }: { address: string; file: FileView }) {
  const [checking, setChecking] = useState(false);
  return (
    <>
      <IconButton label="Проверить на VirusTotal" onClick={() => setChecking(true)}>
        <ShieldCheck size={16} />
      </IconButton>
      {checking && <VirusTotalDialog address={address} file={file} onClose={() => setChecking(false)} />}
    </>
  );
}

/** A file over 25 MB (it came in parts): a card to save, with how far the saving is; a video or a picture too. */
function BigFile({ address, file }: { address: string; file: FileView }) {
  const [saving, setSaving] = useState<number | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void onFileProgress((progress) => {
      if (progress.address === address && progress.key === `down:${file.blob}`) setSaving(progress.done >= progress.total ? null : progress.done / progress.total);
    })
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [address, file.blob]);
  const Icon = file.mime.startsWith("video/") ? Film : FileText;
  return (
    <div className="msg-file">
      <Icon size={22} aria-hidden />
      <span className="msg-file-text">
        <span className="msg-file-name">{file.name}</span>
        <span className="msg-file-size">{saving === null ? sizeLabel(file.size) : `Сохраняется: ${Math.round(saving * 100)}%`}</span>
      </span>
      <CheckButton address={address} file={file} />
      <IconButton label="Сохранить" onClick={() => void saveFile(address, file)}>
        <Download size={16} />
      </IconButton>
    </div>
  );
}

/** A picture on the whole window; Esc or a click outside closes it. */
export function Lightbox({ address, file, onClose }: { address: string; file: FileView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={file.name} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <img src={chatFileUrl(address, file.blob)} alt={file.name} />
      <div className="lightbox-actions">
        <Button onClick={() => void saveFile(address, file)}>
          <Download size={16} /> Сохранить
        </Button>
        <IconButton label="Закрыть" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
    </div>
  );
}
