import { describe, expect, it, vi } from "vitest";
import { OwnAudioTrack, readAudioSlot, readSlot, SLOT_HEADER, type HostView } from "./ownCapture";

/** A buffer of `slots` slots for 4×2 NV12 pictures, slot `n` holding seq `seq`. */
function ring(slots: number, fill: (slot: number) => { seq: number; width?: number; height?: number; stride?: number }) {
  const slotSize = SLOT_HEADER + (4 * 2 * 3) / 2;
  const buffer = new ArrayBuffer(slotSize * slots);
  for (let n = 0; n < slots; n++) {
    const { seq, width = 4, height = 2, stride = 4 } = fill(n);
    new Uint32Array(buffer, n * slotSize, 4).set([seq, width, height, stride]);
  }
  return { buffer, info: { slotSize, slots } };
}

describe("readSlot", () => {
  it("takes the named slot's NV12 picture: the Y plane, then the colour plane right after it", () => {
    const { buffer, info } = ring(3, (n) => ({ seq: n === 1 ? 8 : 2 }));
    const make = vi.fn(() => ({ close: vi.fn() }));
    expect(readSlot(buffer, info, { hv: "frame", slot: 1, seq: 8 }, 5, make)).not.toBeNull();
    const [data, init] = make.mock.calls[0] as unknown as [Uint8Array, Record<string, unknown>];
    expect(data.byteOffset).toBe(info.slotSize + SLOT_HEADER);
    expect(data.byteLength).toBe(12);
    expect(init).toMatchObject({ format: "NV12", codedWidth: 4, codedHeight: 2, timestamp: 5, layout: [{ offset: 0, stride: 4 }, { offset: 8, stride: 4 }] });
    expect(init.colorSpace, "what the video card makes: BT.709, studio range").toEqual({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false });
  });

  it("drops a slot being written or already written over", () => {
    const make = vi.fn(() => ({ close: vi.fn() }));
    const writing = ring(3, () => ({ seq: 9 }));
    expect(readSlot(writing.buffer, writing.info, { hv: "frame", slot: 0, seq: 9 }, 0, make), "odd: half written").toBeNull();
    const newer = ring(3, () => ({ seq: 10 }));
    expect(readSlot(newer.buffer, newer.info, { hv: "frame", slot: 0, seq: 8 }, 0, make), "the next frame is there").toBeNull();
    expect(make).not.toHaveBeenCalled();
  });

  it("closes a frame whose slot changed while it was copied", () => {
    const { buffer, info } = ring(3, () => ({ seq: 4 }));
    const close = vi.fn();
    const make = vi.fn(() => {
      new Uint32Array(buffer, 0, 1)[0] = 5;
      return { close };
    });
    expect(readSlot(buffer, info, { hv: "frame", slot: 0, seq: 4 }, 0, make)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("trusts no slot number or size that would read outside the slot", () => {
    const make = vi.fn(() => ({ close: vi.fn() }));
    const { buffer, info } = ring(3, () => ({ seq: 2 }));
    expect(readSlot(buffer, info, { hv: "frame", slot: 3, seq: 2 }, 0, make)).toBeNull();
    expect(readSlot(buffer, info, { hv: "frame", slot: -1, seq: 2 }, 0, make)).toBeNull();
    const tall = ring(1, () => ({ seq: 2, height: 8 }));
    expect(readSlot(tall.buffer, tall.info, { hv: "frame", slot: 0, seq: 2 }, 0, make)).toBeNull();
    const narrow = ring(1, () => ({ seq: 2, stride: 2 }));
    expect(readSlot(narrow.buffer, narrow.info, { hv: "frame", slot: 0, seq: 2 }, 0, make)).toBeNull();
    const odd = ring(1, () => ({ seq: 2, width: 3, stride: 4 }));
    expect(readSlot(odd.buffer, odd.info, { hv: "frame", slot: 0, seq: 2 }, 0, make), "NV12 needs even sides").toBeNull();
    expect(make).not.toHaveBeenCalled();
  });
});

describe("readAudioSlot", () => {
  const info = { slotSize: 16 + 4 * 2 * 4, slots: 2, rate: 48_000, channels: 2 };
  const ring = (seq: number, frames: number) => {
    const buffer = new ArrayBuffer(info.slotSize * info.slots);
    new Uint32Array(buffer, info.slotSize, 2).set([seq, frames]);
    const room = Math.min(frames, 4);
    new Float32Array(buffer, info.slotSize + 16, room * 2).set(Array.from({ length: room * 2 }, (_, i) => i / 10));
    return buffer;
  };

  it("takes a copy of the named slot's interleaved stereo floats", () => {
    const make = vi.fn((init: { data: Float32Array }) => ({ close: vi.fn(), init }));
    const buffer = ring(6, 3);
    expect(readAudioSlot(buffer, info, { hv: "audio", slot: 1, seq: 6 }, 7, make)).not.toBeNull();
    const init = make.mock.calls[0]![0] as unknown as Record<string, unknown> & { data: Float32Array };
    expect(init).toMatchObject({ format: "f32", sampleRate: 48_000, numberOfFrames: 3, numberOfChannels: 2, timestamp: 7 });
    expect(Array.from(init.data).map((v) => Math.round(v * 10))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(init.data.buffer, "a copy, not the shared memory").not.toBe(buffer);
  });

  it("plays the sound louder or quieter by a gain, never past full scale", () => {
    const make = vi.fn((init: { data: Float32Array }) => ({ close: vi.fn(), init }));
    readAudioSlot(ring(6, 3), info, { hv: "music", slot: 1, seq: 6 }, 0, make, 0.5);
    readAudioSlot(ring(6, 3), info, { hv: "music", slot: 1, seq: 6 }, 0, make, 4);
    const half = (make.mock.calls[0]![0] as unknown as { data: Float32Array }).data;
    const loud = (make.mock.calls[1]![0] as unknown as { data: Float32Array }).data;
    expect(Array.from(half).map((v) => Math.round(v * 100))).toEqual([0, 5, 10, 15, 20, 25]);
    expect(Array.from(loud).map((v) => Math.round(v * 100)), "clipped at 1").toEqual([0, 40, 80, 100, 100, 100]);
  });

  it("drops a slot written over, half written, or claiming more than it holds", () => {
    const make = vi.fn(() => ({ close: vi.fn() }));
    expect(readAudioSlot(ring(8, 3), info, { hv: "audio", slot: 1, seq: 6 }, 0, make)).toBeNull();
    expect(readAudioSlot(ring(7, 3), info, { hv: "audio", slot: 1, seq: 7 }, 0, make)).toBeNull();
    expect(readAudioSlot(ring(6, 99), info, { hv: "audio", slot: 1, seq: 6 }, 0, make)).toBeNull();
    expect(readAudioSlot(ring(6, 3), info, { hv: "audio", slot: 2, seq: 6 }, 0, make)).toBeNull();
    expect(make).not.toHaveBeenCalled();
  });
});

describe("OwnAudioTrack's lanes", () => {
  it("music takes only its own buffer and messages, not the shared screen's sound", () => {
    const writes: unknown[] = [];
    const g = globalThis as Record<string, unknown>;
    const saved = { gen: g.MediaStreamTrackGenerator, data: g.AudioData };
    g.MediaStreamTrackGenerator = class {
      writable = { getWriter: () => ({ write: async (chunk: unknown) => void writes.push(chunk), close: async () => {} }) };
      stop() {}
    };
    g.AudioData = class {
      constructor(readonly init: unknown) {}
      close() {}
    };
    const listeners = new Map<string, (event: Event) => void>();
    const view = { addEventListener: (type: string, f: (event: Event) => void) => listeners.set(type, f), removeEventListener: () => {} } as unknown as HostView;
    try {
      new OwnAudioTrack(view, "music");
      const info = { slotSize: 16 + 4 * 2 * 4, slots: 2, rate: 48_000, channels: 2 };
      const buffer = new ArrayBuffer(info.slotSize * info.slots);
      new Uint32Array(buffer, 0, 2).set([2, 3]);
      const shared = (hv: string) => ({ additionalData: { hv, ...info }, getBuffer: () => buffer }) as unknown as Event;
      const message = (hv: string) => ({ data: { hv, slot: 0, seq: 2 } }) as unknown as Event;
      listeners.get("sharedbufferreceived")!(shared("audio"));
      listeners.get("message")!(message("audio"));
      expect(writes, "the screen's sound is not music").toHaveLength(0);
      listeners.get("sharedbufferreceived")!(shared("music"));
      listeners.get("message")!(message("audio"));
      expect(writes).toHaveLength(0);
      listeners.get("message")!(message("music"));
      expect(writes).toHaveLength(1);
    } finally {
      g.MediaStreamTrackGenerator = saved.gen;
      g.AudioData = saved.data;
    }
  });
});
