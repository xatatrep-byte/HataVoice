import { useState } from "react";
import { Plus } from "lucide-react";
import { describeHost, type HostPhase } from "../../host/describe";
import { hostingSupported, useHost } from "../../host/useHost";
import { useServers } from "../../state/servers";
import { Button } from "../../ui/Button";
import "./host.css";
import { Secret } from "../../ui/Secret";
import { ConnectGuide } from "./ConnectGuide";
import { localAddress } from "./createServer";
import { DeleteServerZone } from "./DeleteServerDialog";
import { EntryWays } from "./EntryWays";
import { guideFactsOf } from "./entryState";
import { IS_MOBILE } from "../../platform";

const PHASE_LABEL: Record<HostPhase, string> = {
  none: "Не создан",
  stopped: "Выключен",
  starting: "Запускается…",
  running: "Работает",
  failed: "Ошибка",
};

type Props = {
  /** Opens this PC's own server: its local address and name. */
  onConnectLocal: (address: string, name: string) => void;
  /** Opens «Создать свой» of «Добавить сервер». */
  onCreate?: () => void;
};

export function HostCard({ onConnectLocal, onCreate }: Props) {
  const host = useHost();
  const servers = useServers((s) => s.servers);
  // The address last copied, so its button can say so.
  const [copied, setCopied] = useState<string | null>(null);

  if (!hostingSupported) {
    return (
      <section className="card host-card">
        <h1>Свой сервер</h1>
        <p className="hint">Создать свой сервер можно только в приложении.</p>
      </section>
    );
  }
  if (!host.view) return null;

  const config = host.view.config;
  if (!config) {
    return (
      <section className="card host-card">
        <div className="card-head">
          <h1>Свой сервер</h1>
          <span className="pill none">{PHASE_LABEL.none}</span>
        </div>
        <p className="hint">
          {IS_MOBILE
            ? "На этом телефоне нет своего сервера. Создай его — друзья будут заходить к тебе по ссылке, пока ХатаВойс открыт или висит в уведомлениях."
            : "На этом ПК нет своего сервера. Создай его — друзья будут заходить к тебе по ссылке, пока этот ПК включён."}
        </p>
        {onCreate && (
          <Button variant="primary" onClick={onCreate}>
            <Plus size={15} aria-hidden /> Создать сервер
          </Button>
        )}
      </section>
    );
  }

  const summary = describeHost(host.view);
  const running = summary.phase === "running" || summary.phase === "starting";
  const address = localAddress(config);
  // The name it goes by in the list: renamed in its settings, it is no longer the one it was made with.
  const name = servers.find((s) => s.address === address)?.name ?? config.name;
  const facts = guideFactsOf(host.view);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    } catch {
      // Clipboard may be unavailable; the address is visible anyway.
    }
  }

  return (
    <>
      <section className="card host-card">
        <div className="card-head">
          <h1>{name}</h1>
          <span className={`pill ${summary.phase}`}>{PHASE_LABEL[summary.phase]}</span>
        </div>

        {summary.shareAddress && (
          <div className="field">
            <span>Адрес для друзей</span>
            <div className="row">
              <div className="binding">
                <Secret>{summary.shareAddress}</Secret>
              </div>
              <button onClick={() => void copy(summary.shareAddress!)}>{copied === summary.shareAddress ? "Скопировано" : "Копировать"}</button>
            </div>
          </div>
        )}
        {running &&
          summary.virtualAddresses.map(({ label, address: shared }) => (
            <div className="field" key={shared}>
              <span>Для друзей в {label}</span>
              <div className="row">
                <div className="binding">
                  <Secret>{shared}</Secret>
                </div>
                <button onClick={() => void copy(shared)}>{copied === shared ? "Скопировано" : "Копировать"}</button>
              </div>
            </div>
          ))}
        {summary.lanAddress && running && (
          <p className="hint">
            В той же сети (Wi-Fi): <Secret>{summary.lanAddress}</Secret>
          </p>
        )}
        {running && host.view.status?.update_version && (
          <p className="hint">Участники, у кого версия старше, получают обновление до {host.view.status.update_version} с этого сервера: кнопка появится у них вверху окна.</p>
        )}

        {summary.phase === "failed" && (
          <ul className="notes">
            {summary.notes.map((note) => (
              <li key={note.text} className={`note ${note.level}`}>
                {note.text}
              </li>
            ))}
          </ul>
        )}

        <div className="row actions">
          {running ? (
            <>
              <button onClick={() => onConnectLocal(address, name)}>Открыть сервер</button>
              <button className="secondary" onClick={() => void host.stop()} disabled={host.busy}>
                Выключить
              </button>
            </>
          ) : (
            <button onClick={() => void host.start()} disabled={host.busy}>
              Включить
            </button>
          )}
        </div>
        <p className="hint">
          При первом запуске Windows спросит доступ к сети для hatavoice-server и livekit-server. Разреши, иначе друзья не подключатся. Если включён VPN в режиме TUN,
          входящие подключения могут не работать.
          {summary.virtualAddresses.length > 0 &&
            " Сети Radmin VPN и ZeroTier Windows часто считает общественными: если друзья оттуда не подключаются, разреши доступ и в общественных сетях."}
        </p>
      </section>
      <EntryWays host={host} guide={false} />
      {facts && <ConnectGuide facts={facts} />}
      <DeleteServerZone name={name} address={address} />
    </>
  );
}
