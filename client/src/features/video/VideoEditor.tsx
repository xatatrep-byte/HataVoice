import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  FlipHorizontal2,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  SkipBack,
  SkipForward,
  Slice,
  Trash2,
  Type,
  Undo2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  clipAt,
  clipId,
  clipLength,
  clipStarts,
  moveClip,
  newVideoDoc,
  NO_VIDEO_ADJUST,
  outputSize,
  removeClip,
  setSpeed,
  SPEEDS,
  splitAt,
  timeLabel,
  timelineLength,
  titlesAt,
  trimClip,
  VIDEO_FILTERS,
  type Aspect,
  type Title,
  type VideoAdjust,
  type VideoDoc,
} from "../../media/video/timeline";
import { drawFrame, exportVideo, nextTick, once, QUALITIES, seek, thumbnails, waveform } from "../../media/video/render";
import { FONTS } from "../../media/photo/render";
import "./video.css";

type Panel = "clip" | "text" | "frame" | "color" | "sound";
type Chosen = { kind: "clip" | "title"; id: string } | null;
type History = { past: VideoDoc[]; now: VideoDoc; future: VideoDoc[] };
type Drag =
  | { k: "scrub" }
  | { k: "move"; id: string; x: number; start: VideoDoc }
  | { k: "trim"; id: string; edge: "start" | "end"; x: number; from: number; start: VideoDoc }
  | { k: "title"; id: string; edge: "move" | "at" | "until"; x: number; at: number; until: number; start: VideoDoc }
  | { k: "place"; id: string; x: number; y: number; tx: number; ty: number; start: VideoDoc };

const PANELS: { id: Panel; name: string }[] = [
  { id: "clip", name: "Клип" },
  { id: "text", name: "Текст" },
  { id: "frame", name: "Кадр" },
  { id: "color", name: "Цвет" },
  { id: "sound", name: "Звук" },
];
const ASPECTS: { id: Aspect; name: string }[] = [
  { id: "source", name: "Как у видео" },
  { id: "16:9", name: "16:9" },
  { id: "9:16", name: "9:16" },
  { id: "1:1", name: "1:1" },
  { id: "4:5", name: "4:5" },
];
const TITLE_COLORS = ["#ffffff", "#000000", "#facc15", "#ef4444", "#22c55e", "#3b82f6", "#ec4899", "#f97316"];
const THUMBS = 40;
const EDGE = 7;
const FRAME = 1 / 30;
const HEADER = 44;

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const record = (h: History, next: VideoDoc): History => (next === h.now ? h : { past: [...h.past, h.now].slice(-80), now: next, future: [] });

type Props = { src: string; name: string; size?: number; onDone: (bytes: Uint8Array, name: string) => void; onClose: () => void };

/** The video editor over the window: it reads the video's length and size, then works on it. */
export function VideoEditor(props: Props) {
  const [meta, setMeta] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const probe = document.createElement("video");
    probe.crossOrigin = "anonymous";
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      if (!Number.isFinite(probe.duration) || probe.duration <= 0) return setBroken(true);
      setMeta({ duration: probe.duration, width: probe.videoWidth || 1280, height: probe.videoHeight || 720 });
    };
    probe.onerror = () => setBroken(true);
    probe.src = props.src;
    return () => {
      probe.removeAttribute("src");
      probe.load();
    };
  }, [props.src]);
  if (broken) {
    return (
      <div className="video-editor video-editor-note" role="dialog" aria-label="Видеоредактор">
        <p>Это видео не открывается здесь (может быть, его формат не поддерживается).</p>
        <button type="button" className="video-button" onClick={props.onClose}>
          Закрыть
        </button>
      </div>
    );
  }
  if (!meta) return <div className="video-editor video-editor-note" role="dialog" aria-label="Видеоредактор">Открываю видео…</div>;
  return <VideoWorkspace {...props} meta={meta} />;
}

/**
 * The video editor, as editors of video are: the monitor with the cut video playing on top, the settings of what is
 * chosen on its left, and the timeline below — the video's clips (with their frames), the titles, the sound (its
 * wave). Cut with the blade or S, drag clips to change their order, drag their edges to trim, set each one's speed and
 * loudness, add titles, change the frame's shape, its colour, fades. Every change can be taken back.
 */
export function VideoWorkspace({ src, name, size, onDone, onClose, meta }: Props & { meta: { duration: number; width: number; height: number } }) {
  const [h, setH] = useState<History>(() => ({ past: [], now: newVideoDoc(meta.duration, meta.width, meta.height), future: [] }));
  const doc = h.now;
  const docRef = useRef(doc);
  docRef.current = doc;
  const length = timelineLength(doc);
  const starts = clipStarts(doc);
  const [playhead, setPlayhead] = useState(0);
  const headRef = useRef(0);
  headRef.current = playhead;
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [chosen, setChosen] = useState<Chosen>(null);
  const [tool, setTool] = useState<"select" | "razor">("select");
  const [panel, setPanel] = useState<Panel>("clip");
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(900);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [quality, setQuality] = useState(QUALITIES[1]!.id);
  const [exporting, setExporting] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragX, setDragX] = useState<{ id: string; dx: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const monitorRef = useRef<HTMLCanvasElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const sliding = useRef<VideoDoc | null>(null);

  const pps = Math.max(2, ((width - HEADER - 24) / Math.max(1, length)) * zoom);
  const preview = useMemo(() => outputSize(doc, 720), [doc.aspect, doc.turn, doc.width, doc.height]);
  const clip = chosen?.kind === "clip" ? doc.clips.find((c) => c.id === chosen.id) : undefined;
  const title = chosen?.kind === "title" ? doc.titles.find((t) => t.id === chosen.id) : undefined;

  // ---- The document: kept in the history, or live while a hand moves (kept when it lets go).
  const change = (fn: (d: VideoDoc) => VideoDoc) => setH((now) => record(now, fn(now.now)));
  const live = (fn: (d: VideoDoc) => VideoDoc) => setH((now) => ({ ...now, now: fn(now.now) }));
  const settle = (start: VideoDoc) => setH((now) => (now.now === start ? now : { past: [...now.past, start].slice(-80), now: now.now, future: [] }));
  const slide = (fn: (d: VideoDoc) => VideoDoc) => {
    sliding.current ??= h.now;
    live(fn);
  };
  const slid = () => {
    if (sliding.current) settle(sliding.current);
    sliding.current = null;
  };
  const setTitle = (id: string, patch: Partial<Title>) => (d: VideoDoc) => ({ ...d, titles: d.titles.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  // The timeline's width.
  useLayoutEffect(() => {
    const element = tracksRef.current;
    if (!element) return;
    const measure = () => element.clientWidth > 0 && setWidth(element.clientWidth);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  // Frames along the clips, and the wave of the sound (a video up to 150 MB: its sound is opened whole).
  useEffect(() => {
    const stop = new AbortController();
    const got: string[] = [];
    void thumbnails(src, meta.duration, THUMBS, (i, url) => {
      got[i] = url;
      setThumbs(got.slice());
    }, stop.signal).catch(() => {});
    if ((size ?? 0) <= 150 * 1024 * 1024) void waveform(src, 600).then(setPeaks).catch(() => {});
    return () => stop.abort();
  }, [src]);

  // ---- The monitor.
  const paint = (t: number) => {
    const canvas = monitorRef.current;
    const ctx = canvas?.getContext?.("2d");
    const video = videoRef.current;
    if (!canvas || !ctx) return;
    // A frame still being found keeps the last picture (it is drawn again once found).
    if (video && video.readyState < 2 && canvas.width === preview.width && canvas.height === preview.height) return;
    if (canvas.width !== preview.width) canvas.width = preview.width;
    if (canvas.height !== preview.height) canvas.height = preview.height;
    drawFrame(ctx, video && video.readyState >= 2 ? video : null, docRef.current, t, preview.width, preview.height);
  };

  // Each found frame is drawn while paused, whoever asked for it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const found = () => !playingRef.current && paint(headRef.current);
    video.addEventListener("seeked", found);
    video.addEventListener("loadeddata", found);
    return () => {
      video.removeEventListener("seeked", found);
      video.removeEventListener("loadeddata", found);
    };
  });

  // Paused: the video shows the frame under the playhead.
  useEffect(() => {
    if (playing) return;
    const video = videoRef.current;
    const at = clipAt(doc, playhead);
    if (!video || !at) return paint(playhead);
    let gone = false;
    void (video.readyState >= 1 ? seek(video, at.source) : once(video, "loadeddata").then(() => seek(video, at.source)))
      .then(() => !gone && paint(playhead))
      .catch(() => {});
    paint(playhead);
    return () => {
      gone = true;
    };
  }, [playhead, doc, playing, preview.width, preview.height]);

  const pause = () => {
    playingRef.current = false;
    setPlaying(false);
    videoRef.current?.pause();
  };

  /** Plays the cut video from the playhead, clip after clip, until the end or a pause. */
  const play = async () => {
    const video = videoRef.current;
    if (!video) return;
    let t = headRef.current >= length - 0.05 ? 0 : headRef.current;
    playingRef.current = true;
    setPlaying(true);
    let frame = 0;
    while (playingRef.current) {
      const d = docRef.current;
      const at = clipAt(d, t);
      if (!at) break;
      const { clip: c, from, index } = at;
      await seek(video, at.source);
      video.playbackRate = c.speed;
      video.muted = d.muted || c.volume === 0;
      video.volume = Math.min(1, c.volume);
      try {
        await video.play();
      } catch {
        break;
      }
      const finished = await new Promise<boolean>((resolve) => {
        const step = () => {
          if (!playingRef.current) return resolve(false);
          const now = Math.min(from + clipLength(c), from + (video.currentTime - c.start) / c.speed);
          paint(now);
          if (++frame % 2 === 0) setPlayhead(now);
          if (video.currentTime >= c.end - 0.02 || video.ended) return resolve(true);
          nextTick(step);
        };
        nextTick(step);
      });
      video.pause();
      if (!finished) return;
      if (index + 1 >= docRef.current.clips.length) {
        setPlayhead(timelineLength(docRef.current));
        break;
      }
      t = clipStarts(docRef.current)[index + 1]!;
    }
    playingRef.current = false;
    setPlaying(false);
  };

  const goTo = (t: number) => {
    pause();
    setPlayhead(Math.max(0, Math.min(length, t)));
  };

  // ---- Editing.
  const split = (t = playhead) => {
    const next = splitAt(doc, t);
    if (next !== doc) change(() => next);
  };
  const removeChosen = () => {
    if (chosen?.kind === "clip") {
      if (doc.clips.length > 1) change((d) => removeClip(d, chosen.id));
      setChosen(null);
    } else if (chosen?.kind === "title") {
      change((d) => ({ ...d, titles: d.titles.filter((t) => t.id !== chosen.id) }));
      setChosen(null);
    }
  };
  const addTitle = () => {
    const t: Title = {
      id: clipId(),
      text: "Текст",
      at: Math.min(playhead, Math.max(0, length - 0.5)),
      until: Math.min(length, playhead + 3),
      x: 0.5,
      y: 0.82,
      size: 0.08,
      color: "#ffffff",
      font: "Manrope",
      bold: true,
      background: false,
      outline: true,
    };
    change((d) => ({ ...d, titles: [...d.titles, t] }));
    setChosen({ kind: "title", id: t.id });
    setPanel("text");
  };

  // ---- Pointer on the timeline.
  const timeAt = (clientX: number) => {
    const element = tracksRef.current!;
    const r = element.getBoundingClientRect();
    return Math.max(0, Math.min(length, (clientX - r.left + element.scrollLeft - HEADER) / pps));
  };
  const onRuler = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { k: "scrub" };
    goTo(timeAt(e.clientX));
  };
  const onClip = (e: ReactPointerEvent<HTMLDivElement>, id: string, index: number) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setChosen({ kind: "clip", id });
    setPanel("clip");
    const c = doc.clips[index]!;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (tool === "razor") {
      split(starts[index]! + x / pps);
      return;
    }
    if (x <= EDGE) drag.current = { k: "trim", id, edge: "start", x: e.clientX, from: c.start, start: h.now };
    else if (r.width - x <= EDGE) drag.current = { k: "trim", id, edge: "end", x: e.clientX, from: c.end, start: h.now };
    else drag.current = { k: "move", id, x: e.clientX, start: h.now };
  };
  const onTitle = (e: ReactPointerEvent<HTMLDivElement>, t: Title) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setChosen({ kind: "title", id: t.id });
    setPanel("text");
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const edge = x <= EDGE ? "at" : r.width - x <= EDGE ? "until" : "move";
    drag.current = { k: "title", id: t.id, edge, x: e.clientX, at: t.at, until: t.until, start: h.now };
  };
  const onTrackMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.k === "scrub") return goTo(timeAt(e.clientX));
    if (d.k === "move") return setDragX({ id: d.id, dx: e.clientX - d.x });
    if (d.k === "trim") {
      const c = docRef.current.clips.find((x) => x.id === d.id);
      if (!c) return;
      live((doc) => trimClip(doc, d.id, d.edge, d.from + ((e.clientX - d.x) / pps) * c.speed));
      return;
    }
    if (d.k === "title") {
      const dt = (e.clientX - d.x) / pps;
      const span = d.until - d.at;
      if (d.edge === "move") {
        const at = Math.max(0, Math.min(length - span, d.at + dt));
        live(setTitle(d.id, { at, until: at + span }));
      } else if (d.edge === "at") live(setTitle(d.id, { at: Math.max(0, Math.min(d.until - 0.2, d.at + dt)) }));
      else live(setTitle(d.id, { until: Math.min(length, Math.max(d.at + 0.2, d.until + dt)) }));
    }
  };
  const onTrackUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.k === "scrub" || d.k === "place") return;
    if (d.k === "move") {
      setDragX(null);
      const index = doc.clips.findIndex((c) => c.id === d.id);
      const c = doc.clips[index];
      if (!c || Math.abs(e.clientX - d.x) < 4) return;
      // The clip goes where its middle was let go, among the others' middles.
      const middle = starts[index]! + clipLength(c) / 2 + (e.clientX - d.x) / pps;
      const others = doc.clips.map((x, i) => ({ x, mid: starts[i]! + clipLength(x) / 2 })).filter(({ x }) => x.id !== d.id);
      const to = others.filter(({ mid }) => mid < middle).length;
      change((doc) => moveClip(doc, d.id, to));
      return;
    }
    settle(d.start);
  };

  // ---- A title dragged on the monitor.
  const onMonitorDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!title || !titlesAt(doc, playhead).some((t) => t.id === title.id)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { k: "place", id: title.id, x: e.clientX, y: e.clientY, tx: title.x, ty: title.y, start: h.now };
  };
  const onMonitorMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (d?.k !== "place") return;
    const r = e.currentTarget.getBoundingClientRect();
    live(setTitle(d.id, { x: Math.max(0, Math.min(1, d.tx + (e.clientX - d.x) / r.width)), y: Math.max(0, Math.min(1, d.ty + (e.clientY - d.y) / r.height)) }));
  };
  const onMonitorUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.k === "place") settle(d.start);
  };

  // ---- Keys, as video editors have them.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (isTyping(e.target) || exporting !== null) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1] ?? "";
    if (ctrl && letter === "Z") return (e.preventDefault(), setH((now) => (e.shiftKey ? redoOf(now) : undoOf(now))));
    if (ctrl && letter === "Y") return (e.preventDefault(), setH(redoOf));
    if (ctrl && letter === "K") return (e.preventDefault(), split());
    if (ctrl) return;
    if (e.code === "Space") return (e.preventDefault(), playing ? pause() : void play());
    if (letter === "S") return split();
    if (letter === "V") return setTool("select");
    if (letter === "C") return setTool("razor");
    if (letter === "T") return addTitle();
    if (letter === "K") return pause();
    if (letter === "J") return goTo(playhead - 5);
    if (letter === "L") return goTo(playhead + 5);
    if (e.key === "Delete" || e.key === "Backspace") return (e.preventDefault(), removeChosen());
    if (e.key === "ArrowLeft") return (e.preventDefault(), goTo(playhead - (e.shiftKey ? 1 : FRAME)));
    if (e.key === "ArrowRight") return (e.preventDefault(), goTo(playhead + (e.shiftKey ? 1 : FRAME)));
    if (e.key === "Home") return goTo(0);
    if (e.key === "End") return goTo(length);
    if (e.key === "Escape") return setChosen(null);
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);

  // ---- Done: the cut video recorded.
  const finish = async () => {
    pause();
    setProblem(null);
    const stop = new AbortController();
    abort.current = stop;
    setExporting(0);
    try {
      const q = QUALITIES.find((x) => x.id === quality) ?? QUALITIES[1]!;
      const { bytes, ext } = await exportVideo(src, doc, q, (part) => setExporting(part), stop.signal);
      const stem = name.replace(/\.[^.]+$/, "") || "видео";
      onDone(bytes, `${stem}.${ext}`);
    } catch (e) {
      if (!stop.signal.aborted) setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
      abort.current = null;
    }
  };

  // ---- The timeline's ruler.
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 70) ?? 600;
  const ticks = Array.from({ length: Math.floor(length / step) + 1 }, (_, i) => i * step);
  const thumbsFor = (start: number, end: number) => thumbs.map((url, i) => ({ url, at: ((i + 0.5) * meta.duration) / THUMBS })).filter(({ url, at }) => url && at >= start - meta.duration / THUMBS && at <= end);
  const waveFor = (start: number, end: number, w: number) => {
    if (peaks.length === 0) return "";
    const from = Math.floor((start / meta.duration) * peaks.length);
    const to = Math.max(from + 1, Math.ceil((end / meta.duration) * peaks.length));
    const part = peaks.slice(from, to);
    const bar = w / Math.max(1, part.length);
    return part.map((p, i) => `M${(i * bar).toFixed(1)} ${(20 - p * 18).toFixed(1)}V${(20 + p * 18).toFixed(1)}`).join("");
  };

  const adjust = (key: keyof VideoAdjust, value: number) => slide((d) => ({ ...d, adjust: { ...d.adjust, [key]: value } }));

  return (
    <div className="video-editor" role="dialog" aria-label="Видеоредактор">
      <video ref={videoRef} className="video-source" src={src} crossOrigin="anonymous" playsInline preload="auto" />
      <header className="video-top">
        <button type="button" className="video-button" onClick={onClose} disabled={exporting !== null}>
          <X size={16} aria-hidden /> Отмена
        </button>
        <span className="video-title">{name}</span>
        <div className="video-row">
          <button type="button" className="video-mini" aria-label="Назад" title="Назад (Ctrl+Z)" disabled={h.past.length === 0} onClick={() => setH(undoOf)}>
            <Undo2 size={16} aria-hidden />
          </button>
          <button type="button" className="video-mini" aria-label="Вперёд" title="Вперёд (Ctrl+Shift+Z)" disabled={h.future.length === 0} onClick={() => setH(redoOf)}>
            <Redo2 size={16} aria-hidden />
          </button>
        </div>
        <select className="video-select" aria-label="Качество" value={quality} onChange={(e) => setQuality(e.currentTarget.value)}>
          {QUALITIES.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </select>
        <button type="button" className="video-button primary" disabled={exporting !== null} onClick={() => void finish()}>
          Готово
        </button>
      </header>
      <div className="video-main">
        <aside className="video-side">
          <div className="video-tabs" role="tablist" aria-label="Панели">
            {PANELS.map((p) => (
              <button key={p.id} type="button" role="tab" className="video-tab" aria-selected={panel === p.id} onClick={() => setPanel(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
          <div className="video-panel">
            {panel === "clip" &&
              (clip ? (
                <>
                  <p className="video-label">Скорость</p>
                  <div className="video-chips">
                    {SPEEDS.map((s) => (
                      <button key={s} type="button" className="video-chip" aria-pressed={clip.speed === s} onClick={() => change((d) => setSpeed(d, clip.id, s))}>
                        {String(s).replace(".", ",")}×
                      </button>
                    ))}
                  </div>
                  <label className="video-slider">
                    <span className="video-slider-head">
                      <span>Громкость клипа</span>
                      <span>{Math.round(clip.volume * 100)}%</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={Math.round(clip.volume * 100)}
                      aria-label="Громкость клипа"
                      onChange={(e) => {
                        const volume = Number(e.currentTarget.value) / 100;
                        slide((d) => ({ ...d, clips: d.clips.map((c) => (c.id === clip.id ? { ...c, volume } : c)) }));
                      }}
                      onPointerUp={slid}
                      onKeyUp={slid}
                    />
                  </label>
                  <p className="video-hint">
                    {timeLabel(clip.start)} – {timeLabel(clip.end)} видео · {timeLabel(clipLength(clip))} в ролике
                  </p>
                  <div className="video-chips">
                    <button type="button" className="video-chip" onClick={() => split()}>
                      <Scissors size={14} aria-hidden /> Разрезать по курсору
                    </button>
                    <button
                      type="button"
                      className="video-chip"
                      onClick={() =>
                        change((d) => {
                          const i = d.clips.findIndex((c) => c.id === clip.id);
                          const clips = d.clips.slice();
                          clips.splice(i + 1, 0, { ...clip, id: clipId() });
                          return { ...d, clips };
                        })
                      }
                    >
                      <Plus size={14} aria-hidden /> Копия
                    </button>
                    <button type="button" className="video-chip danger" disabled={doc.clips.length <= 1} onClick={removeChosen}>
                      <Trash2 size={14} aria-hidden /> Удалить клип
                    </button>
                  </div>
                </>
              ) : (
                <p className="video-hint">
                  Нажми на клип на дорожке, чтобы выбрать его. Лезвием (C) или клавишей S видео режется на клипы: лишнее удаляется (Delete), клипы
                  перетаскиваются, края тянутся, у каждого своя скорость и громкость.
                </p>
              ))}
            {panel === "text" && (
              <>
                <button type="button" className="video-button wide" onClick={addTitle}>
                  <Type size={16} aria-hidden /> Добавить текст (T)
                </button>
                {title ? (
                  <>
                    <textarea
                      className="video-text"
                      aria-label="Текст титра"
                      value={title.text}
                      rows={3}
                      onChange={(e) => slide(setTitle(title.id, { text: e.currentTarget.value.slice(0, 300) }))}
                      onBlur={slid}
                    />
                    <label className="video-slider">
                      <span className="video-slider-head">
                        <span>Размер</span>
                        <span>{Math.round(title.size * 100)}</span>
                      </span>
                      <input type="range" min={3} max={25} value={Math.round(title.size * 100)} aria-label="Размер текста" onChange={(e) => slide(setTitle(title.id, { size: Number(e.currentTarget.value) / 100 }))} onPointerUp={slid} onKeyUp={slid} />
                    </label>
                    <div className="video-chips">
                      {TITLE_COLORS.map((c) => (
                        <button key={c} type="button" className="video-swatch" aria-label={`Цвет ${c}`} aria-pressed={title.color === c} style={{ background: c }} onClick={() => change(setTitle(title.id, { color: c }))} />
                      ))}
                      <input type="color" className="video-color" aria-label="Свой цвет" value={title.color} onChange={(e) => slide(setTitle(title.id, { color: e.currentTarget.value }))} onBlur={slid} />
                    </div>
                    <select className="video-select" aria-label="Шрифт текста" value={title.font} onChange={(e) => change(setTitle(title.id, { font: e.currentTarget.value }))}>
                      {FONTS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                    <div className="video-chips">
                      <label className="video-check">
                        <input type="checkbox" checked={title.bold} onChange={(e) => change(setTitle(title.id, { bold: e.currentTarget.checked }))} /> Жирный
                      </label>
                      <label className="video-check">
                        <input type="checkbox" checked={title.outline} onChange={(e) => change(setTitle(title.id, { outline: e.currentTarget.checked }))} /> Обводка
                      </label>
                      <label className="video-check">
                        <input type="checkbox" checked={title.background} onChange={(e) => change(setTitle(title.id, { background: e.currentTarget.checked }))} /> Подложка
                      </label>
                    </div>
                    <div className="video-chips">
                      {(
                        [
                          ["Вверху", 0.15],
                          ["По центру", 0.5],
                          ["Внизу", 0.82],
                        ] as const
                      ).map(([label, y]) => (
                        <button key={label} type="button" className="video-chip" onClick={() => change(setTitle(title.id, { x: 0.5, y }))}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="video-hint">
                      Показывается {timeLabel(title.at)} – {timeLabel(title.until)}. Тяни его на дорожке «Текст» или прямо на видео.
                    </p>
                    <div className="video-chips">
                      <button type="button" className="video-chip" onClick={() => change(setTitle(title.id, { at: Math.min(playhead, title.until - 0.2) }))}>
                        Начало — с курсора
                      </button>
                      <button type="button" className="video-chip" onClick={() => change(setTitle(title.id, { until: Math.max(playhead, title.at + 0.2) }))}>
                        Конец — по курсор
                      </button>
                      <button type="button" className="video-chip danger" onClick={removeChosen}>
                        <Trash2 size={14} aria-hidden /> Удалить
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="video-hint">Текст появится с места, где стоит курсор, на 3 секунды. Его время меняется на дорожке «Текст».</p>
                )}
              </>
            )}
            {panel === "frame" && (
              <>
                <p className="video-label">Форма кадра</p>
                <div className="video-chips">
                  {ASPECTS.map((a) => (
                    <button key={a.id} type="button" className="video-chip" aria-pressed={doc.aspect === a.id} onClick={() => change((d) => ({ ...d, aspect: a.id }))}>
                      {a.name}
                    </button>
                  ))}
                </div>
                <div className="video-chips">
                  <button type="button" className="video-chip" aria-pressed={doc.fit === "fill"} onClick={() => change((d) => ({ ...d, fit: "fill" }))}>
                    Заполнить кадр
                  </button>
                  <button type="button" className="video-chip" aria-pressed={doc.fit === "fit"} onClick={() => change((d) => ({ ...d, fit: "fit" }))}>
                    Вписать целиком
                  </button>
                </div>
                <p className="video-label">Поворот</p>
                <div className="video-chips">
                  <button type="button" className="video-chip" onClick={() => change((d) => ({ ...d, turn: ((d.turn + 3) % 4) as VideoDoc["turn"] }))}>
                    <RotateCcw size={14} aria-hidden /> Влево
                  </button>
                  <button type="button" className="video-chip" onClick={() => change((d) => ({ ...d, turn: ((d.turn + 1) % 4) as VideoDoc["turn"] }))}>
                    <RotateCw size={14} aria-hidden /> Вправо
                  </button>
                  <button type="button" className="video-chip" aria-pressed={doc.flipX} onClick={() => change((d) => ({ ...d, flipX: !d.flipX }))}>
                    <FlipHorizontal2 size={14} aria-hidden /> Отразить
                  </button>
                </div>
                <p className="video-hint">
                  Итог: {outputSize(doc, (QUALITIES.find((q) => q.id === quality) ?? QUALITIES[1]!).maxHeight).width} ×{" "}
                  {outputSize(doc, (QUALITIES.find((q) => q.id === quality) ?? QUALITIES[1]!).maxHeight).height}
                </p>
              </>
            )}
            {panel === "color" && (
              <>
                <p className="video-label">Фильтр</p>
                <div className="video-chips">
                  {VIDEO_FILTERS.map((f) => (
                    <button key={f.id} type="button" className="video-chip" aria-pressed={doc.filter === f.id} onClick={() => change((d) => ({ ...d, filter: f.id }))}>
                      {f.name}
                    </button>
                  ))}
                </div>
                {(
                  [
                    ["brightness", "Яркость", -100, 100],
                    ["contrast", "Контраст", -100, 100],
                    ["saturation", "Насыщенность", -100, 100],
                    ["hue", "Тон", -180, 180],
                  ] as const
                ).map(([key, label, min, max]) => (
                  <label key={key} className="video-slider" onDoubleClick={() => change((d) => ({ ...d, adjust: { ...d.adjust, [key]: 0 } }))}>
                    <span className="video-slider-head">
                      <span>{label}</span>
                      <span>{doc.adjust[key]}</span>
                    </span>
                    <input type="range" min={min} max={max} value={doc.adjust[key]} aria-label={label} onChange={(e) => adjust(key, Number(e.currentTarget.value))} onPointerUp={slid} onKeyUp={slid} />
                  </label>
                ))}
                <button type="button" className="video-link" onClick={() => change((d) => ({ ...d, adjust: { ...NO_VIDEO_ADJUST }, filter: "none" }))}>
                  Сбросить цвет
                </button>
              </>
            )}
            {panel === "sound" && (
              <>
                <label className="video-check">
                  <input type="checkbox" checked={doc.muted} onChange={(e) => change((d) => ({ ...d, muted: e.currentTarget.checked }))} /> Без звука
                </label>
                {(
                  [
                    ["fadeIn", "Появление из чёрного"],
                    ["fadeOut", "Затухание в чёрное"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="video-slider">
                    <span className="video-slider-head">
                      <span>{label}</span>
                      <span>{doc[key].toFixed(1).replace(".", ",")} с</span>
                    </span>
                    <input type="range" min={0} max={50} value={Math.round(doc[key] * 10)} aria-label={label} onChange={(e) => slide((d) => ({ ...d, [key]: Number(e.currentTarget.value) / 10 }))} onPointerUp={slid} onKeyUp={slid} />
                  </label>
                ))}
                <p className="video-hint">Громкость каждого клипа (до 200%) — на вкладке «Клип». Звук плавно появляется и затихает вместе с картинкой.</p>
              </>
            )}
          </div>
        </aside>
        <section className="video-monitor">
          <div className="video-screen">
            <canvas ref={monitorRef} className="video-canvas" onPointerDown={onMonitorDown} onPointerMove={onMonitorMove} onPointerUp={onMonitorUp} />
          </div>
          <div className="video-transport">
            <button type="button" className="video-mini" aria-label="В начало" title="В начало (Home)" onClick={() => goTo(0)}>
              <SkipBack size={16} aria-hidden />
            </button>
            <button type="button" className="video-play" aria-label={playing ? "Пауза" : "Играть"} title="Играть / пауза (пробел)" onClick={() => (playing ? pause() : void play())}>
              {playing ? <Pause size={20} aria-hidden /> : <Play size={20} aria-hidden />}
            </button>
            <button type="button" className="video-mini" aria-label="В конец" title="В конец (End)" onClick={() => goTo(length)}>
              <SkipForward size={16} aria-hidden />
            </button>
            <span className="video-time">
              {timeLabel(playhead)} / {timeLabel(length)}
            </span>
          </div>
        </section>
      </div>
      <div className="video-timeline">
        <div className="video-timeline-bar" role="toolbar" aria-label="Монтаж">
          <button type="button" className="video-mini" aria-label="Выделение" title="Выделение (V)" aria-pressed={tool === "select"} onClick={() => setTool("select")}>
            <MousePointer2 size={16} aria-hidden />
          </button>
          <button type="button" className="video-mini" aria-label="Лезвие" title="Лезвие: режет клип там, где нажмёшь (C)" aria-pressed={tool === "razor"} onClick={() => setTool("razor")}>
            <Slice size={16} aria-hidden />
          </button>
          <span className="video-sep" />
          <button type="button" className="video-chip" onClick={() => split()}>
            <Scissors size={14} aria-hidden /> Разрезать (S)
          </button>
          <button type="button" className="video-chip" disabled={!chosen} onClick={removeChosen}>
            <Trash2 size={14} aria-hidden /> Удалить
          </button>
          <button type="button" className="video-chip" onClick={addTitle}>
            <Type size={14} aria-hidden /> Текст
          </button>
          <span className="video-spacer" />
          <button type="button" className="video-mini" aria-label="Мельче" onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>
            <ZoomOut size={16} aria-hidden />
          </button>
          <button type="button" className="video-mini" aria-label="Крупнее" onClick={() => setZoom((z) => Math.min(40, z * 1.5))}>
            <ZoomIn size={16} aria-hidden />
          </button>
        </div>
        <div ref={tracksRef} className="video-tracks" onPointerMove={onTrackMove} onPointerUp={onTrackUp} onPointerCancel={onTrackUp}>
          <div className="video-tracks-inner" style={{ width: HEADER + length * pps + 24 }}>
            <div className="video-ruler" onPointerDown={onRuler}>
              {ticks.map((t) => (
                <span key={t} className="video-tick" style={{ left: HEADER + t * pps }}>
                  {timeLabel(t).replace(/\.0$/, "")}
                </span>
              ))}
            </div>
            <div className="video-track" onPointerDown={onRuler}>
              <span className="video-track-name">V1</span>
              {doc.clips.map((c, i) => {
                const w = clipLength(c) * pps;
                const moving = dragX?.id === c.id;
                return (
                  <div
                    key={c.id}
                    className={`video-clip${chosen?.id === c.id ? " chosen" : ""}${tool === "razor" ? " razor" : ""}${moving ? " moving" : ""}`}
                    style={{ left: HEADER + starts[i]! * pps + (moving ? dragX.dx : 0), width: w }}
                    role="button"
                    aria-label={`Клип ${i + 1}`}
                    onPointerDown={(e) => onClip(e, c.id, i)}
                  >
                    <span className="video-clip-frames">
                      {thumbsFor(c.start, c.end).map(({ url, at }) => (
                        <img key={at} src={url} alt="" draggable={false} />
                      ))}
                    </span>
                    <span className="video-clip-label">
                      {c.speed !== 1 && <b>{String(c.speed).replace(".", ",")}×</b>}
                      {c.volume === 0 && <VolumeX size={12} aria-hidden />}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="video-track titles" onPointerDown={onRuler}>
              <span className="video-track-name">T1</span>
              {doc.titles.map((t) => (
                <div
                  key={t.id}
                  className={`video-title-block${chosen?.id === t.id ? " chosen" : ""}`}
                  style={{ left: HEADER + t.at * pps, width: Math.max(6, (t.until - t.at) * pps) }}
                  role="button"
                  aria-label={`Текст «${t.text}»`}
                  onPointerDown={(e) => onTitle(e, t)}
                  onDoubleClick={() => setPanel("text")}
                >
                  {t.text}
                </div>
              ))}
            </div>
            <div className="video-track sound" onPointerDown={onRuler}>
              <span className="video-track-name">{doc.muted ? <VolumeX size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}</span>
              {doc.clips.map((c, i) => {
                const w = clipLength(c) * pps;
                return (
                  <svg key={c.id} className={`video-wave${doc.muted || c.volume === 0 ? " silent" : ""}`} style={{ left: HEADER + starts[i]! * pps, width: w }} viewBox={`0 0 ${Math.max(1, w)} 40`} preserveAspectRatio="none" aria-hidden>
                    <path d={waveFor(c.start, c.end, w)} />
                  </svg>
                );
              })}
            </div>
            <div className="video-playhead" style={{ left: HEADER + playhead * pps }} aria-hidden />
          </div>
        </div>
      </div>
      {exporting !== null && (
        <div className="video-export" role="dialog" aria-label="Сохранение видео">
          <div className="video-export-card">
            <b>Сохраняю видео… {Math.round(exporting * 100)}%</b>
            <div className="video-export-bar">
              <span style={{ width: `${exporting * 100}%` }} />
            </div>
            <p className="video-hint">Ролик проигрывается и записывается, поэтому это занимает примерно столько, сколько он длится ({timeLabel(length)}).</p>
            <button type="button" className="video-button" onClick={() => abort.current?.abort()}>
              Остановить
            </button>
          </div>
        </div>
      )}
      {problem && (
        <div className="video-problem" role="alert">
          {problem}
          <button type="button" className="video-mini" aria-label="Закрыть" onClick={() => setProblem(null)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

function undoOf(h: History): History {
  const before = h.past[h.past.length - 1];
  return before ? { past: h.past.slice(0, -1), now: before, future: [h.now, ...h.future] } : h;
}

function redoOf(h: History): History {
  const after = h.future[0];
  return after ? { past: [...h.past, h.now], now: after, future: h.future.slice(1) } : h;
}
