/**
 * A 3D model as a file: reading a GLB (VRM is one too), checking that a stranger's file is safe to draw, and shrinking
 * it so that it can travel to friends. A glTF may point at outside addresses for its parts, and following one would tell
 * whoever owns that address our IP: only a file with everything inside is accepted.
 */

export class ModelError extends Error {}

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export const MAX_MODEL_BYTES = 25 * 1024 * 1024;
const MAX_TRIANGLES = 300_000;
const MAX_IMAGES = 96;
const MAX_NODES = 6000;
const MAX_SPRING_JOINTS = 1500;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Glb = { json: any; bin: Uint8Array };

function bytesOf(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** The two parts of a GLB. Throws [`ModelError`] when it is none. */
export function readGlb(data: ArrayBuffer | Uint8Array): Glb {
  const bytes = bytesOf(data);
  if (bytes.length < 20) throw new ModelError("Файл слишком короткий для 3D-модели");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new ModelError("Это не файл .vrm или .glb");
  if (view.getUint32(4, true) !== 2) throw new ModelError("Нужен glTF версии 2");
  const length = Math.min(view.getUint32(8, true), bytes.length);
  let at = 12;
  let json: unknown = null;
  let bin: Uint8Array = new Uint8Array(0);
  while (at + 8 <= length) {
    const size = view.getUint32(at, true);
    const kind = view.getUint32(at + 4, true);
    const end = at + 8 + size;
    if (end > length) throw new ModelError("Файл модели обрезан");
    const chunk = bytes.subarray(at + 8, end);
    if (kind === CHUNK_JSON && json === null) {
      try {
        json = JSON.parse(new TextDecoder().decode(chunk));
      } catch {
        throw new ModelError("Файл модели испорчен");
      }
    } else if (kind === CHUNK_BIN) {
      bin = chunk;
    }
    at = end;
  }
  if (typeof json !== "object" || json === null) throw new ModelError("Файл модели испорчен");
  return { json, bin };
}

/** The file of a GLB. */
export function writeGlb({ json, bin }: Glb): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonSize = (text.length + 3) & ~3;
  const binSize = (bin.length + 3) & ~3;
  const total = 12 + 8 + jsonSize + (binSize ? 8 + binSize : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonSize, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + jsonSize);
  out.set(text, 20);
  if (binSize) {
    const at = 20 + jsonSize;
    view.setUint32(at, binSize, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}

export type ModelReport = { kind: "vrm" | "glb"; triangles: number; images: number; title: string | null; license: string | null };

/** Is this file something we may draw? Says what it is, or throws [`ModelError`] with why not. */
export function inspectModel(data: ArrayBuffer | Uint8Array, maxBytes = MAX_MODEL_BYTES): ModelReport {
  const bytes = bytesOf(data);
  if (bytes.length > maxBytes) throw new ModelError(`Модель больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
  const { json } = readGlb(bytes);
  for (const buffer of json.buffers ?? []) {
    if (buffer.uri !== undefined) throw new ModelError("Модель ссылается на внешние файлы. Нужен файл, где всё внутри");
  }
  const images = json.images ?? [];
  for (const image of images) {
    if (image.uri !== undefined && !String(image.uri).startsWith("data:image/")) throw new ModelError("Модель ссылается на внешние картинки. Нужен файл, где всё внутри");
  }
  if (images.length > MAX_IMAGES) throw new ModelError("В модели слишком много текстур");
  if ((json.nodes ?? []).length > MAX_NODES) throw new ModelError("В модели слишком много частей");
  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessor = json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION];
      triangles += Math.floor((accessor?.count ?? 0) / 3);
    }
  }
  if (triangles > MAX_TRIANGLES) throw new ModelError(`Модель слишком тяжёлая: ${triangles.toLocaleString("ru-RU")} треугольников, можно до ${MAX_TRIANGLES.toLocaleString("ru-RU")}`);
  const vrm0 = json.extensions?.VRM;
  const vrm1 = json.extensions?.VRMC_vrm;
  const springs = (vrm0?.secondaryAnimation?.boneGroups ?? []).reduce((sum: number, group: { bones?: unknown[] }) => sum + (group.bones?.length ?? 0), 0) + (json.extensions?.VRMC_springBone?.springs ?? []).reduce((sum: number, s: { joints?: unknown[] }) => sum + (s.joints?.length ?? 0), 0);
  if (springs > MAX_SPRING_JOINTS) throw new ModelError("В модели слишком много пружинящих костей");
  const meta = vrm0?.meta ?? vrm1?.meta;
  return {
    kind: vrm0 || vrm1 ? "vrm" : "glb",
    triangles,
    images: images.length,
    title: typeof meta?.title === "string" ? meta.title : typeof meta?.name === "string" ? meta.name : null,
    license: typeof meta?.licenseName === "string" ? meta.licenseName : typeof meta?.licenseUrl === "string" ? meta.licenseUrl : null,
  };
}

/** What may be done to a picture: drawn smaller and packed again. In a browser, canvases do it; tests give their own. */
export type ImagePacker = (bytes: Uint8Array, mimeType: string, maxSize: number) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

/** The texture that is only a picture of the model in a file manager: it can be very small. */
function thumbnailImages(json: Glb["json"]): Set<number> {
  const out = new Set<number>();
  const vrm0 = json.extensions?.VRM?.meta?.texture;
  if (typeof vrm0 === "number" && vrm0 >= 0) {
    const source = json.textures?.[vrm0]?.source;
    if (typeof source === "number") out.add(source);
  }
  const vrm1 = json.extensions?.VRMC_vrm?.meta?.thumbnailImage;
  if (typeof vrm1 === "number") out.add(vrm1);
  return out;
}

/** The model again with its pictures packed by `pack`; geometry stays as it is, only the pictures' bytes change. */
export async function shrinkModel(data: ArrayBuffer | Uint8Array, pack: ImagePacker, maxTexture = 1024): Promise<Uint8Array> {
  const { json, bin } = readGlb(data);
  const views: { byteOffset?: number; byteLength: number }[] = json.bufferViews ?? [];
  const thumbs = thumbnailImages(json);
  const replaced = new Map<number, Uint8Array>();
  for (const [index, image] of (json.images ?? []).entries()) {
    if (typeof image.bufferView !== "number") continue;
    const view = views[image.bufferView];
    if (!view) continue;
    const start = view.byteOffset ?? 0;
    const packed = await pack(bin.subarray(start, start + view.byteLength), image.mimeType ?? "image/png", thumbs.has(index) ? 64 : maxTexture);
    if (packed && packed.bytes.length < view.byteLength) {
      replaced.set(image.bufferView, packed.bytes);
      image.mimeType = packed.mimeType;
    }
  }
  let size = 0;
  for (const [index, view] of views.entries()) {
    size = (size + 3) & ~3;
    size += replaced.get(index)?.length ?? view.byteLength;
  }
  const out = new Uint8Array((size + 3) & ~3);
  let at = 0;
  for (const [index, view] of views.entries()) {
    at = (at + 3) & ~3;
    const start = view.byteOffset ?? 0;
    const bytes = replaced.get(index) ?? bin.subarray(start, start + view.byteLength);
    out.set(bytes, at);
    view.byteOffset = at;
    view.byteLength = bytes.length;
    at += bytes.length;
  }
  if (json.buffers?.[0]) json.buffers[0].byteLength = out.length;
  return writeGlb({ json, bin: out });
}

/** Pictures drawn smaller on a canvas and packed as WebP; null when this one cannot be decoded. */
export const browserPacker: ImagePacker = async (bytes, mimeType, maxSize) => {
  try {
    const blob = new Blob([bytes.slice()], { type: mimeType });
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const packed = await canvas.convertToBlob({ type: "image/webp", quality: 0.88 });
    if (packed.type !== "image/webp") return null;
    return { bytes: new Uint8Array(await packed.arrayBuffer()), mimeType: "image/webp" };
  } catch {
    return null;
  }
};
