import { useEffect, useRef, useState, type ReactElement } from "react";
import { ArrowLeft, Check, Copy, Hand, Pause, Play, Plus, RotateCcw, Undo2, X } from "lucide-react";
import type { Clip } from "../../characters/clip";
import { poseOfClip } from "../../characters/clipEdit";
import type { JointName, Pose } from "../../characters/motion";
import {
  ARM_PRESETS,
  armsReach,
  BODY_PRESETS,
  defaultSpec,
  HEAD_PRESETS,
  LEGS_PRESETS,
  partsToPose,
  type ArmPlace,
  type BodyPart,
  type PoseSpec,
  type Preset,
} from "../../characters/poseSpec";
import type { WorkshopStage } from "../../characters/workshopStage";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Slider } from "../../ui/Slider";
import { bakePoses, GAPS } from "./emotions";
import { useWorkshopStage } from "./useStage";
import { IS_MOBILE } from "../../platform";

const PARTS: { id: BodyPart; name: string; joints: JointName[] }[] = [
  { id: "head", name: "Голова", joints: ["head"] },
  { id: "armR", name: "Правая рука", joints: ["handR"] },
  { id: "armL", name: "Левая рука", joints: ["handL"] },
  { id: "body", name: "Корпус", joints: ["chest"] },
  { id: "legs", name: "Ноги", joints: ["shinL", "shinR"] },
];

// Left and right are the character's own, as on its labels: tilt and lean above 0 go to its right shoulder.

/** The right arm of a stick figure for each preset: elbow and hand, on a 60×70 picture. */
const ARM_PICTURE: Record<string, [[number, number], [number, number]]> = {
  down: [[22, 34], [19, 44]],
  side: [[19, 25], [8, 25]],
  forward: [[24, 27], [20, 29]],
  up: [[22, 15], [19, 3]],
  wave: [[16, 25], [14, 10]],
  hip: [[19, 33], [27, 41]],
  face: [[20, 31], [26, 15]],
  chest: [[22, 31], [32, 31]],
};

function ArmFigure({ id, left }: { id: string; left: boolean }) {
  const [[ex, ey], [hx, hy]] = ARM_PICTURE[id] ?? ARM_PICTURE.down!;
  return (
    <svg viewBox="0 0 60 70" className={left ? "pb-figure flip" : "pb-figure"} aria-hidden>
      <circle cx="30" cy="12" r="7" />
      <line x1="30" y1="19" x2="30" y2="44" />
      <line x1="30" y1="44" x2="22" y2="64" />
      <line x1="30" y1="44" x2="38" y2="64" />
      <line x1="30" y1="24" x2="40" y2="40" />
      <polyline className="arm" points={`30,24 ${ex},${ey} ${hx},${hy}`} />
      {id === "forward" && <circle className="hand" cx={hx} cy={hy} r="3.5" />}
    </svg>
  );
}

/** A pose's whole body on this stage: the parts turned, the hands reaching their places (elbows bend the natural way). */
function poseOn(stage: WorkshopStage | null, spec: PoseSpec): Pose {
  const parts = partsToPose(spec);
  if (!stage) return parts;
  stage.setPose(parts);
  return stage.reachPose(armsReach(spec)) ?? parts;
}

const pct = (v: number) => Math.round(v * 100);
const side = (v: number, minus: string, plus: string, zero: string) => (v > 5 ? plus : v < -5 ? minus : zero);

type Props = {
  initial: { poses: PoseSpec[]; gap: number } | null;
  onDone: (poses: PoseSpec[], gap: number, clip: Clip) => void;
  onCancel: () => void;
  onAdvanced: () => void;
};

/**
 * «Своя поза» without pulling points: a body part is picked on the character, then a ready position for it in a
 * picture, then sliders move it within what a body can do. Poses stand in a row below; the motion flows between them.
 */
export function PoseBuilder({ initial, onDone, onCancel, onAdvanced }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { stage, no3d, ready } = useWorkshopStage(canvas);
  const [poses, setPoses] = useState<PoseSpec[]>(() => initial?.poses.map((p) => structuredClone(p)) ?? [defaultSpec()]);
  const [gap, setGap] = useState(initial?.gap ?? 0.6);
  const [sel, setSel] = useState(0);
  const [part, setPart] = useState<BodyPart>("armR");
  const [undo, setUndo] = useState<{ poses: PoseSpec[]; sel: number }[]>([]);
  const [spots, setSpots] = useState<Partial<Record<BodyPart, { x: number; y: number }>>>({});
  const [bodyReady, setBodyReady] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState(false);
  const lastPush = useRef(0);
  const spec = poses[Math.min(sel, poses.length - 1)]!;

  // Labels over the body follow it as the camera turns; the first label found means the body has come.
  useEffect(() => {
    const timer = setInterval(() => {
      const s = stage.current;
      if (!s) return;
      const next: Partial<Record<BodyPart, { x: number; y: number }>> = {};
      for (const p of PARTS) {
        const points = p.joints.map((j) => s.screenOf(j)).filter((v): v is { x: number; y: number } => v !== null);
        if (points.length) next[p.id] = { x: points.reduce((a, v) => a + v.x, 0) / points.length, y: points.reduce((a, v) => a + v.y, 0) / points.length };
      }
      if (next.head) setBodyReady(true);
      setSpots(next);
    }, 100);
    return () => clearInterval(timer);
  }, [stage]);

  // Pictures for every card once the body has come (poses opened for a change have none yet).
  useEffect(() => {
    const s = stage.current;
    if (!s || !bodyReady) return;
    const made: Record<string, string> = {};
    for (const p of poses) {
      const key = JSON.stringify(p);
      if (thumbs[key] || made[key]) continue;
      poseOn(s, p);
      const url = s.snapshot();
      if (url) made[key] = url;
    }
    poseOn(s, spec);
    if (Object.keys(made).length) setThumbs((all) => ({ ...all, ...made }));
    // Only when the body comes.
  }, [bodyReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chosen pose on the stage, and its card's picture once drawn.
  useEffect(() => {
    if (playing || !ready) return;
    const s = stage.current;
    poseOn(s, spec);
    const key = JSON.stringify(spec);
    if (!bodyReady || thumbs[key]) return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const url = stage.current?.snapshot();
        if (url) setThumbs((all) => ({ ...all, [key]: url }));
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [spec, playing, ready, bodyReady, stage, thumbs]);

  // ▶: the poses as they will play in the emotion, once.
  useEffect(() => {
    if (!playing) return;
    const s = stage.current;
    const clip = bakePoses(poses.map((p) => poseOn(s, p)), gap);
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      if (t > clip.duration + 0.3) {
        setPlaying(false);
        return;
      }
      s?.setPose(poseOfClip(clip, Math.min(t, clip.duration)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Changes the chosen pose; a run of quick changes (a slider being dragged) is undone at once. */
  const edit = (change: (p: PoseSpec) => PoseSpec) => {
    const now = performance.now();
    if (now - lastPush.current > 700) setUndo((list) => [...list.slice(-40), { poses, sel }]);
    lastPush.current = now;
    setPoses((list) => list.map((p, i) => (i === sel ? change(structuredClone(p)) : p)));
  };
  const setArm = (arm: "armR" | "armL", patch: Partial<ArmPlace>) => edit((p) => ({ ...p, [arm]: { ...p[arm], ...patch } }));

  const addPose = () => {
    setUndo((list) => [...list.slice(-40), { poses, sel }]);
    const next = [...poses];
    next.splice(sel + 1, 0, structuredClone(spec));
    setPoses(next.slice(0, 30));
    setSel(Math.min(sel + 1, 29));
  };
  const removePose = (i: number) => {
    if (poses.length <= 1) return;
    setUndo((list) => [...list.slice(-40), { poses, sel }]);
    setPoses(poses.filter((_, k) => k !== i));
    setSel(Math.max(0, Math.min(sel, poses.length - 2)));
  };
  const back = () => {
    const last = undo[undo.length - 1];
    if (!last) return;
    setPoses(last.poses);
    setSel(last.sel);
    setUndo(undo.slice(0, -1));
  };
  const done = () => {
    const s = stage.current;
    const clip = bakePoses(poses.map((p) => poseOn(s, p)), gap);
    onDone(poses, gap, clip);
  };

  const presets = <T,>(list: Preset<T>[], current: T, apply: (value: T) => void, picture?: (id: string) => ReactElement) => (
    <div className={picture ? "pb-presets pictures" : "pb-presets"}>
      {list.map((p) => {
        const on = JSON.stringify(p.value) === JSON.stringify(current);
        return (
          <button key={p.id} type="button" className={on ? "pb-preset on" : "pb-preset"} aria-pressed={on} onClick={() => apply(structuredClone(p.value))}>
            {picture?.(p.id)}
            <span>{p.name}</span>
          </button>
        );
      })}
    </div>
  );

  const partName = PARTS.find((p) => p.id === part)!.name;
  let panel: ReactElement;
  if (part === "armR" || part === "armL") {
    const arm = part;
    const other = arm === "armR" ? "armL" : "armR";
    const place = spec[arm];
    const fist = arm === "armR" ? "fistR" : "fistL";
    panel = (
      <>
        {presets(ARM_PRESETS, place, (value: ArmPlace) => setArm(arm, value), (id) => <ArmFigure id={id} left={arm === "armL"} />)}
        <Slider label="Поднять" min={0} max={100} value={pct(place.raise)} format={(v) => (v < 15 ? "опущена" : v > 85 ? "вверх" : v > 40 && v < 60 ? "до плеча" : `${v}%`)} onChange={(v) => setArm(arm, { raise: v / 100 })} />
        <Slider label="Вперёд или в сторону" min={-60} max={100} value={pct(place.side)} format={(v) => (v < -10 ? "к груди" : v < 25 ? "вперёд" : v > 75 ? "в сторону" : "наискось")} onChange={(v) => setArm(arm, { side: v / 100 })} />
        <Slider label="Согнуть локоть" min={0} max={85} value={pct(place.bend)} format={(v) => (v < 10 ? "прямо" : v > 65 ? "сильно" : "немного")} onChange={(v) => setArm(arm, { bend: v / 100 })} />
        <div className="pb-row">
          <Button className={spec[fist] ? "pb-on" : ""} aria-pressed={spec[fist]} onClick={() => edit((p) => ({ ...p, [fist]: !p[fist] }))}>
            <Hand size={15} /> {spec[fist] ? "Кулак" : "Ладонь"}
          </Button>
          <Button onClick={() => edit((p) => ({ ...p, [other]: { ...p[arm] }, [other === "armR" ? "fistR" : "fistL"]: p[fist] }))}>
            <Copy size={15} /> Так же другой рукой
          </Button>
        </div>
      </>
    );
  } else if (part === "head") {
    const h = spec.head;
    panel = (
      <>
        {presets(HEAD_PRESETS, h, (head: PoseSpec["head"]) => edit((p) => ({ ...p, head })))}
        <Slider label="Повернуть" min={-100} max={100} value={-pct(h.turn)} format={(v) => side(v, "влево", "вправо", "прямо")} onChange={(v) => edit((p) => ({ ...p, head: { ...p.head, turn: -v / 100 } }))} />
        <Slider label="Кивнуть или поднять" min={-100} max={100} value={pct(h.nod)} format={(v) => side(v, "вверх", "вниз", "прямо")} onChange={(v) => edit((p) => ({ ...p, head: { ...p.head, nod: v / 100 } }))} />
        <Slider label="Наклонить к плечу" min={-100} max={100} value={pct(h.tilt)} format={(v) => side(v, "к левому", "к правому", "прямо")} onChange={(v) => edit((p) => ({ ...p, head: { ...p.head, tilt: v / 100 } }))} />
      </>
    );
  } else if (part === "body") {
    const b = spec.body;
    panel = (
      <>
        {presets(BODY_PRESETS, b, (body: PoseSpec["body"]) => edit((p) => ({ ...p, body })))}
        <Slider label="Наклониться" min={-100} max={100} value={pct(b.bend)} format={(v) => side(v, "назад", "вперёд", "прямо")} onChange={(v) => edit((p) => ({ ...p, body: { ...p.body, bend: v / 100 } }))} />
        <Slider label="Повернуться" min={-100} max={100} value={-pct(b.turn)} format={(v) => side(v, "влево", "вправо", "прямо")} onChange={(v) => edit((p) => ({ ...p, body: { ...p.body, turn: -v / 100 } }))} />
        <Slider label="Вбок" min={-100} max={100} value={pct(b.lean)} format={(v) => side(v, "влево", "вправо", "прямо")} onChange={(v) => edit((p) => ({ ...p, body: { ...p.body, lean: v / 100 } }))} />
      </>
    );
  } else {
    const l = spec.legs;
    panel = (
      <>
        {presets(LEGS_PRESETS, l, (legs: PoseSpec["legs"]) => edit((p) => ({ ...p, legs })))}
        <Slider label="Присесть" min={0} max={100} value={pct(l.crouch)} format={(v) => `${v}%`} onChange={(v) => edit((p) => ({ ...p, legs: { ...p.legs, crouch: v / 100 } }))} />
        <Slider label="Шаг" min={-100} max={100} value={pct(l.step)} format={(v) => side(v, "левой вперёд", "правой вперёд", "нет")} onChange={(v) => edit((p) => ({ ...p, legs: { ...p.legs, step: v / 100 } }))} />
        <Slider label="Ноги шире" min={0} max={100} value={pct(l.wide)} format={(v) => `${v}%`} onChange={(v) => edit((p) => ({ ...p, legs: { ...p.legs, wide: v / 100 } }))} />
        <Slider label="Колено вверх" min={0} max={100} value={pct(l.knee)} format={(v) => `${v}%`} onChange={(v) => edit((p) => ({ ...p, legs: { ...p.legs, knee: v / 100 } }))} />
      </>
    );
  }

  const reset = () =>
    edit((p) => {
      const d = defaultSpec();
      if (part === "armR") return { ...p, armR: d.armR, fistR: false };
      if (part === "armL") return { ...p, armL: d.armL, fistL: false };
      return { ...p, [part]: d[part] };
    });

  return (
    <>
      <header className="workshop-head wiz-head">
        <IconButton label="Назад, без этой позы" onClick={onCancel}>
          <ArrowLeft size={18} />
        </IconButton>
        <h1>Своя поза</h1>
        <span className="wiz-spacer" />
        <Button disabled={undo.length === 0} onClick={back}>
          <Undo2 size={15} /> Отменить
        </Button>
        <Button title="Старый способ: тянуть точки на персонаже. Эта поза не сохранится" onClick={onAdvanced}>
          {IS_MOBILE ? "Тянуть точки пальцем" : "Тянуть точки мышью"}
        </Button>
        <Button variant="primary" onClick={done}>
          <Check size={15} /> Готово
        </Button>
      </header>
      <div className="pb-body">
        <section className="wiz-stage pb-stage">
          {no3d ? <p className="hint character-no3d">Этот ПК не рисует 3D: позу видно не будет.</p> : <canvas ref={canvas} className="animator-canvas" aria-label="Персонаж в позе. Мышью можно вращать камеру" />}
          {!playing &&
            PARTS.map((p) => {
              const at = spots[p.id];
              if (!at) return null;
              return (
                <button key={p.id} type="button" className={`pb-part pb-at-${p.id}${part === p.id ? " on" : ""}`} style={{ left: at.x, top: at.y }} aria-pressed={part === p.id} onClick={() => setPart(p.id)}>
                  {p.name}
                </button>
              );
            })}
          <p className="wiz-bubble pb-hint">Нажми на часть тела, потом выбери, как ей стоять</p>
        </section>
        <aside className="pb-panel" aria-label={partName}>
          <div className="pb-parts" role="tablist" aria-label="Часть тела">
            {PARTS.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={part === p.id} className={part === p.id ? "on" : ""} onClick={() => setPart(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
          <h2>{partName}</h2>
          {panel}
          <Button className="pb-reset" onClick={reset}>
            <RotateCcw size={15} /> Сбросить: {partName.toLowerCase()}
          </Button>
        </aside>
        <section className="pb-strip" aria-label="Позы по очереди">
          <div className="pb-cards">
            {poses.map((p, i) => {
              const thumb = thumbs[JSON.stringify(p)];
              return (
                <div key={i} className="pb-card-wrap">
                  {i > 0 && <span className="pb-gap">{GAPS.find((g) => g.value === gap)?.label ?? ""}</span>}
                  <div className={i === sel ? "pb-card on" : "pb-card"}>
                    <button type="button" className="pb-card-pick" aria-label={`Поза ${i + 1}`} onClick={() => (setPlaying(false), setSel(i))}>
                      {thumb ? <img src={thumb} alt="" /> : null}
                      <span className="pb-card-n">{i + 1}</span>
                    </button>
                    {i === sel && poses.length > 1 && (
                      <button type="button" className="pb-card-x" aria-label="Убрать эту позу" onClick={() => removePose(i)}>
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <button type="button" className="pb-card pb-new" disabled={poses.length >= 30} onClick={addPose}>
              <Plus size={20} aria-hidden />
              <span>Новая поза</span>
            </button>
          </div>
          <div className="pb-strip-end">
            <span className="wiz-seg" role="radiogroup" aria-label="Между позами">
              {GAPS.map((g) => (
                <button key={g.value} type="button" role="radio" aria-checked={gap === g.value} className={gap === g.value ? "on" : ""} onClick={() => setGap(g.value)}>
                  {g.label}
                </button>
              ))}
            </span>
            <Button disabled={poses.length < 2} title={poses.length < 2 ? "Добавь вторую позу, чтобы было движение" : undefined} onClick={() => setPlaying((on) => !on)}>
              {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? "Стоп" : "Проиграть"}
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}
