import { describe, expect, it } from "vitest";
import { describeHost } from "./describe";
import { DEFAULT_HOST_CONFIG, type HostStatus, type HostView } from "./types";

const ports = (open: boolean) => [
  { protocol: "tcp" as const, port: 7350, open, error: null },
  { protocol: "tcp" as const, port: 7881, open, error: null },
  { protocol: "udp" as const, port: 7882, open, error: null },
];

function status(over: Partial<HostStatus["network"]> = {}, rest: Partial<HostStatus> = {}): HostStatus {
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
      ...over,
    },
    share_address: "203.0.113.7:7350",
    lan_address: "192.168.0.132:7350",
    ...rest,
  };
}

const view = (over: Partial<HostView>): HostView => ({
  config: DEFAULT_HOST_CONFIG,
  running: true,
  crash: null,
  status: status(),
  ...over,
});

const texts = (v: HostView) => describeHost(v).notes.map((n) => `${n.level}: ${n.text}`);

describe("describeHost", () => {
  it("knows when no server has been created yet", () => {
    expect(describeHost(view({ config: null, running: false, status: null })).phase).toBe("none");
  });

  it("stopped vs crashed", () => {
    expect(describeHost(view({ running: false, status: null })).phase).toBe("stopped");
    const crashed = describeHost(view({ running: false, status: null, crash: "Порт 7350 занят" }));
    expect(crashed.phase).toBe("failed");
    expect(crashed.notes[0]).toEqual({ level: "error", text: "Сервер остановился: Порт 7350 занят" });
  });

  it("is starting until the status answers and LiveKit is up", () => {
    expect(describeHost(view({ status: null })).phase).toBe("starting");
    expect(describeHost(view({ status: status({}, { livekit: { state: "restarting", detail: "x" } }) })).phase).toBe(
      "starting",
    );
  });

  it("reports a LiveKit failure", () => {
    const summary = describeHost(view({ status: status({}, { livekit: { state: "failed", detail: "нет файла" } }) }));
    expect(summary.phase).toBe("failed");
    expect(summary.notes).toContainEqual({ level: "error", text: "LiveKit не запустился: нет файла" });
  });

  it("all good: ports open, public address to share", () => {
    const summary = describeHost(view({}));
    expect(summary.phase).toBe("running");
    expect(summary.shareAddress).toBe("203.0.113.7:7350");
    expect(summary.lanAddress).toBe("192.168.0.132:7350");
    expect(texts(view({}))).toEqual(["ok: Порты открыты на роутере"]);
  });

  it("without UPnP tells exactly which ports to forward and where", () => {
    const v = view({ status: status({ upnp: { state: "disabled" }, ports: ports(false), public_ip: null }) });
    expect(texts(v)).toEqual([
      "warn: UPnP выключен. Открой на роутере порты TCP 7350, TCP 7881, UDP 7882 на адрес 192.168.0.132",
      "warn: Внешний IP неизвестен: укажи его в настройках сервера, иначе друзья из интернета не подключатся",
    ]);
  });

  it("when the router refuses UPnP shows the reason and the manual fallback", () => {
    const v = view({ status: status({ upnp: { state: "unavailable", detail: "Роутер не ответил" }, ports: ports(false) }) });
    expect(texts(v)[0]).toBe(
      "warn: Роутер не ответил. Открой на роутере порты TCP 7350, TCP 7881, UDP 7882 на адрес 192.168.0.132 вручную",
    );
  });

  it("lists ports the router did not open", () => {
    const mixed = [
      { protocol: "tcp" as const, port: 7350, open: true, error: null },
      { protocol: "tcp" as const, port: 7881, open: false, error: "ConflictInMappingEntry" },
      { protocol: "udp" as const, port: 7882, open: true, error: null },
    ];
    expect(texts(view({ status: status({ ports: mixed }) }))).toEqual([
      "warn: Роутер не открыл: TCP 7881 (ConflictInMappingEntry). Открой вручную",
    ]);
  });

  it("with a tunnel the router does not matter", () => {
    const cgnat = view({ status: { ...status({ router_ip: "100.70.1.2", router_ip_kind: "cgnat", public_ip: null }), p2p_address: "a.p2p" } });
    expect(texts(cgnat)).toEqual(["ok: Друзья подключатся откуда угодно: порты открывать не нужно, ссылка сама найдёт путь"]);
    expect(describeHost(cgnat).p2pAddress).toBe("a.p2p");
    expect(describeHost(cgnat).publicWorks).toBe(false);
  });

  it("explains CGNAT and double NAT as blockers", () => {
    const cgnat = view({ status: status({ router_ip: "100.70.1.2", router_ip_kind: "cgnat", public_ip: null }) });
    expect(texts(cgnat)).toContain(
      "error: У провайдера серый IP (CGNAT): из интернета к этому ПК не подключиться. Нужен белый IP или общая сеть с друзьями (Radmin VPN, ZeroTier)",
    );
    expect(texts(cgnat).some((t) => t.includes("Внешний IP неизвестен"))).toBe(false);

    const doubleNat = view({ status: status({ router_ip: "192.168.1.5", router_ip_kind: "private", public_ip: null }) });
    expect(texts(doubleNat)).toContain(
      "error: Роутер сам стоит за другим роутером (адрес 192.168.1.5): порты нужно открыть и на верхнем",
    );
  });

  it("lists addresses in Radmin VPN and ZeroTier for friends in those networks", () => {
    const v = view({
      status: status(
        {},
        {
          virtual_addresses: [
            { kind: "radmin", address: "26.10.20.30:7350" },
            { kind: "zerotier", address: "10.147.17.3:7350" },
          ],
        },
      ),
    });
    expect(describeHost(v).virtualAddresses).toEqual([
      { label: "Radmin VPN", address: "26.10.20.30:7350" },
      { label: "ZeroTier", address: "10.147.17.3:7350" },
    ]);
  });

  it("lists no virtual networks for a server that does not report them", () => {
    expect(describeHost(view({})).virtualAddresses).toEqual([]);
  });

  it("with a grey IP and Radmin VPN, points friends to the Radmin address instead", () => {
    const v = view({
      status: status(
        { router_ip: "100.70.1.2", router_ip_kind: "cgnat", public_ip: null },
        { share_address: null, virtual_addresses: [{ kind: "radmin", address: "26.10.20.30:7350" }] },
      ),
    });
    expect(texts(v)).toContain(
      "warn: У провайдера серый IP (CGNAT): из интернета напрямую не подключиться, но друзья в Radmin VPN подключатся по адресу ниже",
    );
  });
});
