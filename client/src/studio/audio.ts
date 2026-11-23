import meterUrl from "./meterWorklet.js?url";

/** One channel's processing, as the mixer shows it. */
export type ChannelFx = {
  /** Low, middle and high frequencies, dB. */
  eq: [number, number, number];
  compressor: boolean;
  /** Below this level the channel closes; dB, −100 is off. */
  gate: number;
  /** Lag behind the picture, ms: for a mic or camera that runs ahead of it. */
  delayMs: number;
  mono: boolean;
};

export const DEFAULT_FX: ChannelFx = { eq: [0, 0, 0], compressor: false, gate: -100, delayMs: 0, mono: false };

export type MixerSettings = {
  volumes: { mic: number; screen: number };
  muted: { mic: boolean; screen: boolean };
  fx: { mic: ChannelFx; screen: ChannelFx };
  /** The computer's sound steps back while we speak. */
  ducking: boolean;
  /** The microphone's own noise suppression and echo cancellation. */
  noiseSuppression: boolean;
  echoCancellation: boolean;
};

export const DEFAULT_MIXER: MixerSettings = {
  volumes: { mic: 1, screen: 1 },
  muted: { mic: false, screen: false },
  fx: { mic: { ...DEFAULT_FX, compressor: true }, screen: DEFAULT_FX },
  ducking: false,
  noiseSuppression: true,
  echoCancellation: false,
};

type Channel = "mic" | "screen";

type Input = {
  source: MediaStreamAudioSourceNode;
  gate: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  dry: GainNode;
  wet: GainNode;
  delay: DelayNode;
  duck: GainNode;
  gain: GainNode;
  analyser: AnalyserNode;
  stop: () => void;
};

/** The level of an analyser now, 0–1. */
function levelOf(analyser: AnalyserNode | undefined): number {
  if (!analyser) return 0;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const x of data) sum += x * x;
  return Math.min(1, Math.sqrt(sum / data.length) * 3);
}

/** The loudest a channel's sound may be in decibels from a level of `levelOf`. */
export function levelDb(level: number): number {
  return level <= 0.00001 ? -100 : 20 * Math.log10(level / 3);
}

/**
 * The studio's sound: the microphone and the sound of the shown screen, each through its own strip (gate, three bands of
 * EQ, compressor, delay, volume), mixed at 48 kHz through a limiter into one stereo track the compositor encodes.
 */
export class StudioAudio {
  readonly context = new AudioContext({ sampleRate: 48_000, latencyHint: "playback" });
  private readonly mix = new MediaStreamAudioDestinationNode(this.context, { channelCount: 2 });
  private readonly limiter = new DynamicsCompressorNode(this.context, { threshold: -1.5, knee: 0, ratio: 20, attack: 0.002, release: 0.08 });
  private mic: Input | null = null;
  private screen: Input | null = null;
  private meter: AudioWorkletNode | null = null;
  private settings: MixerSettings = DEFAULT_MIXER;
  private micDevice: string | null = null;
  private readonly watcher: ReturnType<typeof setInterval>;
  private gateOpenUntil = 0;

  constructor() {
    this.limiter.connect(this.mix);
    // The gate and the ducking listen to the voice a few dozen times a second.
    this.watcher = setInterval(() => this.watch(), 25);
  }

  /** The mixed sound, for the compositor. */
  get track(): MediaStreamTrack {
    return this.mix.stream.getAudioTracks()[0]!;
  }

  private input(stream: MediaStream, channel: Channel): Input {
    const c = this.context;
    const source = new MediaStreamAudioSourceNode(c, { mediaStream: stream });
    const gate = new GainNode(c, { gain: 1 });
    const low = new BiquadFilterNode(c, { type: "lowshelf", frequency: 180 });
    const mid = new BiquadFilterNode(c, { type: "peaking", frequency: 1500, Q: 0.8 });
    const high = new BiquadFilterNode(c, { type: "highshelf", frequency: 6000 });
    const compressor = new DynamicsCompressorNode(c, { threshold: -22, knee: 12, ratio: 3.5, attack: 0.006, release: 0.16 });
    const dry = new GainNode(c);
    const wet = new GainNode(c);
    const delay = new DelayNode(c, { maxDelayTime: 2 });
    const duck = new GainNode(c, { gain: 1 });
    const gain = new GainNode(c);
    const analyser = new AnalyserNode(c, { fftSize: 1024 });
    source.connect(gate).connect(low).connect(mid).connect(high);
    high.connect(dry).connect(delay);
    high.connect(compressor).connect(wet).connect(delay);
    delay.connect(duck).connect(gain);
    gain.connect(analyser);
    gain.connect(this.limiter);
    const input: Input = { source, gate, low, mid, high, compressor, dry, wet, delay, duck, gain, analyser, stop: () => stream.getTracks().forEach((t) => t.stop()) };
    this.applyTo(input, channel);
    return input;
  }

  private applyTo(input: Input, channel: Channel) {
    const { fx, volumes, muted } = this.settings;
    const f = fx[channel];
    const now = this.context.currentTime;
    input.low.gain.setTargetAtTime(f.eq[0], now, 0.02);
    input.mid.gain.setTargetAtTime(f.eq[1], now, 0.02);
    input.high.gain.setTargetAtTime(f.eq[2], now, 0.02);
    input.wet.gain.setTargetAtTime(f.compressor ? 1 : 0, now, 0.02);
    input.dry.gain.setTargetAtTime(f.compressor ? 0 : 1, now, 0.02);
    input.delay.delayTime.setTargetAtTime(Math.max(0, f.delayMs) / 1000, now, 0.02);
    input.gain.channelCount = f.mono ? 1 : 2;
    input.gain.channelCountMode = f.mono ? "explicit" : "max";
    input.gain.gain.setTargetAtTime(muted[channel] ? 0 : volumes[channel], now, 0.02);
    if (f.gate <= -100) input.gate.gain.setTargetAtTime(1, now, 0.01);
  }

  /** The mixer's settings; the strips change at once. The microphone reopens only when its own processing changed. */
  async configure(settings: MixerSettings): Promise<void> {
    const reopen = settings.noiseSuppression !== this.settings.noiseSuppression || settings.echoCancellation !== this.settings.echoCancellation;
    this.settings = settings;
    if (this.mic) this.applyTo(this.mic, "mic");
    if (this.screen) this.applyTo(this.screen, "screen");
    if (reopen && this.micDevice !== null) await this.setMic(this.micDevice);
  }

  private watch() {
    const now = this.context.currentTime;
    const mic = this.mic;
    if (!mic) {
      this.screen?.duck.gain.setTargetAtTime(1, now, 0.2);
      return;
    }
    const db = levelDb(levelOf(mic.analyser));
    const threshold = this.settings.fx.mic.gate;
    if (threshold > -100) {
      const open = db > threshold;
      if (open) this.gateOpenUntil = now + 0.25;
      mic.gate.gain.setTargetAtTime(now < this.gateOpenUntil ? 1 : 0, now, now < this.gateOpenUntil ? 0.004 : 0.05);
    }
    if (this.screen) {
      const speaking = db > -38;
      const target = this.settings.ducking && speaking ? 0.3 : 1;
      this.screen.duck.gain.setTargetAtTime(target, now, speaking ? 0.06 : 0.45);
    }
  }

  /** The microphone `deviceId` (the default one for ""), or none. */
  async setMic(deviceId: string | null): Promise<void> {
    this.mic?.source.disconnect();
    this.mic?.gain.disconnect();
    this.mic?.stop();
    this.mic = null;
    this.micDevice = deviceId;
    if (deviceId === null) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: this.settings.echoCancellation, noiseSuppression: this.settings.noiseSuppression, autoGainControl: false },
    });
    this.mic = this.input(stream, "mic");
    if (this.meter) this.mic.gain.connect(this.meter);
    void this.context.resume();
  }

  /** The sound of the shown screen (the computer's sound), or none. */
  setScreen(track: MediaStreamTrack | null): void {
    this.screen?.source.disconnect();
    this.screen?.gain.disconnect();
    this.screen = null;
    if (!track) return;
    this.screen = this.input(new MediaStream([track]), "screen");
    void this.context.resume();
  }

  levels(): { mic: number; screen: number } {
    return { mic: this.mic ? levelOf(this.mic.analyser) : 0, screen: this.screen ? levelOf(this.screen.analyser) : 0 };
  }

  /** A port that tells how loud the microphone is, for the character's mouth; given once. */
  async meterPort(): Promise<MessagePort> {
    await this.context.audioWorklet.addModule(meterUrl);
    this.meter = new AudioWorkletNode(this.context, "hatavoice-meter", { numberOfInputs: 1, numberOfOutputs: 0 });
    this.mic?.gain.connect(this.meter);
    return this.meter.port;
  }

  close(): void {
    clearInterval(this.watcher);
    this.mic?.stop();
    this.screen?.source.disconnect();
    void this.context.close();
  }
}
