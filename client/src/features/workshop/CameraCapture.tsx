import { useEffect, useRef, useState } from "react";
import { Circle, RotateCcw, Save, ShieldCheck, Square, Video } from "lucide-react";
import { easePoints, readBody, readFace, trimKeys, type Landmark } from "../../characters/capture";
import { keyFromPose, MAX_DURATION, newClipId, type Clip, type ClipKey } from "../../characters/clip";
import { poseOfClip } from "../../characters/clipEdit";
import { defaultAvatarFor, parseAvatar } from "../../characters/gallery";
import { commitAvatar, useMyAvatar } from "../../characters/myAvatar";
import { usePrefs } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { Toggle } from "../../ui/Toggle";
import { notify } from "../../ui/toasts";
import { useWorkshopStage } from "./useStage";

type Tracker = {
  pose: { detectForVideo(video: HTMLVideoElement, at: number): { landmarks: Landmark[][]; worldLandmarks: Landmark[][] }; close(): void };
  face: { detectForVideo(video: HTMLVideoElement, at: number): { faceBlendshapes: { categories: { categoryName: string; score: number }[] }[] }; close(): void } | null;
};

/** The tracker and its models, all from this program's own files: nothing is fetched from elsewhere. */
async function makeTracker(): Promise<Tracker> {
  const { PoseLandmarker, FaceLandmarker } = await import("../../vendor/mediapipe/vision_bundle.mjs");
  const files = { wasmLoaderPath: "/mediapipe/vision_wasm_internal.js", wasmBinaryPath: "/mediapipe/vision_wasm_internal.wasm" };
  const make = async <T,>(create: (delegate: "GPU" | "CPU") => Promise<T>) => {
    try {
      return await create("GPU");
    } catch {
      return await create("CPU");
    }
  };
  const pose = await make((delegate) => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: "/mediapipe/pose_landmarker_lite.task", delegate }, runningMode: "VIDEO", numPoses: 1 }));
  const face = await make((delegate) => FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate }, runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true })).catch(() => null);
  return { pose: pose as unknown as Tracker["pose"], face: face as unknown as Tracker["face"] };
}

/** The lines of a body drawn over the camera picture (MediaPipe's point numbers). */
const BONES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
];

/** Keys a second in a recording: as many as a clip built from ready motions. */
const RECORD_FPS = 15;
const SEEN_TEXT = { full: "Вижу тебя целиком", upper: "Вижу до пояса: ноги будут стоять", none: "Не вижу тебя: встань в кадр" };
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0").replace(".", ",")}`;

/**
 * «С камеры»: the character repeats what the camera sees, live; a press records it as a motion of mine. The picture and
 * the tracking stay on this PC.
 */
export function CameraCapture() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const { stage, no3d, me, ready } = useWorkshopStage(canvas);
  const setAvatar = useMyAvatar((s) => s.setAvatar);
  const setCharacter = usePrefs((s) => s.setCharacter);
  const code = usePrefs((s) => s.character);
  const [state, setState] = useState<"loading" | "live" | "nocamera" | "failed">("loading");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState<string>("");
  const [mirror, setMirror] = useState(true);
  const [seen, setSeen] = useState<keyof typeof SEEN_TEXT>("none");
  const [recording, setRecording] = useState<{ startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Clip | null>(null);
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [name, setName] = useState("Запись с камеры");
  const [saving, setSaving] = useState(false);
  const keys = useRef<ClipKey[]>([]);
  const live = useRef({ mirror, recording, take });
  live.current = { mirror, recording, take };

  // The camera.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let gone = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } }, audio: false })
      .then(async (got) => {
        if (gone) return got.getTracks().forEach((t) => t.stop());
        stream = got;
        if (video.current) {
          video.current.srcObject = got;
          await video.current.play().catch(() => {});
        }
        const all = await navigator.mediaDevices.enumerateDevices();
        setCameras(all.filter((d) => d.kind === "videoinput"));
      })
      .catch(() => setState("nocamera"));
    return () => {
      gone = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [cameraId]);

  // The tracker, and the character following it frame by frame.
  useEffect(() => {
    if (!ready) return;
    let tracker: Tracker | null = null;
    let frame = 0;
    let gone = false;
    let eased: Landmark[] | null = null;
    let lastVideoTime = -1;
    let lastKey = -Infinity;
    let count = 0;
    let face: ReturnType<typeof readFace> | null = null;
    const step = () => {
      frame = requestAnimationFrame(step);
      const v = video.current;
      if (!tracker || !v || v.readyState < 2 || v.currentTime === lastVideoTime || live.current.take) return;
      lastVideoTime = v.currentTime;
      const now = performance.now();
      const result = tracker.pose.detectForVideo(v, now);
      const world = result.worldLandmarks[0];
      if (world) eased = easePoints(eased, world, 0.55);
      const body = readBody(eased ?? undefined, live.current.mirror);
      setSeen((was) => (was === body.seen ? was : body.seen));
      // The face every other frame: it moves less than the arms.
      if (tracker.face && count++ % 2 === 0) {
        const shapes = tracker.face.detectForVideo(v, now).faceBlendshapes[0]?.categories;
        if (shapes) face = readFace(Object.fromEntries(shapes.map((c) => [c.categoryName, c.score])));
      }
      const pose = stage.current?.follow(body);
      if (pose && face) Object.assign(pose, face);
      drawOverlay(result.landmarks[0]);
      const rec = live.current.recording;
      if (pose && rec) {
        const t = (now - rec.startedAt) / 1000;
        if (t - lastKey >= 1 / RECORD_FPS - 0.004) {
          keys.current.push(keyFromPose(pose, Math.round(t * 1000) / 1000, "linear"));
          lastKey = t;
        }
        if (t >= MAX_DURATION) stop();
      } else {
        lastKey = -Infinity;
      }
    };
    makeTracker()
      .then((made) => {
        if (gone) return made.pose.close();
        tracker = made;
        setState((s) => (s === "nocamera" ? s : "live"));
        frame = requestAnimationFrame(step);
      })
      .catch(() => setState("failed"));
    return () => {
      gone = true;
      cancelAnimationFrame(frame);
      tracker?.pose.close();
      tracker?.face?.close();
    };
    // `stop` reads only refs.
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawOverlay = (points: Landmark[] | undefined) => {
    const c = overlay.current;
    const v = video.current;
    if (!c || !v) return;
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth || 640;
      c.height = v.videoHeight || 360;
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    if (!points) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#45e3a2";
    g.strokeStyle = accent;
    g.fillStyle = accent;
    g.lineWidth = Math.max(2, c.width / 240);
    g.lineCap = "round";
    for (const [a, b] of BONES) {
      const p = points[a]!;
      const q = points[b]!;
      if ((p.visibility ?? 1) < 0.5 || (q.visibility ?? 1) < 0.5) continue;
      g.beginPath();
      g.moveTo(p.x * c.width, p.y * c.height);
      g.lineTo(q.x * c.width, q.y * c.height);
      g.stroke();
    }
    for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      const p = points[i]!;
      if ((p.visibility ?? 1) < 0.5) continue;
      g.beginPath();
      g.arc(p.x * c.width, p.y * c.height, g.lineWidth * 1.6, 0, Math.PI * 2);
      g.fill();
    }
  };

  // The recording's clock.
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsed((performance.now() - recording.startedAt) / 1000), 100);
    return () => clearInterval(timer);
  }, [recording]);

  const start = () => {
    keys.current = [];
    setTake(null);
    setElapsed(0);
    setRecording({ startedAt: performance.now() });
  };

  function stop() {
    setRecording(null);
    const got = keys.current;
    if (got.length < 4) {
      notify.info("Слишком коротко: запиши хотя бы полсекунды");
      return;
    }
    const duration = got[got.length - 1]!.t;
    setTake({ id: newClipId(), name, emoji: "🎥", duration, loop: false, keys: got });
    setTrim([0, duration]);
  }

  // A finished take plays on the stage, between the trim marks, round and round.
  useEffect(() => {
    if (!take) return;
    let frame = 0;
    const began = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const length = Math.max(0.1, trim[1] - trim[0]);
      stage.current?.setPose(poseOfClip(take, trim[0] + (((now - began) / 1000) % length)));
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [take, trim, stage]);

  const save = async () => {
    if (!take) return;
    setSaving(true);
    try {
      const kept = trimKeys(take.keys, trim[0], trim[1]);
      if (kept.length < 2) throw new Error("после обрезки ничего не осталось");
      const clip: Clip = { ...take, name: name.trim() || "Запись с камеры", duration: kept[kept.length - 1]!.t, keys: kept };
      const avatar = useMyAvatar.getState().avatar;
      const look = parseAvatar(code)?.kind === "pack" ? null : code;
      const done = await commitAvatar({ ...avatar, clips: [clip, ...avatar.clips], base: avatar.base ?? look ?? defaultAvatarFor(me) });
      setAvatar(done.avatar);
      setCharacter(done.code);
      setTake(null);
      notify.info("Сохранено. Движение теперь в эмоциях звонка, друзья увидят его у себя");
    } catch (e) {
      notify.error(`Не сохранилось: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    } finally {
      setSaving(false);
    }
  };

  const status =
    state === "nocamera" ? "Камера не найдена или не разрешена" : state === "failed" ? "Не получилось запустить распознавание позы" : state === "loading" ? "Запускаю камеру и распознавание…" : SEEN_TEXT[seen];

  return (
    <div className="capture">
      <section className="capture-camera">
        <div className="capture-chips">
          {cameras.length > 1 ? (
            <select className="select capture-select" aria-label="Камера" value={cameraId} onChange={(e) => setCameraId(e.currentTarget.value)}>
              <option value="">Камера по умолчанию</option>
              {cameras.map((c, i) => (
                <option key={c.deviceId || i} value={c.deviceId}>
                  {c.label || `Камера ${i + 1}`}
                </option>
              ))}
            </select>
          ) : (
            <span className="capture-chip">
              <Video size={14} aria-hidden /> {cameras[0]?.label || "Камера"}
            </span>
          )}
          <span className={state === "live" && seen !== "none" ? "capture-chip on" : "capture-chip"} role="status">
            {status}
          </span>
        </div>
        <div className={mirror ? "capture-video mirrored" : "capture-video"}>
          <video ref={video} muted playsInline aria-label="Картинка с камеры" />
          <canvas ref={overlay} aria-hidden />
        </div>
        <p className="capture-private">
          <ShieldCheck size={14} aria-hidden /> Видео с камеры никуда не уходит: позу распознаёт этот ПК, а друзьям достаётся только готовое движение.
        </p>
      </section>

      <section className="capture-stage">
        <span className="capture-chip capture-chip-float">{take ? "Твоя запись" : "Повторяет в реальном времени"}</span>
        {no3d ? <p className="hint character-no3d">Этот ПК не рисует 3D.</p> : <canvas ref={canvas} className="animator-canvas" aria-label="Персонаж повторяет движения с камеры" />}
      </section>

      <section className="capture-bar">
        {take ? (
          <>
            <Button onClick={() => setTake(null)}>
              <RotateCcw size={15} /> Снять заново
            </Button>
            <div className="capture-trim">
              <span className="label">Обрезать</span>
              <input type="range" aria-label="Начало" min={0} max={take.duration} step={0.05} value={trim[0]} onChange={(e) => setTrim([Math.min(Number(e.currentTarget.value), trim[1] - 0.3), trim[1]])} />
              <input type="range" aria-label="Конец" min={0} max={take.duration} step={0.05} value={trim[1]} onChange={(e) => setTrim([trim[0], Math.max(Number(e.currentTarget.value), trim[0] + 0.3)])} />
              <span className="label">{clock(Math.max(0, trim[1] - trim[0]))}</span>
            </div>
            <input className="input capture-name" aria-label="Название движения" value={name} maxLength={32} onChange={(e) => setName(e.currentTarget.value)} />
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              <Save size={15} /> {saving ? "Сохраняю…" : "Сохранить"}
            </Button>
          </>
        ) : (
          <>
            <button type="button" className={recording ? "capture-record on" : "capture-record"} aria-label={recording ? "Остановить запись" : "Начать запись"} disabled={state !== "live"} onClick={() => (recording ? stop() : start())}>
              {recording ? <Square size={22} fill="currentColor" /> : <Circle size={26} fill="currentColor" />}
            </button>
            <div className="capture-text">
              <b>{recording ? `Записываю · ${clock(elapsed)}` : "Готов записывать"}</b>
              <span className="hint">Встань так, чтобы камера видела тебя по колени. Лицо тоже ловится. Запись до минуты.</span>
            </div>
            <span className="kit-spacer" />
            <Toggle label="Как в зеркале" checked={mirror} onChange={setMirror} />
          </>
        )}
      </section>
    </div>
  );
}
