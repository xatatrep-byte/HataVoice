import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Gauge, Globe, KeyRound, Server, ShieldCheck, TriangleAlert } from "lucide-react";
import { useServers } from "../../state/servers";
import { Button } from "../../ui/Button";

/** What the test to the server found (`speedtest.rs`). */
type Speed = { ping_ms: number; down_mbps: number; up_mbps: number };
/** What each test point of the internet showed, and the VPN that is on, if one looks to be. */
type PointSpeed = { name: string; ping_ms: number | null; down_mbps: number | null; error: string | null };
type InternetSpeed = { points: PointSpeed[]; vpn: string | null };
type Where = "server" | "internet";

const number = (value: number) => (Math.round(value * 10) / 10).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Result({ speed }: { speed: Speed }) {
  return (
    <dl className="speed-result">
      <div>
        <dt>Отклик</dt>
        <dd>{Math.round(speed.ping_ms)} мс</dd>
      </div>
      <div>
        <dt>Скачивание</dt>
        <dd>{number(speed.down_mbps)} Мбит/с</dd>
      </div>
      <div>
        <dt>Отдача</dt>
        <dd>{number(speed.up_mbps)} Мбит/с</dd>
      </div>
    </dl>
  );
}

/** One test point of the internet: a row with its name, round trip and download speed, or why it did not answer. */
function Point({ point }: { point: PointSpeed }) {
  return (
    <div className="speed-point">
      <span className="speed-point-name">{point.name}</span>
      {point.ping_ms !== null && <span className="speed-point-value">{Math.round(point.ping_ms)} мс</span>}
      {point.down_mbps !== null && <span className="speed-point-value strong">{number(point.down_mbps)} Мбит/с</span>}
      {point.error && <span className="speed-point-error">{point.error}</span>}
    </div>
  );
}

/** The person's own key of VirusTotal for «Проверить на VirusTotal»: whether one is kept, and forgetting it. */
function VirusTotalKey() {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    void invoke<boolean>("vt_has_key")
      .then(setHas)
      .catch(() => setHas(false));
  }, []);
  if (has === null) return null;
  return (
    <>
      <h3 className="settings-sub">
        <ShieldCheck size={16} aria-hidden /> VirusTotal
      </h3>
      <div className="speed-block">
        {has ? (
          <>
            <p className="hint">Ключ VirusTotal сохранён на этом ПК: файлы из чата проверяются прямо в программе (щит у файла).</p>
            <Button
              onClick={() =>
                void invoke("vt_set_key", { key: null })
                  .then(() => setHas(false))
                  .catch(() => {})
              }
            >
              <KeyRound size={16} aria-hidden /> Забыть ключ
            </Button>
          </>
        ) : (
          <p className="hint">Ключа нет. Его можно добавить, когда в первый раз нажмёшь щит у файла в чате: там же написано, как получить его бесплатно.</p>
        )}
      </div>
    </>
  );
}

/**
 * «Сеть»: how fast the way is to the server we are on (its own channel, members only, nothing kept), and, when asked, to
 * the internet: test files from Russia and from Europe (no Cloudflare: it is blocked in Russia). A VPN that is on is
 * named, since any speed test measures the VPN then.
 */
export function NetworkSection() {
  const address = useServers((s) => s.selected);
  const [busy, setBusy] = useState<Where | null>(null);
  const [server, setServer] = useState<Speed | null>(null);
  const [internet, setInternet] = useState<InternetSpeed | null>(null);
  const [problem, setProblem] = useState<Partial<Record<Where, string>>>({});

  async function test(where: Where) {
    setBusy(where);
    setProblem((all) => ({ ...all, [where]: undefined }));
    try {
      if (where === "server") setServer(await invoke<Speed>("speed_server", { address }));
      else setInternet(await invoke<InternetSpeed>("speed_internet"));
    } catch (e) {
      setProblem((all) => ({ ...all, [where]: errorText(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h3 className="settings-sub">
        <Gauge size={16} aria-hidden /> Проверка скорости
      </h3>
      <div className="speed-block">
        <Button variant="primary" disabled={!address || busy !== null} onClick={() => void test("server")}>
          <Server size={16} aria-hidden /> {busy === "server" ? "Проверяю…" : "До сервера"}
        </Button>
        <p className="hint">
          Главная проверка для звонков: до сервера, на котором ты сейчас, через тот же защищённый канал, что голос и чат. Сервер ничего не
          запоминает, проверка занимает несколько секунд.
        </p>
        {!address && <p className="hint">Сначала зайди на сервер.</p>}
        {server && <Result speed={server} />}
        {problem.server && <p className="form-error">{problem.server}</p>}
      </div>
      <div className="speed-block">
        <Button disabled={busy !== null} onClick={() => void test("internet")}>
          <Globe size={16} aria-hidden /> {busy === "internet" ? "Проверяю… (около 15 секунд)" : "Интернет"}
        </Button>
        <p className="hint">
          Скачивание тестовых файлов, которые хостинги выкладывают для этого: из России (Selectel) и из Европы (Hetzner, Хельсинки). Они видят
          только, что этот ПК скачал файл. Отдачу честно меряет только «До сервера».
        </p>
        {internet?.vpn && (
          <p className="speed-vpn">
            <TriangleAlert size={16} aria-hidden /> Похоже, включён VPN ({internet.vpn}). Любой спидтест тогда меряет скорость VPN, а не твоего
            интернета. Чтобы узнать скорость самого интернета, выключи VPN на время проверки.
          </p>
        )}
        {internet && (
          <div className="speed-points">
            {internet.points.map((point) => (
              <Point key={point.name} point={point} />
            ))}
          </div>
        )}
        {problem.internet && <p className="form-error">{problem.internet}</p>}
      </div>
      <VirusTotalKey />
    </>
  );
}
