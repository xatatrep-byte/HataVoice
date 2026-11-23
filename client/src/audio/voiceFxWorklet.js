// The voice changer's own processing, in the audio thread: the pitch moved (two read heads gliding through a
// delay line, crossfaded so neither is heard jumping back), a wobble on top of it, and a ring modulator for the
// robot. Echo, the cave and the walkie-talkie are plain Web Audio nodes after it.

const WINDOW = 2048; // ~43 ms at 48 kHz: short enough to keep the voice in time, long enough not to buzz
const SIZE = 8192;

class VoiceFxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(SIZE);
    this.write = 0;
    this.delay = 0;
    this.ratio = 1;
    this.wobble = 0;
    this.robot = 0;
    this.lfo = 0;
    this.ring = 0;
    this.port.onmessage = ({ data }) => {
      if (typeof data.pitch === "number") this.ratio = Math.pow(2, Math.max(-12, Math.min(12, data.pitch)) / 12);
      if (typeof data.wobble === "number") this.wobble = Math.max(0, Math.min(1, data.wobble));
      if (typeof data.robot === "number") this.robot = Math.max(0, Math.min(1, data.robot));
    };
  }

  read(delay) {
    const at = this.write - delay;
    const i = Math.floor(at);
    const frac = at - i;
    const a = this.buffer[(i + SIZE) % SIZE];
    const b = this.buffer[(i + 1 + SIZE) % SIZE];
    return a + (b - a) * frac;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    const shifting = this.ratio !== 1 || this.wobble > 0;
    const lfoStep = (2 * Math.PI * 5.5) / sampleRate;
    const ringStep = (2 * Math.PI * 55) / sampleRate;
    for (let n = 0; n < output.length; n++) {
      const x = input ? input[n] : 0;
      let y = x;
      if (shifting) {
        this.buffer[this.write % SIZE] = x;
        // A wobble is the pitch swaying a little around where it is set.
        this.lfo += lfoStep;
        const ratio = this.ratio * (1 + this.wobble * 0.045 * Math.sin(this.lfo));
        this.delay = (this.delay + 1 - ratio + WINDOW) % WINDOW;
        const second = (this.delay + WINDOW / 2) % WINDOW;
        const fade = Math.sin((Math.PI * this.delay) / WINDOW);
        const g1 = fade * fade;
        // Two heads of different moments fade into each other: the crossfade loses ~2.5 dB, given back here.
        y = (this.read(this.delay + 2) * g1 + this.read(second + 2) * (1 - g1)) * 1.33;
        this.write = (this.write + 1) % (SIZE * 1024);
      }
      if (this.robot > 0) {
        this.ring += ringStep;
        y *= 1 - this.robot + this.robot * Math.sin(this.ring);
      }
      output[n] = y;
    }
    if (this.lfo > 2 * Math.PI) this.lfo -= 2 * Math.PI;
    if (this.ring > 2 * Math.PI) this.ring -= 2 * Math.PI;
    return true;
  }
}

registerProcessor("hatavoice-voice-fx", VoiceFxProcessor);
