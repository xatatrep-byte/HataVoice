import { describe, expect, it } from "vitest";
import { OBU, obus, unwrapAv1, wrapAv1 } from "./av1Envelope";

/** One OBU as an encoder writes it: header with the size flag, leb128 size, payload. */
function obu(type: number, payload: number[], extension?: number): number[] {
  const header = (type << 3) | 0x02 | (extension !== undefined ? 0x04 : 0);
  const size: number[] = [];
  let n = payload.length;
  do {
    size.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n >>= 7;
  } while (n > 0);
  return [header, ...(extension !== undefined ? [extension] : []), ...size, ...payload];
}

const big = Array.from({ length: 300 }, (_, i) => i & 0xff);
const keyFrame = new Uint8Array([...obu(OBU.TEMPORAL_DELIMITER, []), ...obu(OBU.SEQUENCE_HEADER, [1, 2, 3, 4]), ...obu(OBU.FRAME, big)]);
const deltaFrame = new Uint8Array([...obu(OBU.TEMPORAL_DELIMITER, []), ...obu(OBU.FRAME, [9, 9, 9], 0x28)]);
const sealed = new Uint8Array(Array.from({ length: 333 }, (_, i) => (i * 7) & 0xff));

describe("the AV1 envelope of an encrypted frame", () => {
  it("reads OBUs as an encoder writes them, sizes over 127 bytes and extensions too", () => {
    expect(obus(keyFrame)?.map((o) => [o.type, o.payload.length])).toEqual([
      [OBU.TEMPORAL_DELIMITER, 0],
      [OBU.SEQUENCE_HEADER, 4],
      [OBU.FRAME, 300],
    ]);
    expect(obus(deltaFrame)?.[1].extension).toBe(0x28);
    expect(obus(new Uint8Array([0x32, 0x05, 1, 2])), "a size past the end").toBeNull();
    expect(obus(new Uint8Array([0x80])), "the forbidden bit").toBeNull();
  });

  it("is valid AV1 for the RTP packer: a key frame shows its sequence header in the clear, then the sealed frame", () => {
    const wrapped = wrapAv1(keyFrame, sealed);
    const parts = obus(wrapped)!;
    expect(parts.map((o) => o.type)).toEqual([OBU.SEQUENCE_HEADER, OBU.FRAME]);
    expect([...parts[0].payload]).toEqual([1, 2, 3, 4]);
    expect(parts.every((o) => o.hasSize)).toBe(true);
    // Nothing of the picture is left in the clear: only the sealed bytes after the mark.
    expect([...wrapped].join(",")).not.toContain(big.slice(10, 40).join(","));
    expect(unwrapAv1(wrapped)).toEqual(sealed);
  });

  it("puts a delta frame in one OBU, and gets the sealed bytes back after the receiver rebuilt the OBUs", () => {
    const wrapped = wrapAv1(deltaFrame, sealed);
    expect(obus(wrapped)!.map((o) => o.type)).toEqual([OBU.FRAME]);
    expect(unwrapAv1(wrapped)).toEqual(sealed);
    // The receiver's depacketizer writes every OBU with a size, and may drop the last one's: both read the same.
    const noSize = new Uint8Array([wrapped[0] & ~0x02, ...obus(wrapped)![0].payload]);
    expect(unwrapAv1(noSize)).toEqual(sealed);
  });

  it("tells the server a key frame from a delta frame as a plain AV1 frame header would (LiveKit reads it, as Galene does)", () => {
    // The server forwards a layer only from a key frame: a sequence header first, then a frame whose header byte has
    // show_existing_frame = 0 and frame_type = KEY (the top three bits clear).
    const key = obus(wrapAv1(keyFrame, sealed))!;
    expect(key[0].type).toBe(OBU.SEQUENCE_HEADER);
    expect(key[1].payload[0] & 0xe0).toBe(0);
    const delta = obus(wrapAv1(deltaFrame, sealed))!;
    expect(delta[0].payload[0] & 0x60, "an inter frame").toBe(0x20);
    expect(delta[0].payload[0] & 0x80, "shown").toBe(0);
  });

  it("takes nothing that is not an envelope", () => {
    expect(unwrapAv1(keyFrame), "a plain AV1 frame").toBeNull();
    expect(unwrapAv1(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(unwrapAv1(new Uint8Array(0))).toBeNull();
  });
});
