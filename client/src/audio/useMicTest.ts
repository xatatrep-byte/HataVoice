import { useEffect, useState } from "react";
import { micErrorMessage } from "../voice/errors";
import { getAudioContext } from "./audioContext";
import { dbToMeter, readRms, rmsToDb } from "./levels";

const POLL_MS = 50;

/**
 * Opens the microphone outside of any call and reports its level (0–1), for the mic test in
 * settings and onboarding. Everything is released when the component unmounts.
 */
export function useMicTest(deviceId: string): { level: number; error: string | null } {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId === "default" ? undefined : { exact: deviceId },
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (stopped) {
          // Closed while Windows was still opening the mic: release it right away.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const context = getAudioContext();
        void context.resume();
        source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        timer = setInterval(() => setLevel(dbToMeter(rmsToDb(readRms(analyser, buffer)))), POLL_MS);
        setError(null);
      } catch (e) {
        if (!stopped) setError(micErrorMessage(e));
      }
    })();

    return () => {
      stopped = true;
      clearInterval(timer);
      source?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId]);

  return { level, error };
}
