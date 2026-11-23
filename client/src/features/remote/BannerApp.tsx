import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Gamepad2, MousePointerClick, X } from "lucide-react";
import { onRemote, remoteStop } from "../../remote/api";
import { STOP_KEYS } from "./RemoteHost";
import "../../characters/overlay.css";
import "./remote.css";

type Info = { remote: { name: string; keyboard: boolean } | null; pads: string[] };

/**
 * The page of the banner over everything while someone controls our PC or friends play on it with pads: who, how,
 * and how to stop it. It never takes the focus away from what we do, but takes the click.
 */
export function BannerApp() {
  const [info, setInfo] = useState<Info | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("overlay");
    const read = () => void invoke<Info | null>("remote_banner").then(setInfo).catch(() => {});
    read();
    let stop: (() => void) | null = null;
    let disposed = false;
    void onRemote((event) => {
      if ((event as { kind: string }).kind === "banner") read();
    }).then((unlisten) => (disposed ? unlisten() : (stop = unlisten)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  if (!info || (!info.remote && info.pads.length === 0)) return null;
  return (
    <div className={info.remote ? "remote-float" : "remote-float pads-only"} role="alert">
      {info.remote && (
        <>
          <MousePointerClick size={16} aria-hidden />
          <span>
            <b>{info.remote.name}</b> управляет твоим ПК · {info.remote.keyboard ? "мышь и клавиатура" : "только мышь"}
          </span>
          <button type="button" className="remote-float-stop" onClick={() => void remoteStop().catch(() => {})}>
            Остановить
          </button>
        </>
      )}
      {info.pads.length > 0 && (
        <>
          <Gamepad2 size={16} aria-hidden />
          <span>
            Геймпады: <b>{info.pads.join(", ")}</b>
          </span>
          <button type="button" className="remote-float-stop" onClick={() => void invoke("pad_stop_all").catch(() => {})}>
            Отключить всех
          </button>
        </>
      )}
      <span className="remote-keys">{STOP_KEYS}</span>
      <button type="button" className="remote-float-close" aria-label="Скрыть плашку" title="Скрыть плашку (выключить совсем — в настройках)" onClick={() => void invoke("remote_banner_close").catch(() => {})}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
