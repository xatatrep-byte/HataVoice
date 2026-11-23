import { useState } from "react";
import { Globe, KeyRound, Network } from "lucide-react";
import type { HostConfig } from "../../host/types";
import type { HostControls } from "../../host/useHost";
import { Button } from "../../ui/Button";
import { Toggle } from "../../ui/Toggle";
import { ConnectGuide } from "./ConnectGuide";
import { configProblem, entryState, guideFactsOf, p2pOn, sameConfig, type WayStatus } from "./entryState";

function Status({ status }: { status: WayStatus }) {
  return (
    <span className={`entry-way-status ${status.tone}`} role="status">
      {status.text}
    </span>
  );
}

const PORTS: { key: "api_port" | "rtc_udp_port" | "rtc_tcp_port" | "livekit_port"; label: string }[] = [
  { key: "api_port", label: "Порт сервера (TCP)" },
  { key: "rtc_udp_port", label: "Порт голоса (UDP)" },
  { key: "rtc_tcp_port", label: "Порт голоса через TCP" },
  { key: "livekit_port", label: "Внутренний порт LiveKit (только этот ПК)" },
];

/**
 * «Как друзья заходят» for the server hosted here: each way with a switch and how it is doing now, one line for the
 * whole, the rarely needed ports behind «Дополнительно», and «Применить», which restarts a running server.
 */
export function EntryWays({ host, guide = true }: { host: HostControls; guide?: boolean }) {
  const view = host.view;
  const [draft, setDraft] = useState<HostConfig | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  if (!view?.config) return null;

  const saved = view.config;
  const config = draft ?? saved;
  const changed = draft !== null && !sameConfig(draft, saved);
  const problem = changed ? configProblem(config) : null;
  const state = entryState(view);
  const facts = guideFactsOf(view);
  const set = (change: Partial<HostConfig>) => setDraft({ ...config, ...change });

  async function apply() {
    if (!changed || problem) return;
    const next = { ...config, external_ip: config.external_ip?.trim() || null };
    if (await host.apply(next)) setDraft(null);
  }

  return (
    <section className="entry-ways" aria-label="Как друзья заходят">
      <h3 className="settings-sub">Как друзья заходят</h3>
      <p className={`entry-summary ${state.summary.tone}`} role="status">
        {state.summary.text}
      </p>
      <p className="hint">
        Включи оба способа — ХатаВойс сам выберет для каждого друга тот, что работает. Хватает и одного работающего.
      </p>

      <div className="entry-way-list">
        <div className="entry-way">
          <KeyRound className="entry-way-icon" size={20} aria-hidden />
          <div className="entry-way-main">
            <Toggle
              label="Без белого IP — по ключу сервера"
              hint="Работает почти у всех: с серым IP и закрытыми портами тоже. Если связь напрямую не пробьётся, она пойдёт через промежуточный узел — он видит только шифр"
              checked={p2pOn(config)}
              onChange={(p2p) => set({ p2p })}
            />
            <Status status={state.p2p} />
          </div>
        </div>

        <div className="entry-way">
          <Globe className="entry-way-icon" size={20} aria-hidden />
          <div className="entry-way-main">
            <div className="entry-way-head">
              <span className="toggle-label">Напрямую по белому IP</span>
              <span className="hint">Самый короткий путь — задержка меньше. Нужен белый IP и открытые порты на роутере</span>
            </div>
            <Status status={state.direct} />
            <Toggle
              label="Открывать порты на роутере сам (UPnP)"
              hint="Выключи, если открываешь порты вручную или не хочешь, чтобы программа меняла настройки роутера"
              checked={config.upnp}
              onChange={(upnp) => set({ upnp })}
            />
          </div>
        </div>

        <div className="entry-way">
          <Network className="entry-way-icon" size={20} aria-hidden />
          <div className="entry-way-main">
            <div className="entry-way-head">
              <span className="toggle-label">Запасной путь: Radmin VPN, ZeroTier</span>
              <span className="hint">Общая сеть с другом. Ставится отдельно, на этом ПК и у друга</span>
            </div>
            <ul className="entry-way-nets">
              {state.nets.map((net) => (
                <li key={net.label}>
                  <b>{net.label}</b> <Status status={net.status} />
                </li>
              ))}
            </ul>
            {state.restartForNet && (
              <Button onClick={() => void host.restart()} disabled={host.busy || changed}>
                Перезапустить сервер
              </Button>
            )}
          </div>
        </div>
      </div>

      <button type="button" className="link-button entry-way-more" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "▾ Скрыть дополнительные" : "▸ Дополнительно: порты и внешний IP"}
      </button>
      {advanced && (
        <div className="entry-way-advanced">
          {PORTS.map(({ key, label }) => (
            <label key={key} className="field">
              <span className="field-label">{label}</span>
              <input className="input" type="number" min={1024} max={65535} value={config[key]} onChange={(e) => set({ [key]: Number(e.currentTarget.value) })} />
            </label>
          ))}
          <label className="field">
            <span className="field-label">Внешний IP, если роутер его не сообщает</span>
            <input className="input" value={config.external_ip ?? ""} placeholder="например 203.0.113.7" onChange={(e) => set({ external_ip: e.currentTarget.value })} />
          </label>
        </div>
      )}

      {(changed || host.error) && (
        <div className="entry-way-apply">
          {problem ? <p className="form-error">{problem}</p> : host.error ? <p className="form-error">{host.error}</p> : null}
          {changed && (
            <>
              <span className="hint">{view.running ? "Сервер перезапустится на несколько секунд — друзья переподключатся сами." : "Настройки сохранятся до включения сервера."}</span>
              <div className="entry-way-apply-buttons">
                <Button onClick={() => setDraft(null)} disabled={host.busy}>
                  Отменить
                </Button>
                <Button variant="primary" onClick={() => void apply()} disabled={host.busy || problem !== null}>
                  {host.busy ? "Применяю…" : "Применить"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {guide && facts && (
        <>
          <button type="button" className="link-button entry-way-more" aria-expanded={showGuide} onClick={() => setShowGuide((s) => !s)}>
            {showGuide ? "▾ Скрыть пошаговую инструкцию" : "▸ Пошаговая инструкция: как позвать друзей"}
          </button>
          {showGuide && <ConnectGuide facts={facts} />}
        </>
      )}
    </section>
  );
}
