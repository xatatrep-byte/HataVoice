// How loud the microphone is, about 25 times a second, straight to whoever holds the port (the studio's compositor,
// for the character's mouth): the audio thread is never throttled when the window is hidden.
class Meter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.count = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) this.sum += channel[i] * channel[i];
      this.count += channel.length;
      if (this.count >= 1920) {
        this.port.postMessage(Math.min(1, Math.sqrt(this.sum / this.count) * 3));
        this.sum = 0;
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor("hatavoice-meter", Meter);
