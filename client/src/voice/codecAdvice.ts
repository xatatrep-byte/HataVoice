import { useEffect, useState } from "react";
import { av1Support, type Av1Support } from "./av1Support";
import type { ScreenCodec, ScreenSettings } from "./screen";

/** A codec's mark for this PC: green where it is the one to take, red where it would go badly, none where it is a plain choice. */
export type CodecTone = "good" | "bad" | null;

/** What to tell the person about the codecs on this PC: which is best, how each is marked and why, and one line about the card. */
export type CodecAdvice = {
  best: "av1" | "h264";
  tone: Record<ScreenCodec, CodecTone>;
  /** The words behind each mark (a button's tooltip). */
  title: Record<ScreenCodec, string>;
  /** «Видеокарта NVIDIA GeForce RTX 4070 кодирует AV1 — лучший выбор: AV1». */
  line: string;
};

/** The codec that suits this PC best: AV1 where the video card encodes it, H.264 anywhere else. */
export function bestCodec(support: Av1Support): "av1" | "h264" {
  return support.hardware ? "av1" : "h264";
}

export function codecAdvice(support: Av1Support, gpu: string | null): CodecAdvice {
  const best = bestCodec(support);
  const card = gpu ? `Видеокарта ${gpu}` : "Видеокарта этого ПК";
  const av1Title = support.hardware
    ? "Видеокарта кодирует AV1: самая чёткая картинка при той же скорости"
    : support.encode
      ? "Видеокарта не кодирует AV1: его будет считать процессор, картинка может идти рывками"
      : "Этот ПК не кодирует AV1: демонстрация пойдёт в VP9";
  return {
    best,
    tone: { auto: null, av1: support.hardware ? "good" : "bad", h264: support.hardware ? null : "good", vp9svc: null },
    title: {
      auto: `Сам выберет ${best === "av1" ? "AV1" : "H.264"} для этого ПК`,
      av1: av1Title,
      h264: support.hardware ? "Надёжный и лёгкий, но картинка чуть мягче AV1" : "Лучший выбор для этого ПК: лёгкий и плавный",
      vp9svc: "Нагружает процессор; выбирай, если у кого-то из друзей медленный интернет",
    },
    line: support.hardware ? `${card} кодирует AV1 — лучший выбор: AV1` : `${card} не кодирует AV1 — лучший выбор: H.264`,
  };
}

/**
 * The video card as people call it, out of what WebGL says («ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x…) Direct3D11 …, D3D11)»);
 * null for a software renderer or nothing.
 */
export function cleanGpuName(renderer: string): string | null {
  const raw = renderer.trim();
  if (!raw || /swiftshader|llvmpipe|software|microsoft basic/i.test(raw)) return null;
  const angle = /^ANGLE \(([^,]*),\s*(.*?)(?:,\s*[^,]*\))?$/.exec(raw);
  const name = (angle ? angle[2]! : raw)
    .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
    .replace(/\s+(Direct3D|D3D|OpenGL|Vulkan|Metal).*$/i, "")
    .trim();
  return name || null;
}

let gpuCache: string | null | undefined;

/** The video card of this PC by its name, once; null where the page cannot tell. */
export function gpuName(): string | null {
  if (gpuCache !== undefined) return gpuCache;
  gpuCache = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = gl && info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    gpuCache = typeof renderer === "string" ? cleanGpuName(renderer) : null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // No WebGL here: no name.
  }
  return gpuCache;
}

/** The advice for this PC at that size and rate; null until it is known. */
export function useCodecAdvice(quality: Pick<ScreenSettings, "resolution" | "fps">): CodecAdvice | null {
  const [advice, setAdvice] = useState<CodecAdvice | null>(null);
  useEffect(() => {
    let current = true;
    void av1Support(quality).then((support) => current && setAdvice(codecAdvice(support, gpuName())));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality.resolution, quality.fps]);
  return advice;
}
