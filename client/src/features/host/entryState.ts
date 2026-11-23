import { describeHost } from "../../host/describe";
import type { HostConfig, HostView } from "../../host/types";
import type { GuideFacts } from "./guideSteps";

/** What the step-by-step guide needs to know of the server hosted here. */
export function guideFactsOf(view: HostView): GuideFacts | null {
  const config = view.config;
  if (!config) return null;
  const summary = describeHost(view);
  const kind = view.status?.network.router_ip_kind ?? null;
  return {
    radmin: summary.virtualAddresses.find((v) => v.label === "Radmin VPN")?.address ?? null,
    zerotier: summary.virtualAddresses.find((v) => v.label === "ZeroTier")?.address ?? null,
    radminNow: summary.virtualNow.some((v) => v.label === "Radmin VPN"),
    zerotierNow: summary.virtualNow.some((v) => v.label === "ZeroTier"),
    publicAddress: summary.shareAddress,
    publicWorks: summary.publicWorks,
    ports: `TCP ${config.api_port}, TCP ${config.rtc_tcp_port}, UDP ${config.rtc_udp_port}`,
    p2p: summary.p2pAddress,
    ipKind: kind === "public" || kind === "cgnat" || kind === "private" ? kind : null,
    publicIp: view.status?.network.public_ip ?? null,
    localIp: view.status?.network.local_ip ?? null,
    running: summary.phase === "running" || summary.phase === "starting",
  };
}

/** How a way in is doing: «ok» works, «off» is not in use (and needn't be), «wait» is being found out. */
export type Tone = "ok" | "warn" | "error" | "off" | "wait";
export type WayStatus = { tone: Tone; text: string };

/** The ways friends reach the server hosted here, each with what the owner should know of it now. */
export type EntryState = {
  /** One line for the whole: can friends get in now, and how. */
  summary: WayStatus;
  p2p: WayStatus;
  direct: WayStatus;
  /** Radmin VPN and ZeroTier: a fallback through a network shared with a friend. */
  nets: { label: string; status: WayStatus }[];
  /** A network was joined after the start: the server sees it once restarted. */
  restartForNet: boolean;
};

export const FALLBACK_NETS = ["Radmin VPN", "ZeroTier"] as const;

/** P2P is on unless turned off: servers made before the switch had it on. */
export const p2pOn = (config: HostConfig) => config.p2p !== false;

export function entryState(view: HostView): EntryState {
  const config = view.config;
  const summary = describeHost(view);
  const running = summary.phase === "running";
  const idle: WayStatus =
    summary.phase === "starting" ? { tone: "wait", text: "Проверяю…" } : { tone: "off", text: "Узнаю, когда сервер включится" };

  const nets = FALLBACK_NETS.map((label) => {
    const atStart = summary.virtualAddresses.some((v) => v.label === label);
    const now = summary.virtualNow.some((v) => v.label === label);
    const status: WayStatus = !running
      ? idle
      : atStart
        ? { tone: "ok", text: "Есть: друзья в этой сети заходят по её адресу" }
        : now
          ? { tone: "warn", text: "Включён после запуска сервера — перезапусти сервер, чтобы он его увидел" }
          : { tone: "off", text: "Не установлен. Нужен, только если у друга не работают способы выше" };
    return { label, status, restart: running && !atStart && now };
  });
  const restartForNet = nets.some((n) => n.restart);
  const netList = nets.map(({ label, status }) => ({ label, status }));

  if (!config || !running) {
    const whole: WayStatus =
      summary.phase === "starting"
        ? { tone: "wait", text: "Сервер запускается…" }
        : summary.phase === "failed"
          ? { tone: "error", text: "Сервер остановился с ошибкой — друзья не зайдут, пока он не заработает" }
          : { tone: "off", text: "Сервер выключен — друзья не зайдут, пока он не включится" };
    return {
      summary: whole,
      p2p: config && !p2pOn(config) ? { tone: "off", text: "Выключено" } : idle,
      direct: idle,
      nets: netList,
      restartForNet,
    };
  }

  const keyOn = p2pOn(config);
  const p2p: WayStatus = !keyOn
    ? { tone: "off", text: "Выключено" }
    : summary.p2pAddress
      ? { tone: "ok", text: "Работает" }
      : { tone: "warn", text: "Не отвечает. Проверь интернет на этом ПК или перезапусти сервер" };
  const keyWorks = p2p.tone === "ok";

  const net = view.status!.network;
  const notNeeded = keyWorks ? " — это не страшно: друзья заходят по ключу" : "";
  const blocked = (text: string): WayStatus => ({ tone: keyWorks ? "off" : "error", text: text + (keyWorks ? notNeeded : " — включи «Без белого IP»") });
  const closedPorts = net.ports.some((p) => !p.open);
  const direct: WayStatus = summary.publicWorks
    ? { tone: "ok", text: "Работает" }
    : net.router_ip_kind === "cgnat"
      ? blocked("Не выйдет: у провайдера серый IP")
      : net.router_ip_kind === "private"
        ? blocked("Не выйдет: роутер стоит за другим роутером")
        : net.upnp.state === "searching"
          ? { tone: "wait", text: "Открываю порты на роутере…" }
          : !net.public_ip
            ? { tone: "warn", text: "Не знаю внешний IP: впиши его в «Дополнительно»" }
            : net.upnp.state === "disabled" && closedPorts
              ? { tone: keyWorks ? "off" : "warn", text: "Порты закрыты: включи «Открывать порты на роутере сам» или открой их вручную" }
              : net.upnp.state === "unavailable" && closedPorts
                ? { tone: keyWorks ? "off" : "warn", text: "Роутер не дал открыть порты сам — открой их вручную, шаги в инструкции" }
                : closedPorts
                  ? { tone: keyWorks ? "off" : "warn", text: "Роутер открыл не все порты — открой остальные вручную" }
                  : { tone: "warn", text: "Не работает" };
  const directWorks = direct.tone === "ok";

  const shared = summary.virtualAddresses.map((v) => v.label);
  const whole: WayStatus =
    directWorks && keyWorks
      ? { tone: "ok", text: "Друзья заходят напрямую по белому IP, а у кого не выйдет — по ключу сервера" }
      : directWorks
        ? { tone: "ok", text: "Друзья заходят напрямую по белому IP" }
        : keyWorks
          ? { tone: "ok", text: "Друзья заходят по ключу сервера — белый IP не нужен" }
          : shared.length > 0
            ? { tone: "warn", text: `Из интернета сейчас не зайти — только через ${shared.join(" и ")}` }
            : {
                tone: "error",
                text: keyOn ? "Сейчас друзья не зайдут: проверь интернет на этом ПК" : "Сейчас друзья не зайдут: включи «Без белого IP»",
              };
  return { summary: whole, p2p, direct, nets: netList, restartForNet };
}

const PORT_KEYS = ["api_port", "rtc_udp_port", "rtc_tcp_port", "livekit_port"] as const;

/** What is wrong with the config as typed, in words; none when it can be saved. */
export function configProblem(config: HostConfig): string | null {
  const ports = PORT_KEYS.map((key) => config[key]);
  if (ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== ports.length) {
    return "Порты — разные числа от 1024 до 65535";
  }
  const ip = config.external_ip?.trim();
  if (ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.includes(":")) return "Внешний IP — четыре числа через точку, например 203.0.113.7";
  return null;
}

/** Whether two configs say the same: what decides if there is anything to apply. */
export function sameConfig(a: HostConfig, b: HostConfig): boolean {
  return (
    a.name === b.name &&
    a.upnp === b.upnp &&
    p2pOn(a) === p2pOn(b) &&
    PORT_KEYS.every((key) => a[key] === b[key]) &&
    (a.external_ip?.trim() || null) === (b.external_ip?.trim() || null)
  );
}

/** A server's start failed on a port someone else holds: the owner gets the port fields to pick others. */
export function portTrouble(error: string): boolean {
  return /порт|port|address already in use|занят/i.test(error);
}
