/**
 * AV1 under end-to-end encryption. A frame is encrypted whole (as LiveKit does VP9), but the RTP packer of AV1 reads
 * the frame's OBUs to cut it into packets, and encrypted bytes are no OBUs: the frame never left. So the sealed frame
 * travels inside one real OBU, which the packer cuts like any other without looking in; a key frame also carries its
 * sequence header in the clear first (profile and size, no picture), for the server and the receiver to know a key
 * frame by. The receiver takes the sealed bytes out of the envelope before decrypting.
 * See docs/superpowers/specs/2026-10-30-av1-e2ee-design.md.
 */

export const OBU = {
  SEQUENCE_HEADER: 1,
  TEMPORAL_DELIMITER: 2,
  FRAME_HEADER: 3,
  TILE_GROUP: 4,
  METADATA: 5,
  FRAME: 6,
  PADDING: 15,
} as const;

/**
 * The envelope's payload starts as a frame header would: the server forwards a layer only from a key frame, which it
 * knows by a sequence header first and a frame whose header byte says show_existing_frame = 0 and frame_type = KEY
 * (LiveKit reads it as the Galene SFU does). Then «HV», version 2.
 */
const KEY_HEADER = 0x10; // shown key frame
const DELTA_HEADER = 0x30; // shown inter frame
const MARK = [0x48, 0x56, 0x02];

export type Obu = { type: number; extension: number | undefined; hasSize: boolean; payload: Uint8Array };

/** The OBUs of `data`, or null when it is not a well-formed OBU stream. */
export function obus(data: Uint8Array): Obu[] | null {
  const out: Obu[] = [];
  let i = 0;
  while (i < data.length) {
    const header = data[i++];
    if (header & 0x80) return null;
    const type = (header >> 3) & 0x0f;
    let extension: number | undefined;
    if (header & 0x04) {
      if (i >= data.length) return null;
      extension = data[i++];
    }
    const hasSize = (header & 0x02) !== 0;
    let size = data.length - i;
    if (hasSize) {
      size = 0;
      for (let shift = 0; ; shift += 7) {
        if (i >= data.length || shift > 28) return null;
        const byte = data[i++];
        size += (byte & 0x7f) * 2 ** shift;
        if (!(byte & 0x80)) break;
      }
      if (i + size > data.length) return null;
    }
    out.push({ type, extension, hasSize, payload: data.subarray(i, i + size) });
    i += size;
  }
  return out;
}

function leb128(n: number): number[] {
  const bytes: number[] = [];
  do {
    bytes.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n > 0);
  return bytes;
}

/** One OBU, always with its size. */
function write(type: number, extension: number | undefined, payload: ArrayLike<number>): Uint8Array {
  const head = [(type << 3) | 0x02 | (extension !== undefined ? 0x04 : 0), ...(extension !== undefined ? [extension] : []), ...leb128(payload.length)];
  const out = new Uint8Array(head.length + payload.length);
  out.set(head);
  out.set(payload, head.length);
  return out;
}

/** The envelope of `sealed`, the encryption of the AV1 frame `plain`. */
export function wrapAv1(plain: Uint8Array, sealed: Uint8Array): Uint8Array {
  // A frame that starts a sequence is a key frame.
  const sequence = (obus(plain) ?? []).find((o) => o.type === OBU.SEQUENCE_HEADER);
  const inner = new Uint8Array(1 + MARK.length + sealed.length);
  inner[0] = sequence ? KEY_HEADER : DELTA_HEADER;
  inner.set(MARK, 1);
  inner.set(sealed, 1 + MARK.length);
  const parts = [...(sequence ? [write(OBU.SEQUENCE_HEADER, sequence.extension, sequence.payload)] : []), write(OBU.FRAME, undefined, inner)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The sealed frame inside an envelope, or null when `data` is none. */
export function unwrapAv1(data: Uint8Array): Uint8Array | null {
  const envelope = obus(data)?.find(
    (o) => o.type === OBU.FRAME && (o.payload[0] === KEY_HEADER || o.payload[0] === DELTA_HEADER) && MARK.every((b, i) => o.payload[1 + i] === b),
  );
  return envelope ? envelope.payload.slice(1 + MARK.length) : null;
}
