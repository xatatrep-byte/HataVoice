/**
 * The sound board: short sounds that go into the call with the voice, all of them made here from nothing, so no recording
 * had to be licensed and the program stays small. Pure numbers in, samples out: they are synthesized once, when first played.
 *
 * Built like real instruments, not raw waves: noise through the resonance of a hand for a clap, a reed through a mouth's
 * formants for a quack, brass whose filter opens as it is blown, a small room around all of it. Every sound is brought to
 * the same loudness as a voice (not to the same peak: a hiss at full peak is far louder than a voice and hurts).
 */

export const BOARD_RATE = 48_000;

type Synth = (seconds: number, out: Float32Array) => void;

/** Same seed, same noise: the sounds stay the same from one launch to the next. */
function noiseFrom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

const TAU = 2 * Math.PI;
const decay = (t: number, rate: number) => Math.exp(-t * rate);
const at = (seconds: number) => Math.floor(seconds * BOARD_RATE);

// ---------------------------------------------------------------- filters

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number; x1: number; x2: number; y1: number; y2: number };

/** An RBJ cookbook filter: "low", "high", "band" (constant peak) or "peak" (a bell boost of `gainDb`). */
function biquad(kind: "low" | "high" | "band" | "peak", frequency: number, q: number, gainDb = 0): Biquad {
  const w = (TAU * Math.min(frequency, BOARD_RATE * 0.45)) / BOARD_RATE;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === "low") {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (kind === "high") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (kind === "band") {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function step(f: Biquad, x: number): number {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

function filter(out: Float32Array, f: Biquad, from = 0, to = out.length): void {
  for (let i = from; i < to; i++) out[i] = step(f, out[i]!);
}

/** A small room: four damped combs and two all-passes (Schroeder), mixed in by `wet`. */
function room(out: Float32Array, wet: number, size = 1): void {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => ({ line: new Float32Array(at(s * size)), i: 0, low: 0 }));
  const passes = [0.005, 0.0017].map((s) => ({ line: new Float32Array(at(s)), i: 0 }));
  for (let n = 0; n < out.length; n++) {
    const x = out[n]!;
    let sum = 0;
    for (const c of combs) {
      const y = c.line[c.i]!;
      c.low += (y - c.low) * 0.45;
      c.line[c.i] = x + c.low * 0.78;
      c.i = (c.i + 1) % c.line.length;
      sum += y;
    }
    let y = sum * 0.25;
    for (const p of passes) {
      const d = p.line[p.i]!;
      const v = y + d * 0.7;
      p.line[p.i] = v;
      p.i = (p.i + 1) % p.line.length;
      y = d - v * 0.7;
    }
    out[n] = x + y * wet;
  }
}

// ---------------------------------------------------------------- oscillators

/** A band-limited-ish saw: a sum of harmonics up to `top` Hz (no fizz above it). */
function bandSaw(phase: number, frequency: number, top = 7000): number {
  const n = Math.max(1, Math.min(40, Math.floor(top / frequency)));
  let sum = 0;
  for (let k = 1; k <= n; k++) sum += Math.sin(TAU * k * phase) / k;
  return sum * 0.6;
}

/** A band-limited pulse of width `duty`: the reed of a kazoo, a duck's voice. */
function bandPulse(phase: number, frequency: number, duty: number, top = 6000): number {
  const n = Math.max(1, Math.min(40, Math.floor(top / frequency)));
  let sum = 0;
  for (let k = 1; k <= n; k++) sum += (Math.sin(Math.PI * k * duty) / k) * Math.cos(TAU * k * phase);
  return sum * 0.9;
}

// ---------------------------------------------------------------- the sounds

/** Many hands: each person claps at their own pace and with their own palms, the crowd swells and dies down in a hall. */
const applause: Synth = (seconds, out) => {
  const rand = noiseFrom(99);
  const pick = (a: number, b: number) => a + ((rand() + 1) / 2) * (b - a);
  const noise = noiseFrom(21);
  const people = 22;
  for (let p = 0; p < people; p++) {
    const rate = pick(3.6, 5.6);
    const start = pick(0.0, 0.35);
    const stop = pick(seconds - 0.95, seconds - 0.25);
    const palm = pick(900, 2600);
    const q = pick(1.1, 2.2);
    const level = pick(0.45, 1.0);
    let t = start;
    while (t < stop) {
      const from = at(t);
      const f = biquad("band", palm * pick(0.92, 1.08), q);
      const body = biquad("low", 420, 0.8);
      const ring = pick(140, 260);
      const loud = level * pick(0.75, 1.15);
      for (let i = from; i < Math.min(out.length, from + at(0.05)); i++) {
        const dt = (i - from) / BOARD_RATE;
        const env = Math.min(1, dt / 0.0006) * decay(dt, ring);
        const n = noise() * env;
        out[i] += loud * (step(f, n) * 1.6 + step(body, n) * 0.35);
      }
      t += (1 / rate) * pick(0.86, 1.14);
    }
  }
  room(out, 0.35, 1.25);
};

/** A drummer's joke: a snare, a tom, and a cymbal ringing out. */
const rimshot: Synth = (seconds, out) => {
  const noise = noiseFrom(7);
  const drum = (start: number, high: number, low: number, sweep: number, toneLevel: number, wires: number, length: number) => {
    const from = at(start);
    const snare = biquad("band", 3200, 0.7);
    let phase = 0;
    for (let i = from; i < Math.min(out.length, from + at(length)); i++) {
      const t = (i - from) / BOARD_RATE;
      const f = low + (high - low) * decay(t, sweep);
      phase += f / BOARD_RATE;
      const tone = Math.sin(TAU * phase) * decay(t, 14) * toneLevel;
      const buzz = step(snare, noise()) * decay(t, 18) * wires;
      out[i] += (tone + buzz) * Math.min(1, t / 0.001);
    }
  };
  drum(0.0, 330, 190, 40, 0.8, 1.5, 0.3);
  drum(0.17, 210, 110, 30, 1.0, 0.25, 0.45);
  // The cymbal: metal partials and bright noise, a quick bloom and a long fade.
  const from = at(0.36);
  const partials = [413, 591, 727, 1017, 1235, 1620, 2093, 2879].map((f) => ({ f: f * 2.4, phase: 0 }));
  const hiss = biquad("high", 5500, 0.7);
  const tame = biquad("low", 11000, 0.7);
  for (let i = from; i < out.length; i++) {
    const t = (i - from) / BOARD_RATE;
    let metal = 0;
    for (const p of partials) {
      p.phase += p.f / BOARD_RATE;
      metal += Math.sign(Math.sin(TAU * p.phase));
    }
    const env = Math.min(1, t / 0.002) * (0.55 * decay(t, 9) + 0.45 * decay(t, 2.2));
    const fade = Math.min(1, (seconds - 0.36 - t) / 0.1);
    out[i] += step(tame, step(hiss, metal * 0.06 + noise() * 0.5)) * env * fade * 0.9;
  }
  // A kick under the cymbal.
  drum(0.36, 120, 50, 25, 1.1, 0.0, 0.35);
  room(out, 0.18);
};

/** One brass note: a few voices a hair apart, the filter opening as it is blown, vibrato on long notes. */
function brass(out: Float32Array, start: number, length: number, frequency: number, level: number, bright = 1, vibrato = 0, wah = false): void {
  const from = at(start);
  const voices = [-0.004, 0, 0.0045].map((d) => ({ d, phase: 0, low: biquad("low", 600, 0.9) }));
  for (let i = from; i < Math.min(out.length, from + at(length)); i++) {
    const t = (i - from) / BOARD_RATE;
    const attack = Math.min(1, t / 0.025);
    const release = Math.min(1, (length - t) / 0.07);
    // The filter: a blat at the start, then settling; a plunger mute opens and closes it on each note.
    const open = wah ? 0.25 + 0.75 * Math.sin(Math.PI * Math.min(1, t / (length * 0.9))) : 0.55 + 0.45 * decay(t, 6);
    const cutoff = (500 + 2800 * bright * open) * Math.min(1, 0.35 + t / 0.04);
    const wobble = vibrato && t > 0.18 ? 1 + vibrato * Math.sin(TAU * 5.6 * (t - 0.18)) * Math.min(1, (t - 0.18) / 0.15) : 1;
    let sum = 0;
    for (const v of voices) {
      const f = frequency * (1 + v.d) * wobble;
      v.phase += f / BOARD_RATE;
      if ((i - from) % 48 === 0) Object.assign(v.low, { ...biquad("low", cutoff, 1.1), x1: v.low.x1, x2: v.low.x2, y1: v.low.y1, y2: v.low.y2 });
      sum += step(v.low, bandSaw(v.phase, f));
    }
    out[i] += (sum / voices.length) * attack * release * level;
  }
}

/** Brass going up and a chord at the top: someone won. */
const fanfare: Synth = (_, out) => {
  brass(out, 0.0, 0.15, 392.0, 0.9);
  brass(out, 0.16, 0.15, 523.25, 0.9);
  brass(out, 0.32, 0.15, 659.25, 0.9);
  brass(out, 0.48, 0.6, 783.99, 0.9, 1.1, 0.006);
  brass(out, 0.48, 0.6, 659.25, 0.5, 0.9, 0.006);
  brass(out, 0.48, 0.6, 523.25, 0.45, 0.8, 0.006);
  room(out, 0.22, 1.1);
};

/** «Wah wah wah waaah» on a muted trombone: someone lost. */
const trombone: Synth = (_, out) => {
  brass(out, 0.0, 0.42, 233.08, 1, 0.8, 0, true);
  brass(out, 0.44, 0.42, 220.0, 1, 0.8, 0, true);
  brass(out, 0.88, 0.42, 207.65, 1, 0.8, 0, true);
  brass(out, 1.32, 1.0, 196.0, 1, 0.8, 0.03, true);
  room(out, 0.15);
};

/** A party blower: a buzzing reed through a paper tube, two short toots and a long one that unrolls. */
const horn: Synth = (seconds, out) => {
  const blasts: [number, number][] = [
    [0, 0.15],
    [0.2, 0.15],
    [0.42, seconds - 0.5],
  ];
  for (const [start, length] of blasts) {
    const from = at(start);
    const tube = biquad("peak", 1150, 2.5, 9);
    const tube2 = biquad("peak", 2400, 3, 5);
    const soft = biquad("low", 3800, 0.7);
    let phase = 0;
    const flutter = noiseFrom(start * 1000 + 3);
    let drift = 0;
    for (let i = from; i < Math.min(out.length, from + at(length)); i++) {
      const t = (i - from) / BOARD_RATE;
      drift += (flutter() * 0.5 - drift) * 0.002;
      const f = 420 * (0.94 + 0.06 * Math.min(1, t / 0.05)) * (1 + 0.01 * drift);
      phase += f / BOARD_RATE;
      const env = Math.min(1, t / 0.012) * Math.min(1, (length - t) / 0.04);
      out[i] += step(soft, step(tube2, step(tube, bandPulse(phase, f, 0.28)))) * env * 0.5;
    }
  }
  room(out, 0.12);
};

/** Crickets at night: three of them, each with its own pitch and pace, soft pulses, a little air around them. */
const crickets: Synth = (seconds, out) => {
  const bugs: [number, number, number, number][] = [
    [4300, 0.0, 0.72, 1.0],
    [3950, 0.27, 0.86, 0.6],
    [4650, 0.5, 0.64, 0.4],
  ];
  for (const [frequency, offset, every, level] of bugs) {
    for (let chirp = 0; offset + chirp * every < seconds - 0.25; chirp++) {
      for (let pulse = 0; pulse < 3; pulse++) {
        const start = offset + chirp * every + pulse * 0.045;
        const from = at(start);
        const length = 0.03;
        for (let i = from; i < Math.min(out.length, from + at(length)); i++) {
          const t = (i - from) / BOARD_RATE;
          const hann = 0.5 - 0.5 * Math.cos((TAU * t) / length);
          out[i] += level * hann * Math.sin(TAU * frequency * t) * (pulse === 1 ? 1 : 0.8);
        }
      }
    }
  }
  room(out, 0.3, 1.4);
};

/** A duck: a nasal reed falling in pitch through two formants of a bill, twice. */
const quack: Synth = (_, out) => {
  for (const [start, length] of [
    [0.0, 0.17],
    [0.24, 0.2],
  ] as [number, number][]) {
    const from = at(start);
    const f1 = biquad("band", 1050, 3.2);
    const f2 = biquad("band", 2350, 4.5);
    const f3 = biquad("band", 600, 2.0);
    let phase = 0;
    for (let i = from; i < Math.min(out.length, from + at(length)); i++) {
      const t = (i - from) / BOARD_RATE;
      const k = t / length;
      const f = 330 - 110 * k + 25 * Math.sin(Math.PI * Math.min(1, k * 3));
      phase += f / BOARD_RATE;
      const reed = bandPulse(phase, f, 0.18);
      const env = Math.min(1, t / 0.008) * Math.pow(Math.max(0, 1 - k), 0.6);
      out[i] += (step(f1, reed) * 1.0 + step(f2, reed) * 0.55 + step(f3, reed) * 0.5) * env;
    }
  }
  room(out, 0.08);
};

/** A desk bell: a light strike, bright partials ringing out at their own rates. */
const bell: Synth = (_, out) => {
  const noise = noiseFrom(5);
  const partials: [number, number, number][] = [
    [1318.5, 1, 2.2],
    [2637, 0.32, 3.4],
    [3640, 0.42, 4.6],
    [5340, 0.14, 7.5],
  ];
  const strike = biquad("band", 4000, 1.5);
  for (let i = 0; i < out.length; i++) {
    const t = i / BOARD_RATE;
    let sum = 0;
    for (const [frequency, level, rate] of partials) sum += level * decay(t, rate) * Math.sin(TAU * frequency * t * (1 + 0.0008 * Math.sin(TAU * 3 * t)));
    out[i] = 0.5 * sum * Math.min(1, t / 0.0015) + step(strike, noise()) * decay(t, 120) * 0.25;
  }
  room(out, 0.12);
};

export const BOARD: { id: string; label: string; seconds: number; synth: Synth }[] = [
  { id: "rimshot", label: "Ба-дум-тсс", seconds: 1.5, synth: rimshot },
  { id: "fanfare", label: "Фанфары", seconds: 1.3, synth: fanfare },
  { id: "trombone", label: "Провал", seconds: 2.5, synth: trombone },
  { id: "horn", label: "Горн", seconds: 1.4, synth: horn },
  { id: "applause", label: "Овации", seconds: 2.8, synth: applause },
  { id: "crickets", label: "Сверчки", seconds: 2.6, synth: crickets },
  { id: "quack", label: "Кря", seconds: 0.55, synth: quack },
  { id: "bell", label: "Звонок", seconds: 1.6, synth: bell },
];

/** How loud a voice is in the call: the loudest moment of a sound (in 50 ms) is brought to this, RMS. */
export const BOARD_LOUDNESS = 0.11;
/** And never past this peak. */
export const BOARD_PEAK = 0.8;

/** The loudest 50 ms of a sound, RMS. */
export function loudestMoment(samples: Float32Array): number {
  const window = at(0.05);
  let best = 0;
  for (let from = 0; from + window <= samples.length; from += window / 2) {
    let energy = 0;
    for (let i = from; i < from + window; i++) energy += samples[i]! * samples[i]!;
    best = Math.max(best, Math.sqrt(energy / window));
  }
  return best;
}

/** A sound's samples, as loud as a voice and never past the ceiling; no rumble, no fizz above 12 kHz. */
export function synthesize(id: string): Float32Array | null {
  const sound = BOARD.find((s) => s.id === id);
  if (!sound) return null;
  const out = new Float32Array(Math.ceil(sound.seconds * BOARD_RATE));
  sound.synth(sound.seconds, out);
  filter(out, biquad("high", 45, 0.7));
  filter(out, biquad("low", 12000, 0.7));
  // Fade the very end, so nothing is cut off with a click.
  const tail = at(0.03);
  for (let i = 0; i < tail; i++) out[out.length - 1 - i] *= i / tail;
  let peak = 0;
  for (const sample of out) peak = Math.max(peak, Math.abs(sample));
  const loud = loudestMoment(out);
  if (peak > 0 && loud > 0) {
    const gain = Math.min(BOARD_LOUDNESS / loud, BOARD_PEAK / peak);
    for (let i = 0; i < out.length; i++) out[i] *= gain;
  }
  return out;
}

const made = new Map<string, Float32Array | null>();

/** The same, made once. */
export function boardSound(id: string): Float32Array | null {
  if (!made.has(id)) made.set(id, synthesize(id));
  return made.get(id) ?? null;
}

/** Between two sounds of one person: a call is not a noise machine. */
export const BOARD_PAUSE_MS = 700;

/** The share of a sound's energy above `hz`: how much of it is hiss. */
export function energyAbove(samples: Float32Array, hz: number): number {
  const high = biquad("high", hz, 0.7);
  let all = 0;
  let top = 0;
  for (const x of samples) {
    const y = step(high, x);
    all += x * x;
    top += y * y;
  }
  return all > 0 ? top / all : 0;
}
