/**
 * The video editor's frame and its export. One frame is drawn the same for the preview and for the file: the video
 * turned, flipped, filling or fitting the frame, its colour, the titles of that moment, the fade. The export plays the
 * clips one after another through that frame and records it with the sound (each clip at its speed and loudness).
 */
import { clipLength, clipStarts, fadeAt, frameLayout, outputSize, timelineLength, titlesAt, videoFilter, type Title, type VideoDoc } from "./timeline";

/** One title on a frame of `width` × `height`. */
export function drawTitle(ctx: CanvasRenderingContext2D, title: Title, width: number, height: number) {
  const size = Math.max(8, title.size * height);
  ctx.save();
  ctx.font = `${title.bold ? 800 : 600} ${size}px "${title.font}", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = title.text.split("\n");
  const x = title.x * width;
  const y0 = title.y * height - ((lines.length - 1) * size * 1.2) / 2;
  if (title.background) {
    const w = Math.max(...lines.map((line) => ctx.measureText(line).width)) + size * 0.8;
    const h = lines.length * size * 1.2 + size * 0.4;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y0 - size * 0.8, w, h, size * 0.25);
    ctx.fill();
  }
  lines.forEach((line, i) => {
    const y = y0 + i * size * 1.2;
    if (title.outline) {
      ctx.lineWidth = Math.max(2, size / 8);
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = title.color;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

/** The frame at timeline second `t`, `source` being the video at the right place (null: black). */
export function drawFrame(ctx: CanvasRenderingContext2D, source: CanvasImageSource | null, doc: VideoDoc, t: number, width: number, height: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  if (source) {
    const { scale } = frameLayout(doc, width, height);
    ctx.filter = videoFilter(doc.adjust, doc.filter);
    ctx.translate(width / 2, height / 2);
    ctx.rotate((doc.turn * Math.PI) / 2);
    if (doc.flipX) ctx.scale(-1, 1);
    const w = doc.width * scale;
    const h = doc.height * scale;
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
  for (const title of titlesAt(doc, t)) drawTitle(ctx, title, width, height);
  const show = fadeAt(doc, t);
  if (show < 1) {
    ctx.fillStyle = `rgba(0, 0, 0, ${1 - show})`;
    ctx.fillRect(0, 0, width, height);
  }
}

/** What the video is written as: MP4 where the engine records it, else WebM; null when it records neither. */
export function recorderType(supported: (type: string) => boolean): { type: string; ext: "mp4" | "webm" } | null {
  for (const [type, ext] of [
    ["video/mp4;codecs=avc1,mp4a.40.2", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"],
    ["video/webm;codecs=vp8,opus", "webm"],
  ] as const) {
    if (supported(type)) return { type, ext };
  }
  return null;
}

export const QUALITIES = [
  { id: "1080", name: "1080p", maxHeight: 1080, bitrate: 8_000_000 },
  { id: "720", name: "720p", maxHeight: 720, bitrate: 5_000_000 },
  { id: "480", name: "480p", maxHeight: 480, bitrate: 2_500_000 },
];

/** Runs `step` at the next frame, or after 20 ms if frames are held back (a window out of sight). */
export function nextTick(step: () => void) {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    step();
  };
  requestAnimationFrame(go);
  setTimeout(go, 20);
}

/** Resolves once `target` fires `name`. */
export const once = (target: EventTarget, name: string) => new Promise<void>((resolve) => target.addEventListener(name, () => resolve(), { once: true }));

/** The video at second `time`, ready to be drawn. */
export async function seek(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) return;
  const seeked = once(video, "seeked");
  video.currentTime = time;
  await seeked;
}

/**
 * The cut video recorded to a file: each clip played through the frame at its speed (the sound with it, at its
 * loudness, fading), the recorder paused while the next clip is found. Takes as long as the cut video plays.
 */
export async function exportVideo(
  src: string,
  doc: VideoDoc,
  quality: (typeof QUALITIES)[number],
  onProgress: (part: number) => void,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; ext: "mp4" | "webm" }> {
  const type = recorderType((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error("Эта система не умеет записывать видео");
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.playsInline = true;
  video.preload = "auto";
  const loaded = once(video, "loadedmetadata");
  video.src = src;
  await loaded;
  const { width, height } = outputSize(doc, quality.maxHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  drawFrame(ctx, null, doc, 0, width, height);
  const stream = canvas.captureStream(30);
  const audio = new AudioContext();
  const gain = audio.createGain();
  const out = audio.createMediaStreamDestination();
  audio.createMediaElementSource(video).connect(gain).connect(out);
  if (!doc.muted) for (const track of out.stream.getAudioTracks()) stream.addTrack(track);
  const recorder = new MediaRecorder(stream, { mimeType: type.type, videoBitsPerSecond: quality.bitrate, audioBitsPerSecond: 160_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const total = Math.max(0.001, timelineLength(doc));
  const starts = clipStarts(doc);
  try {
    for (let i = 0; i < doc.clips.length; i++) {
      const clip = doc.clips[i]!;
      const from = starts[i]!;
      if (recorder.state === "recording") recorder.pause();
      await seek(video, clip.start);
      video.playbackRate = clip.speed;
      gain.gain.value = doc.muted ? 0 : clip.volume * fadeAt(doc, from);
      drawFrame(ctx, video, doc, from, width, height);
      if (recorder.state === "inactive") recorder.start(1000);
      else recorder.resume();
      await audio.resume();
      await video.play();
      await new Promise<void>((resolve, reject) => {
        const step = () => {
          if (signal.aborted) return reject(new DOMException("Остановлено", "AbortError"));
          const t = Math.min(from + clipLength(clip), from + (video.currentTime - clip.start) / clip.speed);
          gain.gain.value = doc.muted ? 0 : clip.volume * fadeAt(doc, t);
          drawFrame(ctx, video, doc, t, width, height);
          onProgress(Math.min(1, t / total));
          if (video.currentTime >= clip.end - 0.02 || video.ended) return resolve();
          nextTick(step);
        };
        nextTick(step);
      });
      video.pause();
    }
    const stopped = once(recorder, "stop");
    recorder.stop();
    await stopped;
  } finally {
    video.pause();
    if (recorder.state !== "inactive") recorder.stop();
    for (const track of stream.getTracks()) track.stop();
    void audio.close();
    video.removeAttribute("src");
    video.load();
  }
  onProgress(1);
  const blob = new Blob(chunks, { type: type.type });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: type.ext };
}

/** Small frames of the video, every `every` seconds, as pictures to show along the clips. */
export async function thumbnails(src: string, duration: number, count: number, onThumb: (index: number, url: string) => void, signal: AbortSignal) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  const loaded = once(video, "loadeddata");
  video.src = src;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.height = 54;
  canvas.width = Math.max(1, Math.round((54 * (video.videoWidth || 16)) / (video.videoHeight || 9)));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  for (let i = 0; i < count && !signal.aborted; i++) {
    await seek(video, Math.min(duration - 0.05, ((i + 0.5) * duration) / count));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    onThumb(i, canvas.toDataURL("image/jpeg", 0.6));
  }
  video.removeAttribute("src");
  video.load();
}

/** How loud the sound is along the video: the peak of each of `buckets` parts (0–1); empty when it has no sound. */
export async function waveform(src: string, buckets: number): Promise<number[]> {
  const bytes = await (await fetch(src)).arrayBuffer();
  const audio = new AudioContext();
  try {
    const decoded = await audio.decodeAudioData(bytes);
    const data = decoded.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / buckets));
    const peaks: number[] = [];
    for (let b = 0; b < buckets; b++) {
      let peak = 0;
      for (let i = b * per; i < Math.min(data.length, (b + 1) * per); i += 16) peak = Math.max(peak, Math.abs(data[i]!));
      peaks.push(peak);
    }
    return peaks;
  } catch {
    return [];
  } finally {
    void audio.close();
  }
}
