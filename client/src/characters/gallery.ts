/**
 * The characters that come with the program: real models with faces, hair that moves and expressions, all under CC0
 * (anyone may use and change them). What a person is on the stage is told by a short code in the signed profile:
 *
 * - `c1.…`, `c2.…`: a figure built in the program (`character.ts`);
 * - `m1.<id>`: a model of this gallery;
 * - `p1.<hash>.<secret>`: a pack of one's own (a model file and motions), encrypted and kept on the server as a file of the
 *   chat. The secret travels only in the profile, which goes through the encrypted group: the server sees neither the model
 *   nor the secret.
 */

export type GalleryModel = { id: string; name: string; group: "heroes" | "people" | "fun"; credit: string };

const VROID = "VRoid (pixiv), CC0";
/** Built from nothing for HataVoice: tools/character in the repository makes them (Blender, by code). */
const OURS = "ХатаВойс, сделан с нуля, CC0";
const POLYGONAL = "Polygonal Mind, 100Avatars, CC0";

export const GALLERY: readonly GalleryModel[] = [
  { id: "iskra", name: "Искра", group: "heroes", credit: OURS },
  { id: "ren", name: "Рэн", group: "heroes", credit: OURS },
  { id: "mira", name: "Мира", group: "heroes", credit: OURS },
  { id: "kai", name: "Кай", group: "heroes", credit: OURS },
  { id: "shino", name: "Шино", group: "people", credit: VROID },
  { id: "shibu", name: "Шибу", group: "people", credit: VROID },
  { id: "fumiriya", name: "Фумирия", group: "people", credit: VROID },
  { id: "darkness", name: "Тёмная Шибу", group: "people", credit: VROID },
  { id: "vita", name: "Вита", group: "people", credit: VROID },
  { id: "vivi", name: "Виви", group: "people", credit: VROID },
  { id: "victoria", name: "Виктория", group: "people", credit: VROID },
  { id: "devil", name: "Чёрт", group: "fun", credit: POLYGONAL },
  { id: "dracula", name: "Дракула", group: "fun", credit: POLYGONAL },
  { id: "witch", name: "Ведьма", group: "fun", credit: POLYGONAL },
  { id: "wolfman", name: "Оборотень", group: "fun", credit: POLYGONAL },
  { id: "polybot", name: "Робот", group: "fun", credit: POLYGONAL },
  { id: "pirate", name: "Пират", group: "fun", credit: POLYGONAL },
  { id: "shark", name: "Акула", group: "fun", credit: POLYGONAL },
  { id: "frog", name: "Лягушонок", group: "fun", credit: POLYGONAL },
  { id: "rabbit", name: "Кролик", group: "fun", credit: POLYGONAL },
  { id: "teddy", name: "Мишка", group: "fun", credit: POLYGONAL },
  { id: "tiger", name: "Тигр", group: "fun", credit: POLYGONAL },
  { id: "moon", name: "Лунная", group: "fun", credit: POLYGONAL },
  { id: "wizard", name: "Глазастый маг", group: "fun", credit: POLYGONAL },
];

const GALLERY_CODE = /^m1\.([a-z0-9]{1,32})$/;
// A profile holds at most 96 characters of lowercase letters, digits and dots, and an older version throws away a whole
// profile with anything else: the file's hash and its secret are written in lowercase base32.
const PACK_CODE = /^p1\.([a-z2-7]{52})\.([a-z2-7]{26})$/;

export type AvatarCode = { kind: "gallery"; id: string } | { kind: "pack"; sha: string; key: string };

/** A model's code, or null when this one is something else. An unknown model of a newer version is a model still: it is simply not found. */
export function parseAvatar(code: unknown): AvatarCode | null {
  if (typeof code !== "string") return null;
  const gallery = GALLERY_CODE.exec(code);
  if (gallery) return { kind: "gallery", id: gallery[1]! };
  const pack = PACK_CODE.exec(code);
  if (pack) return { kind: "pack", sha: pack[1]!, key: pack[2]! };
  return null;
}

export const galleryCode = (id: string) => `m1.${id}`;
export const packCode = (sha: string, key: string) => `p1.${sha}.${key}`;

/** Where a model of the gallery lies, and its picture. */
export const galleryUrl = (id: string) => `/avatars/${id}.vrm`;
export const galleryPicture = (id: string) => `/avatars/${id}.webp`;

/** Someone who chose nothing gets a person of the gallery, the same on every PC. */
export function defaultAvatarFor(userId: string): string {
  const people = GALLERY.filter((m) => m.group === "people");
  let seed = 0;
  for (const ch of userId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return galleryCode(people[seed % people.length]!.id);
}

/** Where the program serves a pack's file of one server, decrypted, from what it keeps on this PC or fetches. */
export function avatarFileUrl(address: string, sha: string, key: string): string {
  const base = (globalThis as { __HV_MEDIA__?: string }).__HV_MEDIA__ ?? "http://hvmedia.localhost";
  return `${base}/avatar/${encodeURIComponent(address)}/${sha}/${key}`;
}
