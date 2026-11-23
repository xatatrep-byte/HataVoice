// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useServers, type SavedServer } from "../../state/servers";
import { inviteAction } from "./useClipboardInvite";

const home: SavedServer = { address: "203.0.113.7:7350", name: "Хата", color: "blue", serverKey: "KEY" };
const found = (address: string, server_key: string) => ({ link: `hatavoice://${address}/#v=1&sk=${server_key}&inv=x`, address, server_key });

describe("an invite in the clipboard", () => {
  it("offers a server we are not on, in one click", () => {
    const invite = found("198.51.100.1:7350", "OTHER");
    expect(inviteAction(invite, [home])).toEqual({ kind: "offer", link: invite.link });
  });

  it("says nothing about our own server's link, as its owner has just copied it to send", () => {
    expect(inviteAction(found(home.address, "KEY"), [home])).toEqual({ kind: "nothing" });
  });

  it("moves a server we are on to its new address, which its pinned key makes safe", () => {
    expect(inviteAction(found("198.51.100.9:7350", "KEY"), [home])).toEqual({ kind: "move", from: home.address, to: "198.51.100.9:7350" });
  });

  it("does not take a saved address for another key", () => {
    expect(inviteAction(found(home.address, "OTHER"), [home])).toEqual({ kind: "nothing" });
  });
});

describe("a server moved", () => {
  it("keeps its place, name and selection", () => {
    const other = { address: "10.0.0.2:7350", name: "Друг", color: "green" } as SavedServer;
    useServers.setState({ servers: [home, other], selected: home.address });
    useServers.getState().move(home.address, "198.51.100.9:7350");
    const { servers, selected } = useServers.getState();
    expect(servers.map((s) => s.address)).toEqual(["198.51.100.9:7350", other.address]);
    expect(servers[0]).toMatchObject({ name: "Хата", serverKey: "KEY" });
    expect(selected).toBe("198.51.100.9:7350");
  });
});
