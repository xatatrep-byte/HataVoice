import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => () => {});
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...args),
  // The shape Tauri gives on Windows, where custom schemes are served from http://<scheme>.localhost.
  convertFileSrc: (path: string, protocol = "asset") => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => listen(event, handler),
}));

import { usePrefs } from "../state/prefs";
import {
  SERVER_TEXT,
  callJoin,
  callLeave,
  callPresence,
  connectServer,
  isInviteLink,
  mediaUrl,
  normalizeAddress,
  onCallKeys,
  onCallState,
  serverErrorText,
  voiceToken,
  type CallKeysEvent,
  type CallStateEvent,
} from "./session";

const hostConfig = { name: "Хата", api_port: 7350 };

beforeEach(() => {
  invoke.mockReset();
  listen.mockClear();
  usePrefs.setState({ nickname: "Петя", color: "pink", frame: "crown", character: null });
});

describe("session", () => {
  it("your own running server without a journal is claimed with its old channels", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "server_open") throw SERVER_TEXT.unclaimed;
      if (command === "host_view") return { config: hostConfig, running: true, crash: null, status: null };
      if (command === "host_claim") return { address: "127.0.0.1:7350", server_key: "SK", backup_suggested: true };
      return null;
    });
    const opened = await connectServer("127.0.0.1:7350");
    expect(invoke).toHaveBeenCalledWith("host_claim", { serverName: "Хата", channels: null });
    expect(invoke).toHaveBeenCalledWith("profile_set", { nickname: "Петя", color: "pink", frame: "crown", character: null });
    expect(opened).toEqual({ serverKey: "SK", name: "Хата", backupSuggested: true });
  });

  it("someone else's unclaimed server is not claimed", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "server_open") throw SERVER_TEXT.unclaimed;
      if (command === "host_view") return { config: hostConfig, running: true, crash: null, status: null };
      return null;
    });
    await expect(connectServer("203.0.113.7:7350")).rejects.toBe(SERVER_TEXT.unclaimed);
    expect(invoke).not.toHaveBeenCalledWith("host_claim", expect.anything());
  });

  it("opens with the pinned key and our profile", async () => {
    invoke.mockResolvedValue({ address: "1.2.3.4:7350", server_key: "SK", name: "Хата" });
    expect(await connectServer("1.2.3.4:7350", "SK")).toEqual({ serverKey: "SK", name: "Хата", backupSuggested: false });
    expect(invoke).toHaveBeenCalledWith("server_open", {
      address: "1.2.3.4:7350",
      serverKey: "SK",
      profile: { nickname: "Петя", color: "pink", frame: "crown", character: null },
    });
  });

  it("sends no profile while there is no nickname", async () => {
    usePrefs.setState({ nickname: "  " });
    invoke.mockResolvedValue({ address: "1.2.3.4:7350", server_key: "SK", name: "Хата" });
    await connectServer("1.2.3.4:7350");
    expect(invoke).toHaveBeenCalledWith("server_open", { address: "1.2.3.4:7350", serverKey: null, profile: null });
  });

  it("tells invite links from addresses", () => {
    expect(isInviteLink("hatavoice://1.2.3.4:7350/#v=1&sk=a&inv=b")).toBe(true);
    expect(isInviteLink("  HataVoice://host:7350/#v=1  ")).toBe(true);
    expect(isInviteLink("1.2.3.4:7350")).toBe(false);
    expect(isInviteLink("http://1.2.3.4:7350")).toBe(false);
  });

  it("passes the Rust side's Russian texts through", () => {
    expect(serverErrorText("Ты забанен на этом сервере")).toBe("Ты забанен на этом сервере");
    expect(serverErrorText(new Error("сломалось"))).toBe("сломалось");
    expect(serverErrorText({ weird: true })).toBe("Что-то пошло не так");
  });
});

describe("addresses and owners", () => {
  it("an address pasted with http:// still works", () => {
    expect(normalizeAddress(" http://1.2.3.4:7350/ ")).toBe("1.2.3.4:7350");
    expect(normalizeAddress("HTTPS://host.example:7350")).toBe("host.example:7350");
    expect(normalizeAddress("26.10.20.30:7350")).toBe("26.10.20.30:7350");
  });

  it("your own server owned by another identity says to import your copy", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "server_open") throw SERVER_TEXT.joinNeeded;
      if (command === "host_view") return { config: { name: "Хата", api_port: 7350 }, running: true, crash: null, status: null };
      return null;
    });
    await expect(connectServer("127.0.0.1:7350")).rejects.toBe(SERVER_TEXT.ownedByOther);
    await expect(connectServer("5.6.7.8:7350")).rejects.toBe(SERVER_TEXT.joinNeeded);
  });
});

describe("media and voice", () => {
  it("media goes through the hvmedia scheme", () => {
    expect(mediaUrl("1.2.3.4:7350", { sha256: "ab", mime: "image/gif", size: 1 })).toBe(
      "http://hvmedia.localhost/1.2.3.4%3A7350%2Fab",
    );
    // A saved address with stray spaces is trimmed the way the Rust handler expects it.
    expect(mediaUrl(" 1.2.3.4:7350 ", { sha256: "ab", mime: "image/gif", size: 1 })).toBe(
      "http://hvmedia.localhost/1.2.3.4%3A7350%2Fab",
    );
  });

  it("voiceToken passes the bridge url through", async () => {
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:5/s/a", token: "jwt" });
    expect(await voiceToken("1.2.3.4:7350", "general")).toEqual({ url: "ws://127.0.0.1:5/s/a", token: "jwt" });
    expect(invoke).toHaveBeenCalledWith("voice_token", { address: "1.2.3.4:7350", channel: "general" });
  });
});

describe("call commands and events", () => {
  it("sends the call commands to the Rust side", async () => {
    invoke.mockResolvedValue(null);
    await callJoin("1.2.3.4:7350", "general");
    await callPresence("1.2.3.4:7350", "general", ["a", "b"]);
    await callLeave();
    expect(invoke).toHaveBeenNthCalledWith(1, "call_join", { address: "1.2.3.4:7350", channel: "general" });
    expect(invoke).toHaveBeenNthCalledWith(2, "call_presence", {
      address: "1.2.3.4:7350",
      channel: "general",
      identities: ["a", "b"],
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "call_leave");
  });

  it("hands the call-keys and call-state payloads to the handlers", async () => {
    const keys: CallKeysEvent[] = [];
    const states: CallStateEvent[] = [];
    await onCallKeys((event) => keys.push(event));
    await onCallState((event) => states.push(event));
    const handlerFor = (name: string) => listen.mock.calls.find(([event]) => event === name)![1];

    const keysEvent: CallKeysEvent = {
      address: "1.2.3.4:7350",
      channel: "general",
      epoch: 3,
      keys: [{ identity: "a", index: 3, key: "AAAA" }],
    };
    const stateEvent: CallStateEvent = {
      address: "1.2.3.4:7350",
      channel: "general",
      state: "secure",
      code: "12345 12345 12345 12345 12345 12345",
      members: ["a", "b"],
      error: null,
    };
    handlerFor("call-keys")({ payload: keysEvent });
    handlerFor("call-state")({ payload: stateEvent });
    expect(keys).toEqual([keysEvent]);
    expect(states).toEqual([stateEvent]);
  });
});
