/**
 * The board's packets, sealed like the call itself: each sender's packets with a key made (HKDF-SHA256, a label of its
 * own) from that sender's frame key, which the call's MLS group gives each member for the epoch. Only those in the call
 * open them; the server and LiveKit carry ciphertext. A packet names the key index it was sealed with and is bound to
 * its sender: one passed off as someone else's does not open.
 *
 * A packet: version (1), key index (1), IV (12), AES-256-GCM ciphertext and tag.
 */
import type { Packet } from "./model";

const VERSION = 1;
const IV_BYTES = 12;
const LABEL = new TextEncoder().encode("hatavoice-board-v1");
/** The most a board packet holds (a snapshot's piece is under 12 KB). */
export const MAX_PACKET = 16 * 1024;

function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const aad = (sender: string) => new TextEncoder().encode(`hv-board|${sender}`);

/** The board key of one sender, from their frame key (base64url, as the call gives it). */
export async function boardKey(frameKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", fromB64(frameKey), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: LABEL }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealPacket(packet: Packet, key: CryptoKey, index: number, sender: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(packet));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(sender) }, key, plain));
  const out = new Uint8Array(2 + IV_BYTES + sealed.length);
  out[0] = VERSION;
  out[1] = index & 0xff;
  out.set(iv, 2);
  out.set(sealed, 2 + IV_BYTES);
  return out;
}

/** What a packet from `sender` holds (parsed JSON, still to be read), or null when it does not open for them. */
export async function openPacket(bytes: Uint8Array, sender: string, keyFor: (index: number) => Promise<CryptoKey | null>): Promise<unknown> {
  if (bytes.length < 2 + IV_BYTES + 16 || bytes.length > MAX_PACKET || bytes[0] !== VERSION) return null;
  const key = await keyFor(bytes[1]!);
  if (!key) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(2, 2 + IV_BYTES), additionalData: aad(sender) }, key, bytes.slice(2 + IV_BYTES));
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return null;
  }
}
