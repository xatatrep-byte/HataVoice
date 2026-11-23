import { VideoQuality } from "livekit-client";
import { describe, expect, it } from "vitest";
import { cameraCaptureOptions, cameraErrorText, cameraLabel, cameraPublishOptions, DEFAULT_CAMERA, remoteCameraQuality } from "./camera";

describe("camera", () => {
  it("captures the chosen camera at the chosen size, 30 frames a second", () => {
    expect(cameraCaptureOptions(DEFAULT_CAMERA)).toEqual({ deviceId: undefined, resolution: { width: 1280, height: 720, frameRate: 30 } });
    expect(cameraCaptureOptions({ ...DEFAULT_CAMERA, deviceId: "cam-2", quality: "1080" })).toEqual({
      deviceId: { exact: "cam-2" },
      resolution: { width: 1920, height: 1080, frameRate: 30 },
    });
  });

  it("goes out in VP8 with smaller layers under the chosen one", () => {
    const hd = cameraPublishOptions(DEFAULT_CAMERA);
    expect(hd.videoCodec).toBe("vp8");
    expect(hd.simulcast).toBe(true);
    expect(hd.videoSimulcastLayers?.map((l) => l.height)).toEqual([180, 360]);
    expect(hd.videoEncoding?.maxFramerate).toBe(30);
    const small = cameraPublishOptions({ ...DEFAULT_CAMERA, quality: "360" });
    expect(small.videoSimulcastLayers?.map((l) => l.height)).toEqual([180]);
    expect(small.videoEncoding!.maxBitrate).toBeLessThan(hd.videoEncoding!.maxBitrate);
  });

  it("takes friends' cameras in full while few are on, the middle layer when many are", () => {
    expect(remoteCameraQuality(1)).toBe(VideoQuality.HIGH);
    expect(remoteCameraQuality(4)).toBe(VideoQuality.HIGH);
    expect(remoteCameraQuality(5)).toBe(VideoQuality.MEDIUM);
  });

  it("says what went wrong in words a person can act on", () => {
    expect(cameraErrorText(Object.assign(new Error("x"), { status: 403 }))).toMatch(/Сервер не разрешает/);
    expect(cameraErrorText(Object.assign(new Error("x"), { name: "NotAllowedError" }))).toMatch(/Конфиденциальность/);
    expect(cameraErrorText(Object.assign(new Error("x"), { name: "NotReadableError" }))).toMatch(/занята/);
    expect(cameraErrorText(Object.assign(new Error("x"), { name: "NotFoundError" }))).toMatch(/не найдена/);
  });

  it("names a camera without Windows' device numbers, and one with no name by its place", () => {
    expect(cameraLabel({ label: "HD Webcam C270 (046d:0825)" }, 0)).toBe("HD Webcam C270");
    expect(cameraLabel({ label: "" }, 1)).toBe("Камера 2");
  });
});
