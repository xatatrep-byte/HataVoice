/**
 * AV1 for the studio's stream: the codec string an encoder is asked for, and the AV1CodecConfigurationRecord (`av1C`)
 * that Enhanced RTMP sends as the sequence start — WebCodecs gives AV1 no `description`, so it is made here: the four
 * bytes the codec string tells (profile, level, tier, bit depth, 4:2:0), then the sequence header OBU of the first key
 * frame, as ISO/IEC 14496-15's AV1 binding has it.
 */

/** AV1 levels as `seq_level_idx`, with the most pixels a frame may have, its sides, and pixels a second (Annex A). */
const LEVELS: { idx: number; picture: number; width: number; height: number; rate: number }[] = [
  { idx: 8, picture: 2_359_296, width: 6144, height: 3456, rate: 70_778_880 }, // 4.0
  { idx: 9, picture: 2_359_296, width: 6144, height: 3456, rate: 141_557_760 }, // 4.1
  { idx: 12, picture: 8_912_896, width: 8192, height: 4352, rate: 267_386_880 }, // 5.0
  { idx: 13, picture: 8_912_896, width: 8192, height: 4352, rate: 534_773_760 }, // 5.1
  { idx: 14, picture: 8_912_896, width: 8192, height: 4352, rate: 1_069_547_520 }, // 5.2
];

/** The codec string for a frame size and rate: Main profile, 8 bits, the lowest level that holds it. */
export function av1Codec(output: { width: number; height: number; fps: number }): string {
  const { width, height, fps } = output;
  const level = LEVELS.find((l) => width * height <= l.picture && width <= l.width && height <= l.height && width * height * fps <= l.rate) ?? LEVELS[LEVELS.length - 1]!;
  return `av01.0.${String(level.idx).padStart(2, "0")}M.08`;
}

export const OBU_SEQUENCE_HEADER = 1;
export const OBU_TEMPORAL_DELIMITER = 2;

/** The OBUs of a frame in the low-overhead format: each one's type and where it lies (header included). */
export function obus(data: Uint8Array): { type: number; start: number; end: number }[] {
  const list: { type: number; start: number; end: number }[] = [];
  let at = 0;
  while (at < data.length) {
    const start = at;
    const header = data[at]!;
    const type = (header >> 3) & 0x0f;
    const extension = (header >> 2) & 1;
    const sized = (header >> 1) & 1;
    at += 1 + extension;
    let size = data.length - at;
    if (sized) {
      size = 0;
      for (let i = 0; i < 8; i++) {
        if (at >= data.length) return list;
        const byte = data[at++]!;
        size += (byte & 0x7f) * 2 ** (7 * i);
        if (!(byte & 0x80)) break;
      }
    }
    const end = at + size;
    if (end > data.length) return list;
    list.push({ type, start, end });
    at = end;
  }
  return list;
}

/** The sequence start of an AV1 stream: `av1C` for the encoder's codec string and the first key frame. */
export function av1Config(codec: string, keyFrame: Uint8Array): Uint8Array<ArrayBuffer> {
  const m = /^av01\.(\d)\.(\d\d)([MH])\.(\d\d)/.exec(codec);
  const profile = Number(m?.[1] ?? 0);
  const level = Number(m?.[2] ?? 8);
  const tier = m?.[3] === "H" ? 1 : 0;
  const depth = Number(m?.[4] ?? 8);
  const high = depth > 8 ? 1 : 0;
  const twelve = depth === 12 ? 1 : 0;
  // Profile 0 is 4:2:0, 1 is 4:4:4, 2 (at 8 and 10 bits) 4:2:2; the chroma sample position is unknown (0).
  const [x, y] = profile === 0 ? [1, 1] : profile === 1 ? [0, 0] : [1, 0];
  const head = [0x81, ((profile & 7) << 5) | (level & 0x1f), (tier << 7) | (high << 6) | (twelve << 5) | (x << 3) | (y << 2), 0];
  const sequence = obus(keyFrame).find((o) => o.type === OBU_SEQUENCE_HEADER);
  const tail = sequence ? keyFrame.subarray(sequence.start, sequence.end) : new Uint8Array(0);
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}
