/// <reference lib="webworker" />
// The phone's mic frames, off the page's thread: the 3D stage, a long render or Android holding back a page in the
// background no longer hold the voice up (see `FramePipeline`).
import { FrameMixer, pumpFrames, type FromFrameWorker, type ToFrameWorker } from "./frameMixer";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const tell = (word: FromFrameWorker) => scope.postMessage(word);

let mixer: FrameMixer | null = null;
let stop: (() => void) | null = null;

scope.onmessage = (event: MessageEvent<ToFrameWorker>) => {
  const word = event.data;
  switch (word.t) {
    case "start":
      stop?.();
      mixer = new FrameMixer((db) => tell({ t: "level", db }));
      mixer.setGateOpen(word.gate);
      stop = pumpFrames(word.readable, word.writable, mixer);
      break;
    case "gate":
      mixer?.setGateOpen(word.open);
      break;
    case "play":
      mixer?.play(word.samples, word.rate);
      break;
    case "stop":
      stop?.();
      stop = null;
      mixer = null;
      break;
  }
};

tell({ t: "ready" });
