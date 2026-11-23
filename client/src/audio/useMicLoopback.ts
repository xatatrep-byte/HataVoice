import { useEffect, useRef, useState } from "react";
import { Track } from "livekit-client";
import { micErrorMessage } from "../voice/errors";
import { applyOutputDevice, getAudioContext } from "./audioContext";
import { MicPipeline } from "./micPipeline";
import type { AudioSettings } from "./settings";
import { presetFx } from "./voiceFx";
import { createVoiceGate, VAD_HOLD_MS, type VoiceGate } from "./vad";

/**
 * While `enabled`, plays your microphone back to you through the same processing as a call
 * (noise suppression, voice activation), so you hear yourself the way others will.
 */
export function useMicLoopback(enabled: boolean, settings: AudioSettings): { error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const { inputDeviceId, outputDeviceId, noiseSuppression, mode, vadThresholdDb, voicePreset, voiceCustom } = settings;
  const fx = presetFx(voicePreset, voiceCustom);
  const fxRef = useRef(fx);
  fxRef.current = fx;
  const gateRef = useRef<VoiceGate | null>(null);
  const pipelineRef = useRef<MicPipeline | null>(null);
  const thresholdRef = useRef(vadThresholdDb);
  thresholdRef.current = vadThresholdDb;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let stream: MediaStream | undefined;
    let pipeline: MicPipeline | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    const gate = createVoiceGate({
      thresholdDb: thresholdRef.current,
      holdMs: VAD_HOLD_MS,
      onChange: (open) => {
        if (mode === "voice") pipeline?.setGateOpen(open);
      },
    });
    gateRef.current = gate;

    (async () => {
      try {
        const context = getAudioContext();
        void context.resume();
        await applyOutputDevice(context, outputDeviceId).catch(() => {});
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: inputDeviceId === "default" ? undefined : { exact: inputDeviceId },
            // Never the echo canceller here: it hears everything the page plays, this very voice too, takes it for an
            // echo and cuts it, so the test sounded much worse than friends hear (in a call nothing plays it back).
            echoCancellation: false,
            noiseSuppression: noiseSuppression === "browser",
            autoGainControl: false,
            channelCount: 1,
          },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        pipeline = new MicPipeline({
          noiseSuppression: noiseSuppression === "rnnoise",
          onLevel: (db) => gate.feed(db, performance.now()),
          fx: fxRef.current,
        });
        pipelineRef.current = pipeline;
        // Push-to-talk has no voice activation: you hear yourself all the time.
        pipeline.setGateOpen(mode === "ptt");
        await pipeline.init({ kind: Track.Kind.Audio, track: stream.getAudioTracks()[0], audioContext: context });
        if (stopped || !pipeline.processedTrack) return;
        source = context.createMediaStreamSource(new MediaStream([pipeline.processedTrack]));
        source.connect(context.destination);
        setError(null);
      } catch (e) {
        if (!stopped) setError(micErrorMessage(e));
      }
    })();

    return () => {
      stopped = true;
      gateRef.current = null;
      source?.disconnect();
      void pipeline?.destroy();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled, inputDeviceId, outputDeviceId, noiseSuppression, mode]);

  // Dragging the sensitivity slider retunes the gate without reopening the mic.
  useEffect(() => gateRef.current?.setThreshold(vadThresholdDb), [vadThresholdDb]);

  // Another voice is heard at once, the mic staying open.
  useEffect(() => pipelineRef.current?.setFx(fx), [fx.pitch, fx.wobble, fx.robot, fx.echo, fx.reverb, fx.radio]);

  return { error };
}
