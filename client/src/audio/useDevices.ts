import { useEffect, useState } from "react";

/** Audio input/output devices, kept up to date when devices are plugged in or out. */
export function useDevices(): { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] } {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.enumerateDevices) return;
    const update = () => void media.enumerateDevices().then(setDevices).catch(() => setDevices([]));
    update();
    media.addEventListener?.("devicechange", update);
    return () => media.removeEventListener?.("devicechange", update);
  }, []);

  return {
    inputs: devices.filter((d) => d.kind === "audioinput"),
    outputs: devices.filter((d) => d.kind === "audiooutput"),
    cameras: devices.filter((d) => d.kind === "videoinput"),
  };
}
