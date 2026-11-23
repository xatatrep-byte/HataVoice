import { describe, expect, it, vi } from "vitest";
import { makeRelay } from "./relay";

function setup(invoke: (cmd: string, args?: unknown) => Promise<unknown> = async () => "done") {
  const sent: (string | ArrayBuffer)[] = [];
  const callbacks = new Map<number, (payload: unknown) => void>();
  let next = 100;
  const internals = {
    invoke: vi.fn(invoke),
    transformCallback: (callback: (payload: unknown) => void) => {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => void callbacks.delete(id),
  };
  const relay = makeRelay(internals, { send: (data) => void sent.push(data) });
  const settled = () => new Promise((resolve) => setTimeout(resolve));
  return { relay, internals, sent, callbacks, settled };
}

describe("the relay", () => {
  it("makes the call and answers with its id", async () => {
    const { relay, internals, sent, settled } = setup();
    relay.onMessage(JSON.stringify({ id: 7, cmd: "server_state", args: { address: "a:1" } }));
    await settled();
    expect(internals.invoke).toHaveBeenCalledWith("server_state", { address: "a:1" }, undefined);
    expect(JSON.parse(sent[0] as string)).toEqual({ id: 7, ok: "done" });
  });

  it("passes a refusal on", async () => {
    const { relay, sent, settled } = setup(() => Promise.reject("Нельзя"));
    relay.onMessage(JSON.stringify({ id: 8, cmd: "x" }));
    await settled();
    expect(JSON.parse(sent[0] as string)).toEqual({ id: 8, err: "Нельзя" });
  });

  it("takes bytes in the frame after the question, and answers with bytes the same way", async () => {
    const answer = new ArrayBuffer(3);
    const { relay, internals, sent, settled } = setup(async () => answer);
    const bytes = new ArrayBuffer(5);
    relay.onMessage(JSON.stringify({ id: 9, cmd: "stream_feed", binary: true, options: { headers: { service: "a" } } }));
    relay.onMessage(bytes);
    await settled();
    expect(internals.invoke).toHaveBeenCalledWith("stream_feed", bytes, { headers: { service: "a" } });
    expect(JSON.parse(sent[0] as string)).toEqual({ id: 9, binary: true });
    expect(sent[1]).toBe(answer);
  });

  it("listens for the page, and stops when the page is gone", async () => {
    const { relay, internals, sent, callbacks, settled } = setup(async () => 55);
    relay.onMessage(JSON.stringify({ id: 1, cmd: "plugin:event|listen", args: { event: "chat-message", target: { kind: "Any" }, handler: 42 } }));
    await settled();
    expect(JSON.parse(sent[0] as string)).toEqual({ id: 1, ok: 55 });

    callbacks.get(100)!({ payload: "hi" });
    expect(JSON.parse(sent[1] as string)).toEqual({ fire: 42, payload: { payload: "hi" } });

    relay.onMessage(JSON.stringify({ pageGone: true }));
    await settled();
    expect(internals.invoke).toHaveBeenCalledWith("plugin:event|unlisten", { event: "chat-message", eventId: 55 });
    expect(callbacks.size).toBe(0);
  });
});
