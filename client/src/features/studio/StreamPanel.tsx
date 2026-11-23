import { useEffect, useState } from "react";
import { Radio, Square } from "lucide-react";
import { studio, useStudio } from "../../studio/engine";
import { RESOLUTIONS } from "../../studio/layout";
import { isLive, SERVICES, serviceInfo, streaming, tightestPlace, useStream, type Destination, type StreamStatus } from "../../studio/stream";
import { Button } from "../../ui/Button";
import { Toggle } from "../../ui/Toggle";

function stateLine(state: StreamStatus | undefined): { text: string; live: boolean } | null {
  if (!state || state.status === "off") return null;
  if (state.status === "live") return { text: `в эфире · ${state.kbps} кбит/с`, live: true };
  if (state.status === "connecting") return { text: "подключаюсь…", live: false };
  return { text: `переподключаюсь: ${state.error}`, live: false };
}

function DestinationCard({ destination, on }: { destination: Destination; on: boolean }) {
  const info = serviceInfo(destination.service);
  const saved = useStream((s) => s.saved[destination.service]);
  const state = useStream((s) => s.states[destination.service]);
  const [key, setKey] = useState("");
  const line = stateLine(state);
  const vertical = RESOLUTIONS.find((r) => r.id === "vertical")!;
  const { output } = useStudio();
  return (
    <div className={destination.on ? "studio-destination on" : "studio-destination"}>
      <Toggle label={info.name} hint={destination.on ? info.advice : undefined} checked={destination.on} onChange={(checked) => !on && streaming.setDestination(destination.service, { on: checked })} />
      {line && <p className={line.live ? "studio-destination-state live" : "studio-destination-state"}>{line.text}</p>}
      {destination.on && !on && (
        <>
          {!info.url || destination.url !== info.url || info.id.startsWith("custom") ? (
            <label className="field">
              <span className="field-label">Адрес сервера</span>
              <input className="input" spellCheck={false} placeholder="rtmp://…" value={destination.url} onChange={(e) => streaming.setDestination(destination.service, { url: e.currentTarget.value })} />
            </label>
          ) : null}
          {saved ? (
            <p className="hint">
              Ключ сохранён и зашифрован на этом ПК.{" "}
              <button type="button" className="link-button" onClick={() => void streaming.forgetKey(destination.service)}>
                Забыть
              </button>
            </p>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor={`key-${info.id}`}>
                Ключ трансляции
              </label>
              <div className="studio-key-row">
                <input id={`key-${info.id}`} className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.currentTarget.value)} />
                <Button
                  disabled={!key.trim()}
                  onClick={() =>
                    void streaming
                      .saveKey(destination.service, key)
                      .then(() => setKey(""))
                      .catch((e) => useStream.setState({ error: String(e) }))
                  }
                >
                  Сохранить
                </Button>
              </div>
              <span className="hint">Где взять: {info.keyFrom}</span>
            </div>
          )}
          {info.vertical && output.height <= output.width && (
            <Button onClick={() => studio.setOutput({ ...output, width: vertical.width, height: vertical.height })}>Сделать кадр вертикальным</Button>
          )}
        </>
      )}
    </div>
  );
}

/** «Стрим»: where to, each place with its own key; the same picture goes to all of them at once. */
export function StreamTab() {
  const { destinations, states, error } = useStream();
  const output = useStudio((s) => s.output);
  const on = isLive(states);
  const tight = tightestPlace(destinations, output.kbps);

  useEffect(() => {
    void streaming.refreshSaved();
  }, []);

  const count = destinations.filter((d) => d.on).length;
  return (
    <section className="studio-section" aria-label="Стрим">
      <div className="field-row">
        {on ? (
          <Button variant="danger" onClick={() => streaming.stop()}>
            <Square size={14} /> Остановить стрим
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void streaming.start()}>
            <Radio size={14} /> Начать стрим
          </Button>
        )}
        <span className="hint">{count > 1 ? `Сразу на ${count} площадки` : count === 1 ? "На одну площадку" : "Отметь, куда стримить"}</span>
      </div>
      {error && <p className="form-error">{error}</p>}
      {tight && (
        <div className="studio-note-warn" role="alert">
          <span>
            {tight.name} принимает до {tight.max} кбит/с, а сейчас {output.kbps}. Зрители, которым площадка отдаёт поток как есть, будут ловить буферизацию.
          </span>
          <Button disabled={on} title={on ? "Битрейт меняется, когда стрим остановлен" : undefined} onClick={() => studio.setOutput({ ...output, kbps: tight.max })}>
            Поставить {tight.max}
          </Button>
        </div>
      )}
      <div className="studio-destinations">
        {SERVICES.map((s) => {
          const destination = destinations.find((d) => d.service === s.id);
          return destination ? <DestinationCard key={s.id} destination={destination} on={on} /> : null;
        })}
      </div>
      <p className="hint">Обрыв связи не останавливает стрим: программа подключается снова сама. Пока идёт стрим, включён режим стримера, и адреса с ключами на экране не видны.</p>
    </section>
  );
}
