import { useCallback, useEffect, useRef, useState } from "react";
import { FlipHorizontal2, Hand, Layers, Pause, Play, Plus, RotateCcw, RotateCw, Save, Trash2, Undo2, Upload, X } from "lucide-react";
import { emptyClip, type Clip } from "../../characters/clip";
import { mirrorAt, moveKey, poseOfClip, removeKey, editPose } from "../../characters/clipEdit";
import { FACE_LOOKS } from "../../characters/compose";
import { defaultAvatarFor, parseAvatar } from "../../characters/gallery";
import { ModelError } from "../../characters/glb";
import { JOINTS, restPose, type JointName, type Pose } from "../../characters/motion";
import { commitAvatar, useMyAvatar } from "../../characters/myAvatar";
import { READY_POSES, type StageMode } from "../../characters/workshopStage";
import { usePrefs } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { Emoji } from "../../ui/Emoji";
import { IconButton } from "../../ui/IconButton";
import { Toggle } from "../../ui/Toggle";
import { notify } from "../../ui/toasts";
import { useWorkshopStage } from "./useStage";
import { IS_MOBILE } from "../../platform";

const PART: Record<JointName, string> = {
  hips: "Таз",
  spine: "Живот",
  chest: "Грудь",
  neck: "Шея",
  head: "Голова",
  armL: "Левое плечо",
  foreL: "Левый локоть",
  handL: "Левая рука",
  armR: "Правое плечо",
  foreR: "Правый локоть",
  handR: "Правая рука",
  legL: "Левое бедро",
  shinL: "Левое колено",
  footL: "Левая нога",
  legR: "Правое бедро",
  shinR: "Правое колено",
  footR: "Правая нога",
};

const PULL_HINT: Partial<Record<JointName, string>> = {
  handL: "Тяни точку: локоть и плечо подстроятся сами.",
  handR: "Тяни точку: локоть и плечо подстроятся сами.",
  footL: "Тяни точку: колено и бедро подстроятся сами.",
  footR: "Тяни точку: колено и бедро подстроятся сами.",
  head: "Голова смотрит туда, куда тянешь.",
  hips: "Вниз — присесть, вверх — встать. Ноги стоят на месте.",
};

/** A new pose comes this long after the last one. */
const STEP = 0.6;
/** More poses than this: the motion was built or recorded, not posed; cards get numbers instead of pictures. */
const PICTURED = 40;
const seconds = (t: number) => `${t.toFixed(1).replace(".", ",")} с`;
const withDuration = (clip: Clip): Clip => ({ ...clip, duration: Math.max(0.2, clip.keys[clip.keys.length - 1]?.t ?? 0.2) });

/**
 * «Поза мышью»: pull a hand, a foot, the head or the hips and the rest of the limb follows; each pose is a card in the
 * strip, the motion flows from one to the next. Ready poses and faces are a click away.
 */
export function PoseEditor() {
  const avatar = useMyAvatar((s) => s.avatar);
  const setAvatar = useMyAvatar((s) => s.setAvatar);
  const setCharacter = usePrefs((s) => s.setCharacter);
  const code = usePrefs((s) => s.character);
  const clips = avatar.clips;
  const [currentId, setCurrentId] = useState<string | null>(clips[0]?.id ?? null);
  const clip = clips.find((c) => c.id === currentId) ?? null;
  const [sel, setSel] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState<StageMode>("pull");
  const [ghost, setGhost] = useState(true);
  const [part, setPart] = useState<JointName | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<Clip[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const importer = useRef<HTMLInputElement>(null);
  const live = useRef({ clip, time });
  live.current = { clip, time };
  const handStart = useRef<Clip | null>(null);

  const replace = useCallback((next: Clip, remember = true) => {
    const state = useMyAvatar.getState();
    const before = state.avatar.clips.find((c) => c.id === next.id);
    if (remember && before) setUndo((list) => [...list.slice(-40), before]);
    state.setAvatar({ ...state.avatar, clips: state.avatar.clips.map((c) => (c.id === next.id ? next : c)) });
    setDirty(true);
  }, []);

  const takePose = (pose: Pose) => (p: Pose) => {
    for (const name of JOINTS) p[name] = [...pose[name]] as Pose[JointName];
    p.y = pose.y;
  };
  const { stage, no3d, me, ready } = useWorkshopStage(canvas, {
    handles: !playing,
    onChoose: (j) => setPart(j),
    onTurn: (j, turn) => {
      const { clip: now, time: at } = live.current;
      if (!now) return;
      handStart.current ??= now;
      replace(editPose(now, at, (p) => (p[j] = turn)), false);
    },
    onPull: (pose) => {
      const { clip: now, time: at } = live.current;
      if (!now) return;
      handStart.current ??= now;
      replace(editPose(now, at, takePose(pose)), false);
    },
    onTurnEnd: () => {
      const before = handStart.current;
      handStart.current = null;
      if (before) setUndo((list) => [...list.slice(-40), before]);
      picture();
    },
  });

  const thumbKey = (c: Clip, t: number) => `${c.id}:${t.toFixed(3)}`;
  /** The card's picture of the pose shown now, once the stage has drawn it. */
  const picture = () =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const { clip: now, time: at } = live.current;
        const url = now && stage.current?.snapshot();
        if (now && url) setThumbs((all) => ({ ...all, [thumbKey(now, at)]: url }));
      }),
    );

  // Pictures for every card of a posed motion, made once when it is opened.
  useEffect(() => {
    const s = stage.current;
    if (!s || !clip || clip.keys.length > PICTURED || no3d) return;
    const made: Record<string, string> = {};
    for (const key of clip.keys) {
      if (thumbs[thumbKey(clip, key.t)]) continue;
      s.setPose(poseOfClip(clip, key.t));
      const url = s.snapshot();
      if (url) made[thumbKey(clip, key.t)] = url;
    }
    s.setPose(poseOfClip(clip, live.current.time));
    if (Object.keys(made).length) setThumbs((all) => ({ ...all, ...made }));
    // Only when another motion is opened or the stage comes.
  }, [currentId, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (clip) stage.current?.setPose(poseOfClip(clip, time));
  }, [clip, time, stage]);
  useEffect(() => {
    if (ready) stage.current?.setMode(tool);
  }, [tool, ready, stage]);
  useEffect(() => {
    const before = clip && sel > 0 ? clip.keys[sel - 1] : null;
    stage.current?.setGhost(ghost && before && !playing ? poseOfClip(clip!, before.t) : null);
  }, [clip, sel, ghost, playing, stage]);

  // A card without its picture gets one when it is chosen.
  useEffect(() => {
    if (clip && !playing && clip.keys.length <= PICTURED && clip.keys[sel] && !thumbs[thumbKey(clip, clip.keys[sel]!.t)]) picture();
  }, [sel, currentId, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the chosen card on a pose that exists.
  useEffect(() => {
    if (!clip || playing) return;
    const i = Math.min(sel, clip.keys.length - 1);
    if (i !== sel) setSel(i);
    setTime(clip.keys[i]?.t ?? 0);
  }, [clip, sel, playing]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const shown = live.current.clip;
      if (!shown) return;
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => {
        const next = t + dt;
        if (next <= shown.duration) return next;
        if (shown.loop) return next % shown.duration;
        setPlaying(false);
        return shown.duration;
      });
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "я")) {
        e.preventDefault();
        setUndo((list) => {
          const last = list[list.length - 1];
          if (last) replace(last, false);
          return list.slice(0, -1);
        });
      } else if (e.code === "Space") {
        e.preventDefault();
        setPlaying((on) => !on);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [replace]);

  const edit = (change: (p: Pose) => void) => {
    if (!clip) return;
    replace(editPose(clip, time, change));
    picture();
  };

  const addClip = (made: Clip) => {
    const state = useMyAvatar.getState();
    state.setAvatar({ ...state.avatar, clips: [made, ...state.avatar.clips] });
    setCurrentId(made.id);
    setSel(0);
    setUndo([]);
    setDirty(true);
  };

  const addPose = () => {
    if (!clip) return;
    const last = clip.keys[clip.keys.length - 1]!;
    const t = Math.min(60, last.t + STEP);
    const next = withDuration(editPose(clip, t, takePose(poseOfClip(clip, clip.keys[sel]?.t ?? last.t))));
    replace(next);
    setSel(next.keys.length - 1);
    picture();
  };

  const removePose = () => {
    if (!clip || clip.keys.length <= 1) return;
    replace(withDuration(removeKey(clip, clip.keys[sel]!.t)));
    setSel((i) => Math.max(0, i - 1));
  };

  const setPoseTime = (value: number) => {
    if (!clip) return;
    const key = clip.keys[sel];
    if (!key || sel === 0) return;
    const lo = clip.keys[sel - 1]!.t + 0.05;
    const hi = clip.keys[sel + 1] ? clip.keys[sel + 1]!.t - 0.05 : 60;
    const to = Math.max(lo, Math.min(hi, value));
    const moved = withDuration(moveKey(clip, key.t, to));
    replace(moved);
    setThumbs((all) => (all[thumbKey(clip, key.t)] ? { ...all, [thumbKey(moved, to)]: all[thumbKey(clip, key.t)]! } : all));
  };

  const save = async () => {
    setSaving(true);
    try {
      const now = useMyAvatar.getState().avatar;
      const look = parseAvatar(code)?.kind === "pack" ? null : code;
      const done = await commitAvatar({ ...now, base: now.base ?? look ?? defaultAvatarFor(me) });
      setAvatar(done.avatar);
      setCharacter(done.code);
      setDirty(false);
      notify.info("Сохранено. Движение теперь в эмоциях звонка, друзья увидят его у себя");
    } catch (e) {
      notify.error(`Не сохранилось: ${String(e).slice(0, 160)}`);
    } finally {
      setSaving(false);
    }
  };

  const importMotion = async (file: File) => {
    try {
      const { motionToClip } = await import("../../characters/convert");
      addClip(await motionToClip(file));
    } catch (e) {
      notify.error(e instanceof ModelError ? e.message : `Движение не прочиталось: ${String(e).slice(0, 160)}`);
    }
  };

  const key = clip?.keys[sel] ?? null;
  const pictured = !!clip && clip.keys.length <= PICTURED;

  return (
    <div className="poser">
      <section className="poser-stage">
        <div className="poser-tools" role="toolbar" aria-label="Инструменты">
          <button type="button" className={tool === "pull" ? "kit-chip on" : "kit-chip"} aria-pressed={tool === "pull"} onClick={() => setTool("pull")}>
            <Hand size={14} aria-hidden /> Тянуть
          </button>
          <button type="button" className={tool === "turn" ? "kit-chip on" : "kit-chip"} aria-pressed={tool === "turn"} onClick={() => setTool("turn")}>
            <RotateCw size={14} aria-hidden /> Крутить
          </button>
          <button type="button" className={ghost ? "kit-chip on" : "kit-chip"} aria-pressed={ghost} title="Показать прошлую позу тонкими линиями" onClick={() => setGhost((g) => !g)}>
            <Layers size={14} aria-hidden /> Прошлая поза
          </button>
        </div>
        {no3d ? <p className="hint character-no3d">Этот ПК не рисует 3D: ставить позы здесь не получится.</p> : <canvas ref={canvas} className="animator-canvas" aria-label={IS_MOBILE ? "Персонаж: тяни пальцем точки на руках, ногах, голове и тазу; пальцем по пустому месту вращай камеру" : "Персонаж: тяни точки на руках, ногах, голове и тазу; мышью по пустому месту вращай камеру"} />}
        {!clip && !no3d && <p className="animator-hint">Создай движение справа, потом тяни точки на персонаже</p>}
      </section>

      <aside className="poser-side" aria-label="Движение">
        <div className="poser-row">
          <select className="select" aria-label="Моё движение" value={currentId ?? ""} onChange={(e) => (setCurrentId(e.currentTarget.value || null), setSel(0), setUndo([]))}>
            {clips.length === 0 && <option value="">Движений пока нет</option>}
            {clips.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji} {c.name}
              </option>
            ))}
          </select>
          <IconButton label="Новое движение" onClick={() => addClip({ ...emptyClip(), duration: STEP, keys: emptyClip().keys.map((k, i) => ({ ...k, t: i * STEP })) })}>
            <Plus size={16} />
          </IconButton>
          <IconButton label="Движение из файла .fbx (Mixamo), .bvh или .glb" onClick={() => importer.current?.click()}>
            <Upload size={15} />
          </IconButton>
          <input ref={importer} type="file" hidden accept=".fbx,.bvh,.glb,.vrma" onChange={(e) => {
            const picked = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (picked) void importMotion(picked);
          }} />
        </div>
        {clip && (
          <>
            <div className="poser-row">
              <input className="input poser-emoji" aria-label="Значок" value={clip.emoji} maxLength={4} onChange={(e) => replace({ ...clip, emoji: e.currentTarget.value }, false)} />
              <input className="input" aria-label="Название" value={clip.name} maxLength={32} onChange={(e) => replace({ ...clip, name: e.currentTarget.value }, false)} />
            </div>

            <h3 className="label">Выбрано</h3>
            <p className="poser-part">{part ? PART[part] : "Ничего"}</p>
            <p className="hint">{tool === "pull" ? (part && PULL_HINT[part]) || "Тяни белые точки на руках, ногах, голове и тазу." : "Нажми на точку сустава и крути кольца."}</p>
            <div className="poser-row">
              <Button onClick={() => (replace(mirrorAt(clip, time)), picture())}>
                <FlipHorizontal2 size={15} /> Отразить
              </Button>
              <Button onClick={() => edit((p) => {
                const rest = restPose();
                for (const name of JOINTS) p[name] = rest[name];
                p.y = 0;
              })}>
                <RotateCcw size={15} /> Сбросить
              </Button>
            </div>

            <h3 className="label">Готовые позы</h3>
            <div className="kit-faces">
              {READY_POSES.map((r) => (
                <button key={r.id} type="button" className="kit-chip" onClick={() => {
                  const made = stage.current?.reachPose(r.reach);
                  if (made) edit(takePose(made));
                }}>
                  {r.name}
                </button>
              ))}
            </div>

            <h3 className="label">Лицо</h3>
            <div className="kit-faces">
              {FACE_LOOKS.map((l) => (
                <button key={l.id} type="button" className="kit-chip" onClick={() => edit((p) => {
                  const rest = restPose();
                  for (const field of ["mouth", "mouthWide", "smile", "eyes", "happy", "brow", "browSlant", "lookX", "lookY", "blush"] as const) p[field] = rest[field];
                  Object.assign(p, l.face);
                })}>
                  {l.name}
                </button>
              ))}
              <button type="button" className="kit-chip" onClick={() => edit((p) => {
                const rest = restPose();
                for (const field of ["mouth", "mouthWide", "smile", "eyes", "happy", "brow", "browSlant", "lookX", "lookY", "blush"] as const) p[field] = rest[field];
              })}>
                Спокойное
              </button>
            </div>

            {key && sel > 0 && (
              <div className="poser-row poser-time">
                <label className="field-label" htmlFor="pose-time">
                  Поза на
                </label>
                <input id="pose-time" className="input" type="number" min={0.05} max={60} step={0.1} value={Number(key.t.toFixed(2))} onChange={(e) => setPoseTime(Number(e.currentTarget.value))} />
                <span className="hint">с от начала</span>
              </div>
            )}
            <Toggle label="Повторять по кругу" checked={clip.loop} onChange={(loop) => replace({ ...clip, loop })} />
            <div className="poser-row">
              <IconButton label="Отменить (Ctrl+Z)" disabled={undo.length === 0} onClick={() => {
                const last = undo[undo.length - 1];
                if (last) replace(last, false);
                setUndo((list) => list.slice(0, -1));
              }}>
                <Undo2 size={16} />
              </IconButton>
              <span className="kit-spacer" />
              <Button variant="danger" onClick={() => {
                const state = useMyAvatar.getState();
                state.setAvatar({ ...state.avatar, clips: state.avatar.clips.filter((c) => c.id !== clip.id) });
                setCurrentId(state.avatar.clips.find((c) => c.id !== clip.id)?.id ?? null);
                setDirty(true);
              }}>
                <Trash2 size={15} /> Удалить движение
              </Button>
            </div>
          </>
        )}
        <Button variant="primary" className="poser-save" disabled={saving || !dirty} onClick={() => void save()}>
          <Save size={15} /> {saving ? "Сохраняю…" : "Сохранить движение"}
        </Button>
      </aside>

      <section className="poser-strip" aria-label="Позы по порядку">
        <IconButton label={playing ? "Пауза (пробел)" : "Играть (пробел)"} active={playing} disabled={!clip} onClick={() => {
          if (!playing) setTime(0);
          setPlaying((on) => !on);
        }}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </IconButton>
        <div className="poser-cards">
          {clip?.keys.map((k, i) => (
            <div key={`${k.t}-${i}`} className={i === sel && !playing ? "poser-card on" : "poser-card"}>
              <button type="button" className="poser-card-pick" aria-label={`Поза ${i + 1}, ${seconds(k.t)}`} onClick={() => (setPlaying(false), setSel(i), setTime(k.t))}>
                {pictured && thumbs[thumbKey(clip, k.t)] ? <img src={thumbs[thumbKey(clip, k.t)]} alt="" /> : <span className="poser-card-number">{i + 1}</span>}
                <span className="poser-card-time">{seconds(k.t)}</span>
              </button>
              {i === sel && clip.keys.length > 1 && (
                <button type="button" className="poser-card-x" aria-label="Убрать эту позу" onClick={removePose}>
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          {clip && (
            <button type="button" className="poser-card poser-add" disabled={clip.keys.length >= 900} onClick={addPose}>
              <Plus size={18} aria-hidden />
              <span>Поза</span>
            </button>
          )}
        </div>
        <p className="hint poser-strip-hint">
          {clip && !pictured ? (
            <>
              <Emoji kind="char" id="🎞️" size={16} /> Это движение собрано или записано: в нём {clip.keys.length} поз. Удобнее менять его там, где оно сделано.
            </>
          ) : (
            "Каждая поза — кадр. Между кадрами движение строится само, плавно."
          )}
        </p>
      </section>
    </div>
  );
}
