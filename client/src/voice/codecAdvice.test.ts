import { describe, expect, it } from "vitest";
import { bestCodec, codecAdvice, cleanGpuName } from "./codecAdvice";

const card = { encode: true, hardware: true, smooth: true };
const processor = { encode: true, hardware: false, smooth: true };
const none = { encode: false, hardware: false, smooth: false };

describe("codec advice by the video card", () => {
  it("AV1 is the best where the video card encodes it, H.264 anywhere else", () => {
    expect(bestCodec(card)).toBe("av1");
    expect(bestCodec(processor)).toBe("h264");
    expect(bestCodec(none)).toBe("h264");
  });

  it("marks AV1 green on a card that encodes it, and H.264 stays a plain choice", () => {
    const advice = codecAdvice(card, "NVIDIA GeForce RTX 4070");
    expect(advice.best).toBe("av1");
    expect(advice.tone.av1).toBe("good");
    expect(advice.tone.h264).toBeNull();
    expect(advice.line).toContain("RTX 4070");
    expect(advice.line).toContain("AV1");
  });

  it("marks AV1 red and H.264 green where the processor would have to encode AV1", () => {
    const advice = codecAdvice(processor, "NVIDIA GeForce GTX 1660");
    expect(advice.tone.av1).toBe("bad");
    expect(advice.tone.h264).toBe("good");
    expect(advice.title.av1).toMatch(/процессор/);
    expect(advice.line).toContain("GTX 1660");
    expect(advice.line).toContain("H.264");
  });

  it("says AV1 cannot go at all where this PC has no AV1 encoder", () => {
    const advice = codecAdvice(none, null);
    expect(advice.tone.av1).toBe("bad");
    expect(advice.title.av1).toMatch(/не кодирует/);
    expect(advice.line).not.toContain("null");
  });

  it("never colours «Авто» or VP9: one follows the card, the other is for weak viewers", () => {
    for (const support of [card, processor, none]) {
      const advice = codecAdvice(support, null);
      expect(advice.tone.auto).toBeNull();
      expect(advice.tone.vp9svc).toBeNull();
    }
  });

  it("reads the video card out of what WebGL calls it", () => {
    expect(cleanGpuName("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002820) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("NVIDIA GeForce RTX 4070 Laptop GPU");
    expect(cleanGpuName("ANGLE (AMD, AMD Radeon RX 7800 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("AMD Radeon RX 7800 XT");
    expect(cleanGpuName("ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("Intel(R) UHD Graphics 770");
    expect(cleanGpuName("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBeNull();
    expect(cleanGpuName("")).toBeNull();
    expect(cleanGpuName("Apple M2")).toBe("Apple M2");
  });
});
