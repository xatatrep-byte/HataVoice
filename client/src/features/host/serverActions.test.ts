import { describe, expect, it } from "vitest";
import { serverActions } from "./serverActions";

const owner = { is_owner: true };
const member = { is_owner: false };

describe("serverActions", () => {
  it("the server of this PC is deleted, also while it is off and its state does not load", () => {
    expect(serverActions("127.0.0.1:7350", "127.0.0.1:7350", owner)).toEqual({ leave: false, remove: "delete" });
    expect(serverActions("127.0.0.1:7350", "127.0.0.1:7350", null)).toEqual({ leave: false, remove: "delete" });
  });

  it("a server that does not answer at all can always be taken off the list (its own internet address from inside)", () => {
    expect(serverActions("203.0.113.7:7350", "127.0.0.1:7350", null)).toEqual({ leave: false, remove: "forget" });
    expect(serverActions("5.6.7.8:7350", null, null)).toEqual({ leave: false, remove: "forget" });
  });

  it("a member leaves; the owner of a server elsewhere takes it off the list", () => {
    expect(serverActions("5.6.7.8:7350", null, member)).toEqual({ leave: true, remove: null });
    expect(serverActions("5.6.7.8:7350", "127.0.0.1:7350", owner)).toEqual({ leave: false, remove: "forget" });
  });

  it("offers neither deleting nor forgetting until it is known which server is this PC's", () => {
    expect(serverActions("127.0.0.1:7350", undefined, owner).remove).toBeNull();
  });
});
