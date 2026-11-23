import { describe, expect, it } from "vitest";
import { DEFAULT_HOST_CONFIG, type HostConfig, type HostStatus, type HostView } from "../../host/types";
import { configProblem, entryState, portTrouble, sameConfig } from "./entryState";

const ports = (open: boolean) => [
  { protocol: "tcp" as const, port: 7350, open, error: null },
  { protocol: "tcp" as const, port: 7881, open, error: null },
  { protocol: "udp" as const, port: 7882, open, error: null },
];

function status(network: Partial<HostStatus["network"]> = {}, rest: Partial<HostStatus> = {}): HostStatus {
  return {
    name: "Хата",
    livekit: { state: "running" },
    network: {
      upnp: { state: "done" },
      ports: ports(true),
      router_ip: "203.0.113.7",
      router_ip_kind: "public",
      public_ip: "203.0.113.7",
      local_ip: "192.168.0.132",
      ...network,
    },
    share_address: "203.0.113.7:7350",
    p2p_address: "abcdef0123456789.p2p",
    lan_address: "192.168.0.132:7350",
    virtual_addresses: [],
    virtual_addresses_now: [],
    ...rest,
  };
}

const config: HostConfig = { ...DEFAULT_HOST_CONFIG, p2p: true };
const view = (over: Partial<HostView> = {}): HostView => ({ config, running: true, crash: null, status: status(), ...over });

describe("entryState", () => {
  it("a white IP with open ports and the key: both ways work", () => {
    const state = entryState(view());
    expect(state.p2p.tone).toBe("ok");
    expect(state.direct.tone).toBe("ok");
    expect(state.summary).toEqual({ tone: "ok", text: "Друзья заходят напрямую по белому IP, а у кого не выйдет — по ключу сервера" });
  });

  it("a grey IP is no trouble while the key works", () => {
    const state = entryState(view({ status: status({ router_ip_kind: "cgnat", ports: ports(false) }, { share_address: null }) }));
    expect(state.direct.tone).toBe("off");
    expect(state.direct.text).toContain("серый IP");
    expect(state.direct.text).toContain("заходят по ключу");
    expect(state.summary.text).toBe("Друзья заходят по ключу сервера — белый IP не нужен");
  });

  it("a grey IP with the key off: nobody gets in, and it says what to switch on", () => {
    const off = { ...config, p2p: false };
    const state = entryState(view({ config: off, status: status({ router_ip_kind: "cgnat" }, { share_address: null, p2p_address: null }) }));
    expect(state.p2p).toEqual({ tone: "off", text: "Выключено" });
    expect(state.direct.tone).toBe("error");
    expect(state.direct.text).toContain("включи «Без белого IP»");
    expect(state.summary).toEqual({ tone: "error", text: "Сейчас друзья не зайдут: включи «Без белого IP»" });
  });

  it("the key on but not answering is a warning", () => {
    const state = entryState(view({ status: status({}, { p2p_address: null }) }));
    expect(state.p2p.tone).toBe("warn");
    expect(state.summary.text).toBe("Друзья заходят напрямую по белому IP");
  });

  it("closed ports say why: UPnP off, the router refusing, or only some opened", () => {
    const noKey = { p2p_address: null };
    expect(entryState(view({ status: status({ upnp: { state: "disabled" }, ports: ports(false) }, noKey) })).direct.text).toContain("включи «Открывать порты");
    expect(entryState(view({ status: status({ upnp: { state: "unavailable" }, ports: ports(false) }, noKey) })).direct.text).toContain("открой их вручную");
    const some = [...ports(true).slice(0, 2), { protocol: "udp" as const, port: 7882, open: false, error: null }];
    expect(entryState(view({ status: status({ ports: some }, noKey) })).direct.text).toContain("не все порты");
    expect(entryState(view({ status: status({ upnp: { state: "searching" }, ports: ports(false) }, noKey) })).direct.tone).toBe("wait");
  });

  it("a server that is off or starting says so for the whole and for each way", () => {
    const off = entryState(view({ running: false, status: null }));
    expect(off.summary.tone).toBe("off");
    expect(off.p2p.tone).toBe("off");
    expect(entryState(view({ status: null })).summary).toEqual({ tone: "wait", text: "Сервер запускается…" });
    expect(entryState(view({ running: false, status: null, crash: "boom" })).summary.tone).toBe("error");
  });

  it("Radmin VPN: missing, there, or joined after the start (restart)", () => {
    const missing = entryState(view());
    expect(missing.nets.map((n) => n.label)).toEqual(["Radmin VPN", "ZeroTier"]);
    expect(missing.nets[0]!.status.text).toContain("Не установлен");
    expect(missing.restartForNet).toBe(false);
    const radmin = { kind: "radmin" as const, address: "26.1.2.3:7350" };
    const there = entryState(view({ status: status({}, { virtual_addresses: [radmin], virtual_addresses_now: [radmin] }) }));
    expect(there.nets[0]!.status.tone).toBe("ok");
    const late = entryState(view({ status: status({}, { virtual_addresses_now: [radmin] }) }));
    expect(late.nets[0]!.status.text).toContain("перезапусти");
    expect(late.restartForNet).toBe(true);
  });

  it("only a fallback network left: the whole says so", () => {
    const radmin = { kind: "radmin" as const, address: "26.1.2.3:7350" };
    const state = entryState(
      view({ status: status({ router_ip_kind: "cgnat" }, { share_address: null, p2p_address: null, virtual_addresses: [radmin], virtual_addresses_now: [radmin] }) }),
    );
    expect(state.summary).toEqual({ tone: "warn", text: "Из интернета сейчас не зайти — только через Radmin VPN" });
  });
});

describe("configProblem", () => {
  it("ports must differ and be from 1024 to 65535", () => {
    expect(configProblem(config)).toBeNull();
    expect(configProblem({ ...config, api_port: 80 })).toMatch(/Порты/);
    expect(configProblem({ ...config, rtc_udp_port: config.api_port })).toMatch(/Порты/);
    expect(configProblem({ ...config, livekit_port: Number.NaN })).toMatch(/Порты/);
  });

  it("an external IP is four numbers, or left empty", () => {
    expect(configProblem({ ...config, external_ip: "203.0.113.7" })).toBeNull();
    expect(configProblem({ ...config, external_ip: "  " })).toBeNull();
    expect(configProblem({ ...config, external_ip: "мой айпи" })).toMatch(/Внешний IP/);
  });
});

describe("sameConfig", () => {
  it("an old config without the P2P switch is the same as one with it on", () => {
    const old: HostConfig = { ...DEFAULT_HOST_CONFIG };
    delete old.p2p;
    expect(sameConfig(old, { ...old, p2p: true })).toBe(true);
    expect(sameConfig(old, { ...old, p2p: false })).toBe(false);
    expect(sameConfig(old, { ...old, external_ip: " " })).toBe(true);
    expect(sameConfig(old, { ...old, rtc_udp_port: 7900 })).toBe(false);
  });
});

it("a busy port is told apart from other start errors", () => {
  expect(portTrouble("Сервер не запустился: Порт 7350 занят или недоступен")).toBe(true);
  expect(portTrouble("LiveKit не запустился: listen udp 0.0.0.0:7882: bind: address already in use")).toBe(true);
  expect(portTrouble("Сервер запускается слишком долго")).toBe(false);
});
