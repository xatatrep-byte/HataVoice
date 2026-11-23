import { beforeEach, describe, expect, it } from "vitest";
import { parseServers, useServers } from "./servers";

describe("parseServers", () => {
  it("keeps a tunnel, and only a tunnel", () => {
    const [good, bad] = parseServers([
      { address: "a:1", tunnel: "abc.p2p" },
      { address: "b:1", tunnel: "evil.example:7350" },
    ]);
    expect(good?.tunnel).toBe("abc.p2p");
    expect(bad?.tunnel).toBeUndefined();
  });

  it("keeps only entries with an address", () => {
    expect(parseServers([{ address: "1.2.3.4:7350", name: "Хата", color: "teal" }, { address: "" }, 5])).toEqual([
      { address: "1.2.3.4:7350", name: "Хата", color: "teal" },
    ]);
    expect(parseServers("nope")).toEqual([]);
  });

  it("keeps the pinned server key", () => {
    expect(parseServers([{ address: "a:1", name: "A", color: "blue", serverKey: "SK" }, { address: "b:1", serverKey: 5 }])).toEqual([
      { address: "a:1", name: "A", color: "blue", serverKey: "SK" },
      { address: "b:1", name: "b:1", color: "blue" },
    ]);
  });

  it("keeps the ban mark: a date, or null for forever", () => {
    const [dated, forever, garbage] = parseServers([
      { address: "a:1", bannedUntil: 1800000000 },
      { address: "b:1", bannedUntil: null },
      { address: "c:1", bannedUntil: "soon" },
    ]);
    expect(dated!.bannedUntil).toBe(1800000000);
    expect(forever!.bannedUntil).toBeNull();
    expect(garbage).not.toHaveProperty("bannedUntil");
  });

  it("fills a missing name and color", () => {
    expect(parseServers([{ address: "host:1" }])).toEqual([{ address: "host:1", name: "host:1", color: "blue" }]);
  });
});

describe("useServers", () => {
  beforeEach(() => useServers.setState({ servers: [], selected: null }));

  it("selects the first added server and replaces entries with the same address", () => {
    const { add } = useServers.getState();
    add({ address: "a:1", name: "Первый", color: "blue" });
    add({ address: "b:1", name: "Второй", color: "green" });
    add({ address: "a:1", name: "Переименован", color: "pink" });
    const { servers, selected } = useServers.getState();
    expect(servers.map((s) => s.name)).toEqual(["Переименован", "Второй"]);
    expect(selected).toBe("a:1");
  });

  it("updates a saved server in place", () => {
    const { add, update } = useServers.getState();
    add({ address: "a:1", name: "a:1", color: "blue" });
    update("a:1", { serverKey: "SK", name: "Хата" });
    update("zz:1", { name: "nobody" });
    expect(useServers.getState().servers).toEqual([{ address: "a:1", name: "Хата", color: "blue", serverKey: "SK" }]);
  });

  it("moves the selection when the selected server is removed", () => {
    const { add, select, remove } = useServers.getState();
    add({ address: "a:1", name: "A", color: "blue" });
    add({ address: "b:1", name: "B", color: "blue" });
    select("b:1");
    remove("b:1");
    expect(useServers.getState().selected).toBe("a:1");
    remove("a:1");
    expect(useServers.getState().selected).toBeNull();
  });
});
