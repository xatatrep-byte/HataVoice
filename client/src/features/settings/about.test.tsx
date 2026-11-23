// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AboutSection } from "./sections";

// The other sections of the file pull in the audio pipeline, which needs a real browser.
vi.mock("../../audio/useMicTest", () => ({ useMicTest: () => ({ level: 0, error: null }) }));
vi.mock("../host/HostCard", () => ({ HostCard: () => null }));
vi.mock("../../audio/useDevices", () => ({ useDevices: () => ({ inputs: [], outputs: [] }) }));
vi.mock("../../audio/useMicLoopback", () => ({ useMicLoopback: () => ({ error: null }) }));

afterEach(cleanup);

describe("AboutSection", () => {
  it("no longer says the server can listen or that the connection has no TLS", () => {
    const { container } = render(<AboutSection />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("может его слышать");
    expect(text).not.toContain("без TLS");
    expect(text).not.toContain("следующем обновлении");
  });

  it("states what is protected and the limits that remain", () => {
    const { container } = render(<AboutSection />);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Голос, экран, чат и файлы");
    expect(text).toContain("Ключей нет ни у сервера, ни у провайдера");
    expect(text).toContain("Подделать их не может никто, даже владелец сервера");
    // Nicknames and games go through the group; channel names the server still sees.
    expect(text).toContain("Идут через зашифрованную группу, сервер их не видит");
    // Who writes, when and how much, and who speaks when, is not hidden.
    expect(text).toContain("Кто зашёл и когда, кто и сколько пишет, кто и когда говорит, названия каналов");
    // There is no traffic disguise: the provider sees that a call goes to the host, and how much, not what.
    expect(text).toContain("Что на адрес сервера идёт звонок и сколько в нём данных");
    // A hacked server can refuse or cut a call, not listen.
    expect(text).toContain("Взломанный сервер может не пустить в звонок или оборвать его, но не подслушает");
    // An infected PC and a recording made by a participant are outside the protection.
    expect(text).toContain("Заражённый ПК участника и запись звонка самим участником");
  });
});
