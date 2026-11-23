import workletUrl from "./voiceFxWorklet.js?url";

/** What the voice changer does to the voice. Everyone in the call hears it, and it is encrypted like any voice. */
export type VoiceFx = {
  /** Semitones, −12…+12: down is a giant, up a chipmunk. */
  pitch: number;
  /** 0–1: the voice sways, as if tipsy or from another world. */
  wobble: number;
  /** 0–1: a robot's metal. */
  robot: number;
  /** 0–1: an echo coming back. */
  echo: number;
  /** 0–1: a big hall or a cave. */
  reverb: number;
  /** A walkie-talkie: thin, crackly. */
  radio: boolean;
};

export const NO_FX: VoiceFx = { pitch: 0, wobble: 0, robot: 0, echo: 0, reverb: 0, radio: false };

export type VoicePreset = { id: string; name: string; emoji: string; fx: VoiceFx };

export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: "none", name: "Свой голос", emoji: "🙂", fx: NO_FX },
  { id: "chipmunk", name: "Бурундук", emoji: "🐿️", fx: { ...NO_FX, pitch: 7 } },
  { id: "helium", name: "Гелий", emoji: "🎈", fx: { ...NO_FX, pitch: 12 } },
  { id: "giant", name: "Великан", emoji: "🗿", fx: { ...NO_FX, pitch: -6, reverb: 0.2 } },
  { id: "demon", name: "Демон", emoji: "😈", fx: { ...NO_FX, pitch: -10, robot: 0.25, reverb: 0.45 } },
  { id: "robot", name: "Робот", emoji: "🤖", fx: { ...NO_FX, robot: 0.85 } },
  { id: "alien", name: "Пришелец", emoji: "👽", fx: { ...NO_FX, pitch: 4, wobble: 0.7, robot: 0.35 } },
  { id: "tipsy", name: "Навеселе", emoji: "🥴", fx: { ...NO_FX, wobble: 1, pitch: -1 } },
  { id: "radio", name: "Рация", emoji: "📻", fx: { ...NO_FX, radio: true } },
  { id: "cave", name: "Пещера", emoji: "🕳️", fx: { ...NO_FX, echo: 0.35, reverb: 0.7 } },
  { id: "announcer", name: "Диктор", emoji: "📢", fx: { ...NO_FX, pitch: -2, reverb: 0.3 } },
  { id: "ghost", name: "Призрак", emoji: "👻", fx: { ...NO_FX, pitch: 3, wobble: 0.5, echo: 0.5, reverb: 0.6 } },
];

export function presetFx(id: string, custom: VoiceFx): VoiceFx {
  if (id === "custom") return custom;
  return VOICE_PRESETS.find((p) => p.id === id)?.fx ?? NO_FX;
}

/** The voice is left as it is. */
export function isPlain(fx: VoiceFx): boolean {
  return fx.pitch === 0 && fx.wobble === 0 && fx.robot === 0 && fx.echo === 0 && fx.reverb === 0 && !fx.radio;
}

const clamp = (x: unknown, lo: number, hi: number, fallback: number) =>
  typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;

export function parseVoiceFx(raw: unknown): VoiceFx {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    pitch: Math.round(clamp(r.pitch, -12, 12, 0)),
    wobble: clamp(r.wobble, 0, 1, 0),
    robot: clamp(r.robot, 0, 1, 0),
    echo: clamp(r.echo, 0, 1, 0),
    reverb: clamp(r.reverb, 0, 1, 0),
    radio: r.radio === true,
  };
}

const workletModules = new WeakMap<BaseAudioContext, Promise<void>>();

function loadWorklet(context: BaseAudioContext): Promise<void> {
  let loading = workletModules.get(context);
  if (!loading) {
    loading = context.audioWorklet.addModule(workletUrl);
    workletModules.set(context, loading);
  }
  return loading;
}

/** A room of a second, made of noise fading out: what a cave sounds like to a convolver. */
function roomImpulse(context: BaseAudioContext, seconds = 1.8): AudioBuffer {
  const length = Math.round(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  return impulse;
}

/** A soft clipper: the crackle of a walkie-talkie. */
function crackle(amount: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i * 2) / curve.length - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

/**
 * The voice changer as a chain of nodes: the worklet (pitch, wobble, robot) → the walkie-talkie's band and crackle
 * → dry, plus an echo and a cave mixed in. Changed while it runs, without a click.
 */
export class VoiceFxChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private worklet: AudioWorkletNode;
  private low: BiquadFilterNode;
  private high: BiquadFilterNode;
  private clip: WaveShaperNode;
  private echoSend: GainNode;
  private echoDelay: DelayNode;
  private echoBack: GainNode;
  private reverbSend: GainNode;
  private reverb: ConvolverNode;

  private constructor(private readonly context: BaseAudioContext) {
    const mono = { channelCount: 1, channelCountMode: "explicit" as const };
    this.input = new GainNode(context, mono);
    this.output = new GainNode(context, mono);
    this.worklet = new AudioWorkletNode(context, "hatavoice-voice-fx", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.low = new BiquadFilterNode(context, { type: "allpass" });
    this.high = new BiquadFilterNode(context, { type: "allpass" });
    this.clip = new WaveShaperNode(context);
    this.echoSend = new GainNode(context, { gain: 0 });
    this.echoDelay = new DelayNode(context, { delayTime: 0.28, maxDelayTime: 1 });
    this.echoBack = new GainNode(context, { gain: 0 });
    this.reverbSend = new GainNode(context, { gain: 0 });
    this.reverb = new ConvolverNode(context, { buffer: roomImpulse(context) });

    this.input.connect(this.worklet).connect(this.high).connect(this.low).connect(this.clip).connect(this.output);
    this.clip.connect(this.echoSend).connect(this.echoDelay).connect(this.output);
    this.echoDelay.connect(this.echoBack).connect(this.echoDelay);
    this.clip.connect(this.reverbSend).connect(this.reverb).connect(this.output);
  }

  static async create(context: BaseAudioContext, fx: VoiceFx): Promise<VoiceFxChain> {
    await loadWorklet(context);
    const chain = new VoiceFxChain(context);
    chain.set(fx);
    return chain;
  }

  set(fx: VoiceFx): void {
    this.worklet.port.postMessage({ pitch: fx.pitch, wobble: fx.wobble, robot: fx.robot });
    const now = this.context.currentTime;
    const glide = (param: AudioParam, value: number) => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, 0.03);
    };
    glide(this.echoSend.gain, fx.echo * 0.6);
    glide(this.echoBack.gain, fx.echo * 0.45);
    glide(this.reverbSend.gain, fx.reverb * 0.9);
    this.high.type = fx.radio ? "highpass" : "allpass";
    this.high.frequency.value = 400;
    this.low.type = fx.radio ? "lowpass" : "allpass";
    this.low.frequency.value = 3200;
    this.clip.curve = fx.radio ? crackle(6) : null;
  }

  disconnect(): void {
    for (const node of [this.input, this.worklet, this.high, this.low, this.clip, this.echoSend, this.echoDelay, this.echoBack, this.reverbSend, this.reverb, this.output]) {
      node.disconnect();
    }
    this.worklet.port.close();
  }
}
