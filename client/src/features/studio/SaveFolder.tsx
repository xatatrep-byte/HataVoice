import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FileVideo, FolderCog, FolderOpen, RotateCcw } from "lucide-react";
import { Button } from "../../ui/Button";
import { IS_MOBILE } from "../../platform";

type Folder = { path: string; chosen: boolean };

/** The last part of a path: a file's name. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Where recordings, snapshots and replays are saved: the whole path, a button to open it and one to choose another
 * folder (in Windows' own dialog, opened by Rust), and the last file saved, by name.
 */
export function SaveFolder({ last }: { last: string | null }) {
  const [folder, setFolder] = useState<Folder | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void invoke<Folder | null>("studio_folder")
      .then((now) => !gone && now && setFolder(now))
      .catch((e) => !gone && setError(String(e)));
    return () => {
      gone = true;
    };
  }, [last]);

  const run = (command: string) => {
    setError(null);
    void invoke<Folder | null>(command)
      .then((now) => now && setFolder(now))
      .catch((e) => setError(String(e)));
  };

  return (
    <div className="save-folder">
      <h3 className="settings-sub">Куда сохранять</h3>
      <div className="save-folder-path" title={folder?.path}>
        <FolderOpen size={16} aria-hidden />
        <span>{folder?.path ?? "…"}</span>
      </div>
      {IS_MOBILE && <p className="hint">Записи и снимки попадают в галерею телефона, в папку «Фильмы/ХатаВойс».</p>}
      <div className="field-row" hidden={IS_MOBILE}>
        <Button onClick={() => run("studio_open_folder")}>
          <FolderOpen size={14} /> Открыть папку
        </Button>
        <Button onClick={() => run("studio_pick_folder")}>
          <FolderCog size={14} /> Изменить…
        </Button>
        {folder?.chosen && (
          <Button variant="ghost" onClick={() => run("studio_folder_reset")}>
            <RotateCcw size={14} /> По умолчанию
          </Button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {last && (
        <div className="save-folder-last">
          <FileVideo size={15} aria-hidden />
          <span className="save-folder-last-label">Последний файл:</span>
          <span className="save-folder-last-name" title={last}>
            {fileName(last)}
          </span>
          {!IS_MOBILE && (
            <Button variant="ghost" onClick={() => void revealItemInDir(last).catch(() => {})}>
              Показать в папке
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
