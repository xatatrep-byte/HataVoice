import { describe, expect, it } from "vitest";
import { inspectModel, ModelError, readGlb, shrinkModel, writeGlb, type ImagePacker } from "./glb";

const glb = (json: object, bin: Uint8Array = new Uint8Array(0)) => writeGlb({ json, bin });

describe("a model file", () => {
  it("reads back what was written", () => {
    const bin = new Uint8Array([1, 2, 3, 4, 5]);
    const read = readGlb(glb({ asset: { version: "2.0" } }, bin));
    expect(read.json.asset.version).toBe("2.0");
    expect([...read.bin.subarray(0, 5)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses what is no GLB, cut or spoiled", () => {
    expect(() => readGlb(new Uint8Array(100))).toThrow(ModelError);
    expect(() => readGlb(new Uint8Array(3))).toThrow(ModelError);
    const cut = glb({ asset: {} }, new Uint8Array(64)).subarray(0, 40);
    expect(() => readGlb(cut)).toThrow(ModelError);
  });
});

describe("what a stranger's model may be", () => {
  it("names a VRM and counts its triangles", () => {
    const report = inspectModel(
      glb({
        extensions: { VRM: { meta: { title: "Шибу", licenseName: "CC0" } } },
        accessors: [{ count: 300 }],
        meshes: [{ primitives: [{ indices: 0 }] }],
        images: [{ bufferView: 0, mimeType: "image/png" }],
      }),
    );
    expect(report).toEqual({ kind: "vrm", triangles: 100, images: 1, title: "Шибу", license: "CC0" });
  });

  it("never follows an outside address: it would tell a stranger our IP", () => {
    expect(() => inspectModel(glb({ buffers: [{ uri: "https://evil.example/x.bin", byteLength: 1 }] }))).toThrow(/внешние файлы/);
    expect(() => inspectModel(glb({ images: [{ uri: "https://evil.example/x.png" }] }))).toThrow(/внешние картинки/);
    expect(() => inspectModel(glb({ images: [{ uri: "file:///c:/secret.png" }] }))).toThrow(/внешние картинки/);
    expect(inspectModel(glb({ images: [{ uri: "data:image/png;base64,AAAA" }] })).images).toBe(1);
  });

  it("refuses what would bring this PC to its knees", () => {
    expect(() => inspectModel(glb({ accessors: [{ count: 3_000_000 }], meshes: [{ primitives: [{ indices: 0 }] }] }))).toThrow(/тяжёлая/);
    expect(() => inspectModel(glb({ images: Array.from({ length: 200 }, () => ({ bufferView: 0 })) }))).toThrow(/текстур/);
    expect(() => inspectModel(glb({ nodes: Array.from({ length: 10_000 }, () => ({})) }))).toThrow(/частей/);
    expect(() => inspectModel(new Uint8Array(26 * 1024 * 1024))).toThrow(/больше 25 МБ/);
  });
});

describe("shrinking a model", () => {
  const halve: ImagePacker = async (bytes, _mime, maxSize) => ({ bytes: bytes.subarray(0, Math.floor(bytes.length / 2)), mimeType: maxSize === 64 ? "image/thumb" : "image/webp" });

  it("packs the pictures and keeps the geometry where accessors find it", async () => {
    const bin = new Uint8Array(40);
    for (let i = 0; i < 40; i++) bin[i] = i;
    const file = glb(
      {
        buffers: [{ byteLength: 40 }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 8 },
          { buffer: 0, byteOffset: 8, byteLength: 24 },
          { buffer: 0, byteOffset: 32, byteLength: 8 },
        ],
        images: [{ bufferView: 1, mimeType: "image/png" }],
      },
      bin,
    );
    const { json, bin: out } = readGlb(await shrinkModel(file, halve));
    expect(json.images[0].mimeType).toBe("image/webp");
    expect(json.bufferViews.map((v: { byteLength: number }) => v.byteLength)).toEqual([8, 12, 8]);
    const after = json.bufferViews[2];
    expect([...out.subarray(after.byteOffset, after.byteOffset + 8)]).toEqual([32, 33, 34, 35, 36, 37, 38, 39]);
    expect(json.buffers[0].byteLength).toBe(out.length);
  });

  it("a thumbnail is packed smaller than any texture", async () => {
    const sizes: number[] = [];
    const spy: ImagePacker = async (bytes, _mime, maxSize) => {
      sizes.push(maxSize);
      return { bytes: bytes.subarray(0, 1), mimeType: "image/webp" };
    };
    const file = glb(
      {
        extensions: { VRM: { meta: { texture: 1 } } },
        textures: [{ source: 0 }, { source: 1 }],
        buffers: [{ byteLength: 8 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }, { buffer: 0, byteOffset: 4, byteLength: 4 }],
        images: [{ bufferView: 0 }, { bufferView: 1 }],
      },
      new Uint8Array(8),
    );
    await shrinkModel(file, spy, 1024);
    expect(sizes).toEqual([1024, 64]);
  });

  it("keeps a picture that did not get smaller", async () => {
    const grow: ImagePacker = async () => ({ bytes: new Uint8Array(1000), mimeType: "image/webp" });
    const file = glb({ buffers: [{ byteLength: 4 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }], images: [{ bufferView: 0, mimeType: "image/png" }] }, new Uint8Array(4));
    const { json } = readGlb(await shrinkModel(file, grow));
    expect(json.images[0].mimeType).toBe("image/png");
    expect(json.bufferViews[0].byteLength).toBe(4);
  });
});
