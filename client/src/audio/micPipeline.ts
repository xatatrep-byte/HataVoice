import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { SAMPLE_RATE } from "./audioContext";
import { LEVEL_INTERVAL_MS, readRms, rmsToDb } from "./levels";
import { VoiceFxChain, type VoiceFx } from "./voiceFx";

export { LEVEL_INTERVAL_MS };
const GATE_RAMP_SECONDS = 0.01;
/** Below this a mic picks up rumble, not voice: desk knocks, fans, the pop of a «п». */
export const HIGH_PASS_HZ = 75;
/** Peaks above this (dBFS) are held down, so a shout does not crackle; a normal voice never reaches it. */
export const LIMIT_DB = -3;

let wasmBinary: Promise<ArrayBuffer> | undefined;
const workletModules = new WeakMap<AudioContext, Promise<void>>();

function loadWorklet(context: AudioContext): Promise<void> {
  let loading = workletModules.get(context);
  if (!loading) {
    loading = context.audioWorklet.addModule(rnnoiseWorkletUrl);
    workletModules.set(context, loading);
  }
  return loading;
}

/** Makes `node` take one channel: a stereo input is averaged into mono. */
function monoInput<T extends AudioNode>(node: T): T {
  node.channelCount = 1;
  node.channelCountMode = "explicit";
  node.channelInterpretation = "speakers";
  return node;
}

export type MicPipelineOptions = {
  noiseSuppression: boolean;
  /** Called every LEVEL_INTERVAL_MS with the level after noise suppression, dBFS. */
  onLevel: (db: number) => void;
  /** The voice changer, if any: after noise suppression, after the level is measured (voice activation hears
   * the real voice, not an echo's tail). */
  fx?: VoiceFx;
};

/**
 * The microphone path: track → rumble cut → [RNNoise] → level meter → [voice changer] → peak limiter →
 * voice-activation gate → LiveKit. The gate is a gain stage, so the level is still measured while it is closed.
 */
export class MicPipeline implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "hatavoice-mic";
  processedTrack?: MediaStreamTrack;

  // Closed until voice activation or push-to-talk opens it: nothing leaks by default.
  private gateOpen = false;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private downmix?: GainNode;
  private highPass?: BiquadFilterNode;
  private limiter?: DynamicsCompressorNode;
  private rnnoise?: RnnoiseWorkletNode;
  private analyser?: AnalyserNode;
  private fx?: VoiceFxChain;
  private gate?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private timer?: ReturnType<typeof setInterval>;
  /** Why the voice changer did not start: the voice then goes out unchanged rather than not at all. */
  fxError?: unknown;

  constructor(private readonly options: MicPipelineOptions) {}

  async init({ track, audioContext }: AudioProcessorOptions): Promise<void> {
    this.context = audioContext;
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    // Many USB headsets deliver stereo even when asked for mono. From here on everything is mono:
    // RNNoise cleans a single channel, and a stereo output would leave the voice in one ear.
    this.downmix = monoInput(audioContext.createGain());
    let last: AudioNode = this.source.connect(this.downmix);
    if (typeof audioContext.createBiquadFilter === "function") {
      this.highPass = monoInput(audioContext.createBiquadFilter());
      this.highPass.type = "highpass";
      this.highPass.frequency.value = HIGH_PASS_HZ;
      this.highPass.Q.value = Math.SQRT1_2;
      last = last.connect(this.highPass);
    }

    if (this.options.noiseSuppression) {
      if (audioContext.sampleRate !== SAMPLE_RATE) {
        throw new Error(`RNNoise needs ${SAMPLE_RATE} Hz, the audio context runs at ${audioContext.sampleRate} Hz`);
      }
      wasmBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
      const [binary] = await Promise.all([wasmBinary, loadWorklet(audioContext)]);
      this.rnnoise = monoInput(new RnnoiseWorkletNode(audioContext, { maxChannels: 1, wasmBinary: binary }));
      last = last.connect(this.rnnoise);
    }

    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.gate = audioContext.createGain();
    this.gate.gain.value = this.gateOpen ? 1 : 0;
    this.destination = monoInput(audioContext.createMediaStreamDestination());
    last.connect(this.analyser);
    if (this.options.fx) {
      try {
        this.fx = await VoiceFxChain.create(audioContext, this.options.fx);
        last.connect(this.fx.input);
        last = this.fx.output;
      } catch (e) {
        this.fxError = e;
      }
    }
    if (typeof audioContext.createDynamicsCompressor === "function") {
      // A limiter, not a leveler: hard above the threshold, nothing below it.
      this.limiter = monoInput(audioContext.createDynamicsCompressor());
      this.limiter.threshold.value = LIMIT_DB;
      this.limiter.knee.value = 1;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;
      last = last.connect(this.limiter);
    }
    last.connect(this.gate).connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];

    const buffer = new Float32Array(this.analyser.fftSize);
    const analyser = this.analyser;
    this.timer = setInterval(() => this.options.onLevel(rmsToDb(readRms(analyser, buffer))), LEVEL_INTERVAL_MS);
  }

  /**
   * A sound for the call: past the voice's processing and past the gate, so voice activation neither cuts it nor opens for
   * it. It is heard through the same encrypted track as the voice. Says whether the pipeline was there to take it.
   */
  playIntoCall(samples: Float32Array, rate: number): boolean {
    const context = this.context;
    if (!context || !this.destination) return false;
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    // We hear it too, a little quieter than the others do.
    const own = context.createGain();
    own.gain.value = 0.5;
    source.connect(own).connect(context.destination);
    source.onended = () => {
      source.disconnect();
      own.disconnect();
    };
    source.start();
    return true;
  }

  /** The voice changer changes while we talk. */
  setFx(fx: VoiceFx): void {
    this.options.fx = fx;
    this.fx?.set(fx);
  }

  /** Opens or closes the voice-activation gate with a short fade (no clicks). */
  setGateOpen(open: boolean): void {
    this.gateOpen = open;
    const gain = this.gate?.gain;
    const context = this.context;
    if (!gain || !context) return;
    const now = context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(open ? 1 : 0, now + GATE_RAMP_SECONDS);
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(options);
  }

  async destroy(): Promise<void> {
    clearInterval(this.timer);
    this.source?.disconnect();
    this.downmix?.disconnect();
    this.highPass?.disconnect();
    this.limiter?.disconnect();
    this.rnnoise?.disconnect();
    this.rnnoise?.destroy();
    this.analyser?.disconnect();
    this.fx?.disconnect();
    this.gate?.disconnect();
    this.destination?.disconnect();
    this.processedTrack?.stop();
    this.timer = this.source = this.downmix = this.rnnoise = this.analyser = this.gate = this.destination = this.fx = undefined;
    this.highPass = this.limiter = undefined;
    this.processedTrack = undefined;
  }
}
