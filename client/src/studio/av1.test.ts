import { describe, expect, it } from "vitest";
import { av1Codec, av1Config, obus } from "./av1";

// A key frame as an encoder gives it: a temporal delimiter, a sequence header (3 bytes of payload), a frame OBU.
const TD = [0x12, 0x00];
const SEQ = [0x0a, 0x03, 0x00, 0x00, 0x00];
const FRAME = [0x32, 0x02, 0xaa, 0xbb];
const keyFrame = new Uint8Array([...TD, ...SEQ, ...FRAME]);

describe("AV1 for the studio's stream", () => {
  it("asks the encoder for the lowest level that holds the frame", () => {
    expect(av1Codec({ width: 1920, height: 1080, fps: 30 })).toBe("av01.0.08M.08");
    expect(av1Codec({ width: 1920, height: 1080, fps: 60 })).toBe("av01.0.09M.08");
    expect(av1Codec({ width: 2560, height: 1440, fps: 60 })).toBe("av01.0.12M.08");
    expect(av1Codec({ width: 3840, height: 2160, fps: 30 })).toBe("av01.0.12M.08");
    expect(av1Codec({ width: 3840, height: 2160, fps: 60 })).toBe("av01.0.13M.08");
  });

  it("finds each OBU of a frame by its size field", () => {
    expect(obus(keyFrame)).toEqual([
      { type: 2, start: 0, end: 2 },
      { type: 1, start: 2, end: 7 },
      { type: 6, start: 7, end: 11 },
    ]);
    expect(obus(new Uint8Array([0x0a, 0x09, 0x00])), "a size past the end stops").toEqual([]);
  });

  it("makes av1C from the codec string and the key frame's sequence header", () => {
    const config = av1Config("av01.0.09M.08", keyFrame);
    expect([...config.subarray(0, 4)]).toEqual([0x81, 0x09, 0b0000_1100, 0x00]);
    expect([...config.subarray(4)]).toEqual(SEQ);
    // A 10-bit high tier one, and no sequence header in the frame: the four bytes alone.
    expect([...av1Config("av01.0.13H.10", new Uint8Array(FRAME))]).toEqual([0x81, 0x0d, 0b1100_1100, 0x00]);
  });
});

describe("the studio's codec choice", () => {
  it("is H.264 unless AV1 is picked, and asks the encoder for the matching codec", async () => {
    const { DEFAULT_OUTPUT, parseOutput, videoCodec } = await import("./layout");
    expect(DEFAULT_OUTPUT.codec).toBe("h264");
    expect(parseOutput({ codec: "hevc" }).codec).toBe("h264");
    expect(videoCodec(parseOutput({ codec: "av1", width: 1920, height: 1080, fps: 60 }))).toBe("av01.0.09M.08");
    expect(videoCodec(DEFAULT_OUTPUT)).toMatch(/^avc1\.6400/);
  });
});
