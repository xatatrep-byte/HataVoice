import { describe, expect, it } from "vitest";
import { friendMessage, GUIDE_WAYS, guideFor, type GuideFacts } from "./guideSteps";

const facts: GuideFacts = { radmin: "26.10.20.30:7350", zerotier: null, publicAddress: null, publicWorks: false, ports: "TCP 7350, TCP 7881, UDP 7882", p2p: null };
const all = (steps: { title: string; text: string; check?: string }[]) => steps.map((s) => `${s.title} ${s.text} ${s.check ?? ""}`).join(" ");

describe("the guide to bring friends in", () => {
  it("has steps for the owner and for the friend in every way", () => {
    for (const way of GUIDE_WAYS) {
      const guide = guideFor(way, facts);
      expect(guide.host.length, way).toBeGreaterThan(1);
      expect(guide.friend.length, way).toBeGreaterThan(1);
    }
  });

  it("names the app's own buttons as they are written", () => {
    const radmin = all(guideFor("radmin", facts).host);
    for (const label of ["«Настройки сервера»", "вкладка «Приглашения»", "«Адрес для друзей»", "«Создать ссылку»", "«Копировать»", "«Скопировать инструкцию для друга»"]) {
      expect(radmin, label).toContain(label);
    }
    const friend = all(guideFor("link", facts).friend);
    for (const label of ["«Как тебя зовут?»", "«Подключиться к другу»", "«Ссылка-приглашение или адрес»", "«Подключиться»", "«Войти»"]) {
      expect(friend, label).toContain(label);
    }
    expect(all(guideFor("link", facts).host)).toContain("«Позвать друга»");
  });

  it("names this PC's own address in the network it is already in, and says to restart when it does not see one", () => {
    expect(all(guideFor("radmin", facts).host)).toContain("26.10.20.30:7350");
    expect(all(guideFor("zerotier", facts).host)).toContain("«Выключить», потом «Включить»");
    expect(all(guideFor("public", facts).host)).toContain("UDP 7882");
  });

  it("says how the way with nothing to set up works, and how to turn it on if it is off", () => {
    const off = guideFor("link", { ...facts, running: true });
    expect(off.when).toContain("пробивают связь через роутеры");
    expect(off.when).toContain("зашифрованный");
    // The switch is in «Как друзья заходят»; a running server restarts by itself.
    expect(off.host[1]!.text).toMatch(/^Ниже, в блоке «Как друзья заходят», включи переключатель «Без белого IP — по ключу сервера» и нажми «Применить» — сервер перезапустится сам\.$/);
    const on = guideFor("link", { ...facts, p2p: "8f3a2b1c9d0e4f5a6b7c8d9e0f1a2b3c.p2p" });
    expect(on.host[1]!.text).toContain("8f3a2b1c9d0e….p2p");
  });

  it("tells a grey IP from a white one when the server knows, and how to forward ports to this PC", () => {
    expect(guideFor("public", { ...facts, ipKind: "cgnat" }).host[0]!.title).toContain("серый IP");
    expect(guideFor("public", { ...facts, ipKind: "public", publicIp: "203.0.113.7" }).host[0]!.text).toContain("203.0.113.7");
    expect(guideFor("public", facts).host[0]!.text).toContain("2ip.ru");
    expect(all(guideFor("public", { ...facts, localIp: "192.168.1.40" }).host)).toContain("192.168.1.40");
  });

  it("says plainly where the Radmin VPN line is and why it is not there yet", () => {
    const none = { ...facts, radmin: null };
    const steps = guideFor("radmin", none).host;
    expect(steps[0]!.title).toBe("Поставь и включи Radmin VPN на этом ПК");
    expect(steps[0]!.text).toContain("Сейчас ХатаВойс не видит Radmin VPN на этом ПК");
    expect(all(steps)).toContain("«Radmin VPN — не найден на этом ПК»");
    expect(all(steps), "the address field is a list that opens").toContain("Нажми на это поле — раскроется список");
    // On, but after the server started: only a restart is left.
    const later = guideFor("radmin", { ...none, radminNow: true }).host;
    expect(later[0]!.title).toBe("Radmin VPN на этом ПК уже включён");
    expect(later[2]!.title).toBe("Перезапусти сервер ХатаВойс");
    expect(later[2]!.text).toContain("когда сервер уже работал");
    // Seen: no restart at all.
    expect(guideFor("radmin", facts).host[2]!.title).toBe("Сервер уже видит Radmin VPN");
  });

  it("tells the owner with a working public IP that Radmin VPN and ZeroTier are not needed", () => {
    const white = { ...facts, radmin: null, publicWorks: true, publicAddress: "203.0.113.7:7350" };
    expect(guideFor("radmin", white).when).toMatch(/^Тебе Radmin VPN не нужен: у тебя белый IP и порты открыты/);
    expect(guideFor("zerotier", white).when).toMatch(/^Тебе ZeroTier не нужен/);
    expect(guideFor("radmin", facts).when).not.toContain("не нужен");
  });

  it("warns that ZeroTier's free plan holds ten devices", () => {
    expect(guideFor("zerotier", facts).when).toContain("до 10 устройств");
  });

  it("gives the friend one message to send, with room for the network's name, password and the link", () => {
    const text = friendMessage("radmin", facts);
    expect(text).toMatch(/^Как зайти на мой сервер ХатаВойс \(Radmin VPN\)/);
    expect(text).toContain("1. Поставь и включи Radmin VPN");
    expect(text).toContain("Должно получиться:");
    expect(text).toContain("Пароль: ");
    expect(text.trimEnd()).toMatch(/Ссылка-приглашение:$/);
    expect(text).not.toContain("брандмауэр");
  });
});
