import { describe, expect, it, vi } from "vitest";
import { AndroidBridge } from "../platform/android";
import { i420Layout, KIND_PICTURE, KIND_SOUND, PACKET_HEADER, readPacket } from "./androidCapture";

function packet(kind: number, a: number, b: number, c: number, body: number): ArrayBuffer {
  const buffer = new ArrayBuffer(PACKET_HEADER + body);
  const view = new DataView(buffer);
  view.setUint32(0, kind, true);
  view.setUint32(4, a, true);
  view.setUint32(8, b, true);
  view.setUint32(12, c, true);
  return buffer;
}

describe("packets of the phone's screen", () => {
  it("reads a picture as three planes of I420", () => {
    const read = readPacket(packet(KIND_PICTURE, 4, 2, 0, 12));
    expect(read).toMatchObject({ kind: KIND_PICTURE, width: 4, height: 2 });
    expect(read?.data.byteLength).toBe(12);
    expect(i420Layout(4, 2)).toEqual([
      { offset: 0, stride: 4 },
      { offset: 8, stride: 2 },
      { offset: 10, stride: 2 },
    ]);
  });

  it("refuses a picture whose size does not match its bytes, or an odd one", () => {
    expect(readPacket(packet(KIND_PICTURE, 4, 2, 0, 11))).toBeNull();
    expect(readPacket(packet(KIND_PICTURE, 4, 2, 0, 13))).toBeNull();
    expect(readPacket(packet(KIND_PICTURE, 3, 2, 0, 9))).toBeNull();
    expect(readPacket(packet(KIND_PICTURE, 0, 0, 0, 0))).toBeNull();
    expect(readPacket(packet(KIND_PICTURE, 10_000, 2, 0, 30_000))).toBeNull();
  });

  it("reads sound as interleaved floats, a copy of its own", () => {
    const buffer = packet(KIND_SOUND, 2, 48_000, 2, 16);
    new Float32Array(buffer, PACKET_HEADER).set([0.5, -0.5, 0.25, -0.25]);
    const read = readPacket(buffer);
    expect(read).toMatchObject({ kind: KIND_SOUND, frames: 2, rate: 48_000, channels: 2 });
    expect(Array.from(read!.data as Float32Array)).toEqual([0.5, -0.5, 0.25, -0.25]);
    expect((read!.data as Float32Array).buffer).not.toBe(buffer);
  });

  it("refuses sound of a strange shape and anything else", () => {
    expect(readPacket(packet(KIND_SOUND, 2, 48_000, 2, 15))).toBeNull();
    expect(readPacket(packet(KIND_SOUND, 0, 48_000, 2, 0))).toBeNull();
    expect(readPacket(packet(KIND_SOUND, 2, 48_000, 6, 48))).toBeNull();
    expect(readPacket(packet(7, 2, 2, 0, 6))).toBeNull();
    expect(readPacket(new ArrayBuffer(8))).toBeNull();
  });
});

describe("the bridge to Android", () => {
  function fake() {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const sent: string[] = [];
    const native = {
      postMessage: (m: string) => sent.push(m),
      addEventListener: (_: "message", f: (event: MessageEvent) => void) => listeners.push(f),
      removeEventListener: () => {},
    };
    const deliver = (data: unknown) => listeners.forEach((f) => f({ data } as MessageEvent));
    return { native, sent, deliver };
  }

  it("says hello and learns what the phone can do", () => {
    const { native, sent, deliver } = fake();
    const bridge = new AndroidBridge(native);
    expect(JSON.parse(sent[0]!)).toEqual({ op: "hello" });
    deliver(JSON.stringify({ ev: "hello", sdk: 34, features: { screen: true, screenAudio: true, pip: true, binary: true } }));
    expect(bridge.features?.screenAudio).toBe(true);
  });

  it("hands words and bytes to their listeners, base64 bytes too, and ignores junk", () => {
    const { native, deliver } = fake();
    const bridge = new AndroidBridge(native);
    const words = vi.fn();
    const bytes = vi.fn();
    bridge.on(words);
    bridge.onBytes(bytes);
    deliver(JSON.stringify({ ev: "pip", on: true }));
    deliver(new ArrayBuffer(4));
    deliver(JSON.stringify({ ev: "bin", b64: btoa("\x01\x02") }));
    deliver("not json");
    deliver(JSON.stringify({ no: "ev" }));
    deliver(42);
    expect(words).toHaveBeenCalledTimes(1);
    expect(words.mock.calls[0]![0]).toEqual({ ev: "pip", on: true });
    expect(bytes).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(bytes.mock.calls[1]![0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
  });

  it("waits for the word asked for, or gives up", async () => {
    vi.useFakeTimers();
    const { native, deliver } = fake();
    const bridge = new AndroidBridge(native);
    const answer = bridge.next((w) => w.ev === "screen" && w.state !== "off", 1000);
    deliver(JSON.stringify({ ev: "screen", state: "off" }));
    deliver(JSON.stringify({ ev: "screen", state: "on", width: 576, height: 1280 }));
    await expect(answer).resolves.toMatchObject({ state: "on", width: 576 });
    const none = bridge.next((w) => w.ev === "never", 1000);
    vi.advanceTimersByTime(1001);
    await expect(none).resolves.toBeNull();
    vi.useRealTimers();
  });
});
