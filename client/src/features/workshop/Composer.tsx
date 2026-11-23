import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, FlipHorizontal2, Pause, Play, Plus, Save, Search, Trash2 } from "lucide-react";
import { newClipId } from "../../characters/clip";
import {
  bakeRecipe,
  FACE_LOOKS,
  layOut,
  MAX_BLEND,
  MAX_REPEAT,
  newBodyPiece,
  parseRecipe,
  pieceId,
  pieceLength,
  poseOfRecipe,
  recipeLength,
  type FaceLook,
  type Recipe,
  type Sampler,
} from "../../characters/compose";
import { defaultAvatarFor, parseAvatar } from "../../characters/gallery";
import { loadMotions } from "../../characters/mocap";
import { commitAvatar, useMyAvatar } from "../../characters/myAvatar";
import { makeSampler } from "../../characters/pieceSampler";
import { loadJson, saveJson } from "../../state/persist";
import { usePrefs } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { Emoji } from "../../ui/Emoji";
import { IconButton } from "../../ui/IconButton";
import { Segmented } from "../../ui/Segmented";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import { notify } from "../../ui/toasts";
import { GROUP_OF, nameOf, SOLO, SOLO_IDS, type Group as LibraryGroup } from "./library";
import { useWorkshopStage } from "./useStage";
import { IS_MOBILE } from "../../platform";

type Group = "all" | LibraryGroup;

const GROUPS: { value: Group; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "hello", label: "Приветствия" },
  { value: "dance", label: "Танцы" },
  { value: "feel", label: "Эмоции" },
  { value: "sport", label: "Спорт" },
];

const RECIPES_KEY = "hatavoice.recipes";
type Kept = Record<string, { name: string; emoji: string; recipe: Recipe }>;

function loadKept(): Kept {
  const raw = loadJson(RECIPES_KEY);
  if (typeof raw !== "object" || raw === null) return {};
  const kept: Kept = {};
  for (const [id, value] of Object.entries(raw as Record<string, { name?: unknown; emoji?: unknown; recipe?: unknown }>)) {
    const recipe = parseRecipe(value?.recipe, SOLO_IDS);
    if (recipe && typeof value.name === "string") kept[id] = { name: value.name.slice(0, 32), emoji: typeof value.emoji === "string" ? value.emoji.slice(0, 8) : "✨", recipe };
  }
  return kept;
}

const COLORS = ["#2f7a5b", "#5b4a9a", "#8a3a4a", "#3a6a9a", "#8a6a2a", "#4a7a3a"];
const seconds = (t: number) => `${t.toFixed(1).replace(".", ",")} с`;

/**
 * «Собрать»: ready motions laid on a track one after another, faces on a track of their own; the character plays the
 * whole thing as it is built. Saved, it becomes an ordinary motion of mine, in the call's emotes and with friends.
 */
export function Composer() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { stage, no3d, me } = useWorkshopStage(canvas);
  const setAvatar = useMyAvatar((s) => s.setAvatar);
  const setCharacter = usePrefs((s) => s.setCharacter);
  const code = usePrefs((s) => s.character);
  const [sampler, setSampler] = useState<Sampler>(() => makeSampler(null));
  const [kept, setKept] = useState<Kept>(loadKept);
  const [clipId, setClipId] = useState<string>(() => Object.keys(loadKept())[0] ?? newClipId());
  const [name, setName] = useState(() => kept[clipId]?.name ?? "Привет всем");
  const [emoji, setEmoji] = useState(() => kept[clipId]?.emoji ?? "👋");
  const [recipe, setRecipe] = useState<Recipe>(() => kept[clipId]?.recipe ?? { body: [], face: [] });
  const [chosen, setChosen] = useState<string | null>(null);
  const [group, setGroup] = useState<Group>("all");
  const [query, setQuery] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let gone = false;
    void loadMotions().then((lib) => !gone && setSampler(makeSampler(lib)));
    return () => {
      gone = true;
    };
  }, []);

  const laid = useMemo(() => layOut(recipe, sampler), [recipe, sampler]);
  const total = recipeLength(recipe, sampler);
  const live = useRef({ recipe, sampler, laid, total });
  live.current = { recipe, sampler, laid, total };

  // The character plays the motion at the moment shown.
  useEffect(() => {
    stage.current?.setPose(poseOfRecipe(recipe, sampler, Math.min(time, total), laid));
  }, [recipe, sampler, laid, time, total, stage]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => {
        const next = t + dt;
        if (next <= live.current.total) return next;
        setPlaying(false);
        return live.current.total;
      });
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const change = (next: Recipe) => {
    setRecipe(next);
    setDirty(true);
  };
  const piece = recipe.body.find((p) => p.id === chosen) ?? null;
  const face = recipe.face.find((f) => f.id === chosen) ?? null;
  const updatePiece = (id: string, patch: Partial<Recipe["body"][number]>) => change({ ...recipe, body: recipe.body.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  const addAct = (act: string, at = recipe.body.length) => {
    const made = newBodyPiece(act);
    const body = [...recipe.body];
    body.splice(at, 0, made);
    change({ ...recipe, body });
    setChosen(made.id);
  };
  const addFace = (look: FaceLook) => {
    const made = { id: pieceId(), look, start: Math.min(time, Math.max(0, total - 0.5)), length: 1.5 };
    change({ ...recipe, face: [...recipe.face, made] });
    setChosen(made.id);
  };
  const move = (id: string, by: -1 | 1) => {
    const i = recipe.body.findIndex((p) => p.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= recipe.body.length) return;
    const body = [...recipe.body];
    [body[i], body[j]] = [body[j]!, body[i]!];
    change({ ...recipe, body });
  };
  const removeChosen = () => {
    change({ body: recipe.body.filter((p) => p.id !== chosen), face: recipe.face.filter((f) => f.id !== chosen) });
    setChosen(null);
  };

  // Dropped on the body's track: before the piece the pointer is over the first half of.
  const dropIndex = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box) return recipe.body.length;
    const t = ((clientX - box.left) / box.width) * total;
    const i = laid.findIndex((l) => t < (l.start + l.end) / 2);
    return i < 0 ? recipe.body.length : i;
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const act = e.dataTransfer.getData("application/x-hv-act");
    const moved = e.dataTransfer.getData("application/x-hv-piece");
    const at = dropIndex(e.clientX);
    if (act && SOLO_IDS.has(act)) addAct(act, at);
    else if (moved) {
      const from = recipe.body.findIndex((p) => p.id === moved);
      if (from < 0) return;
      const body = [...recipe.body];
      const [taken] = body.splice(from, 1);
      body.splice(at > from ? at - 1 : at, 0, taken!);
      change({ ...recipe, body });
    }
  };

  // A face is moved by dragging it along its track, and made longer or shorter by its right edge.
  const faceDrag = useRef<{ id: string; edge: boolean; x: number; start: number; length: number } | null>(null);
  const onFaceDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string, edge: boolean) => {
    const f = recipe.face.find((x) => x.id === id);
    if (!f) return;
    setChosen(id);
    faceDrag.current = { id, edge, x: e.clientX, start: f.start, length: f.length };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
  };
  const onFaceMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = faceDrag.current;
    const box = track.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dt = ((e.clientX - d.x) / box.width) * total;
    change({
      ...recipe,
      face: recipe.face.map((f) => (f.id !== d.id ? f : d.edge ? { ...f, length: Math.max(0.3, Math.round((d.length + dt) * 10) / 10) } : { ...f, start: Math.max(0, Math.round((d.start + dt) * 10) / 10) })),
    });
  };

  const seek = (clientX: number, box: DOMRect) => {
    setPlaying(false);
    setTime(Math.max(0, Math.min(total, ((clientX - box.left) / box.width) * total)));
  };

  const open = (id: string | null) => {
    const next = id ? kept[id] : null;
    setClipId(id ?? newClipId());
    setName(next?.name ?? "Новое движение");
    setEmoji(next?.emoji ?? "✨");
    setRecipe(next?.recipe ?? { body: [], face: [] });
    setChosen(null);
    setTime(0);
    setDirty(false);
  };

  const save = async () => {
    if (recipe.body.length === 0 && recipe.face.length === 0) return;
    setSaving(true);
    try {
      const baked = bakeRecipe(recipe, sampler, { id: clipId, name: name.trim() || "Движение", emoji: emoji || "✨" });
      const avatar = useMyAvatar.getState().avatar;
      const clips = avatar.clips.some((c) => c.id === clipId) ? avatar.clips.map((c) => (c.id === clipId ? baked : c)) : [baked, ...avatar.clips];
      const look = parseAvatar(code)?.kind === "pack" ? null : code;
      const done = await commitAvatar({ ...avatar, clips, base: avatar.base ?? look ?? defaultAvatarFor(me) });
      setAvatar(done.avatar);
      setCharacter(done.code);
      const nextKept = { ...kept, [clipId]: { name: baked.name, emoji: baked.emoji, recipe } };
      setKept(nextKept);
      saveJson(RECIPES_KEY, nextKept);
      setDirty(false);
      notify.info("Сохранено. Движение теперь в эмоциях звонка, друзья увидят его у себя");
    } catch (e) {
      notify.error(`Не сохранилось: ${String(e).slice(0, 160)}`);
    } finally {
      setSaving(false);
    }
  };

  const shown = SOLO.filter((e) => (group === "all" || GROUP_OF[e.id] === group) && (!query.trim() || e.name.toLowerCase().includes(query.trim().toLowerCase())));
  const ticks = Array.from({ length: Math.floor(total) + 1 }, (_, i) => i);
  const pct = (t: number) => `${(t / total) * 100}%`;

  return (
    <div className="kit">
      <aside className="kit-library" aria-label="Готовые движения">
        <h2>Готовые движения</h2>
        <p className="hint">
          {IS_MOBILE ? "Нажми на движение — оно встанет в конец дорожки." : "Нажми на движение или перетащи его вниз на дорожку."} Соседние движения плавно
          перетекают друг в друга.
        </p>
        <label className="kit-search">
          <Search size={15} aria-hidden />
          <input className="input" placeholder="Поиск движений" value={query} aria-label="Поиск движений" onChange={(e) => setQuery(e.currentTarget.value)} />
        </label>
        <div className="kit-groups" role="radiogroup" aria-label="Какие движения">
          {GROUPS.map((g) => (
            <button key={g.value} type="button" role="radio" aria-checked={group === g.value} className={group === g.value ? "kit-chip on" : "kit-chip"} onClick={() => setGroup(g.value)}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="kit-cards">
          {shown.map((e) => (
            <button key={e.id} type="button" className="kit-card" draggable title={`${e.name}: нажми, чтобы добавить в конец, или перетащи на дорожку`} onClick={() => addAct(e.id)} onDragStart={(ev) => ev.dataTransfer.setData("application/x-hv-act", e.id)}>
              <Emoji kind="act" id={e.id} size={30} />
              <span className="kit-card-text">
                <b>{e.name}</b>
                <small>{seconds(sampler.length(e.id))}</small>
              </span>
              <Plus size={14} className="kit-card-plus" aria-hidden />
            </button>
          ))}
        </div>
        <h3 className="label">Лицо</h3>
        <div className="kit-faces">
          {FACE_LOOKS.map((l) => (
            <button key={l.id} type="button" className="kit-chip" title="Добавить на дорожку «Лицо» с текущего момента" onClick={() => addFace(l.id)}>
              {l.name}
            </button>
          ))}
        </div>
        <p className="hint kit-note">Ходьба, танцы, присесть и другие движения сняты с живых людей (motion capture).</p>
      </aside>

      <section className="kit-stage">
        {no3d ? <p className="hint character-no3d">Этот ПК не рисует 3D: собрать движение здесь не получится.</p> : <canvas ref={canvas} className="animator-canvas" aria-label="Персонаж повторяет собранное движение. Мышью можно вращать камеру" />}
        {recipe.body.length === 0 && !no3d && <p className="animator-hint">{IS_MOBILE ? "Добавь движения выше" : "Добавь движения слева"}: персонаж сразу их покажет</p>}
        {(piece || face) && (
          <div className="kit-props" aria-label="Свойства куска">
            {piece && (
              <>
                <h3>Кусок «{nameOf(piece.act)}»</h3>
                <Slider label="Скорость" min={50} max={200} step={5} value={Math.round(piece.speed * 100)} format={(v) => `×${(v / 100).toFixed(2).replace(/\.?0+$/, "").replace(".", ",")}`} onChange={(v) => updatePiece(piece.id, { speed: v / 100 })} />
                <Segmented<string> label="Повторить" value={String(piece.repeat)} options={Array.from({ length: MAX_REPEAT }, (_, i) => ({ value: String(i + 1), label: i === 0 ? "1 раз" : `${i + 1}` }))} onChange={(v) => updatePiece(piece.id, { repeat: Number(v) })} />
                <Slider label="Переход из прошлого" min={0} max={Math.round(MAX_BLEND * 100)} step={5} value={Math.round(piece.blend * 100)} disabled={recipe.body[0]?.id === piece.id} format={(v) => seconds(v / 100)} onChange={(v) => updatePiece(piece.id, { blend: v / 100 })} />
                <Toggle label="Зеркально, другой рукой" checked={piece.mirror} onChange={(mirror) => updatePiece(piece.id, { mirror })} />
                <div className="kit-props-row">
                  <IconButton label="Раньше" onClick={() => move(piece.id, -1)}>
                    <ArrowLeft size={15} />
                  </IconButton>
                  <IconButton label="Позже" onClick={() => move(piece.id, 1)}>
                    <ArrowRight size={15} />
                  </IconButton>
                  <IconButton label="Повторить ещё раз рядом" onClick={() => addAct(piece.act, recipe.body.findIndex((p) => p.id === piece.id) + 1)}>
                    <Plus size={15} />
                  </IconButton>
                  <IconButton label="Зеркально" active={piece.mirror} onClick={() => updatePiece(piece.id, { mirror: !piece.mirror })}>
                    <FlipHorizontal2 size={15} />
                  </IconButton>
                  <span className="kit-spacer" />
                  <IconButton label="Убрать кусок" tone="danger" onClick={removeChosen}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
                <p className="hint">Длится {seconds(pieceLength(piece, sampler))}</p>
              </>
            )}
            {face && (
              <>
                <h3>Лицо «{FACE_LOOKS.find((l) => l.id === face.look)?.name}»</h3>
                <p className="hint">Тяни плашку по дорожке, а за правый край — чтобы удлинить.</p>
                <div className="kit-props-row">
                  <span className="kit-spacer" />
                  <IconButton label="Убрать" tone="danger" onClick={removeChosen}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section className="kit-timeline" aria-label="Дорожки">
        <div className="kit-bar">
          <IconButton label={playing ? "Пауза" : "Играть"} active={playing} onClick={() => {
            if (!playing && time >= total) setTime(0);
            setPlaying((on) => !on);
          }}>
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </IconButton>
          <input className="input kit-emoji" aria-label="Значок" value={emoji} maxLength={4} onChange={(e) => (setEmoji(e.currentTarget.value), setDirty(true))} />
          <input className="input kit-name" aria-label="Название движения" value={name} maxLength={32} onChange={(e) => (setName(e.currentTarget.value), setDirty(true))} />
          <span className="label kit-total">{seconds(total)}</span>
          <span className="kit-spacer" />
          <select className="select kit-open" aria-label="Открыть собранное движение" value={kept[clipId] ? clipId : ""} onChange={(e) => open(e.currentTarget.value || null)}>
            <option value="">Новое движение</option>
            {Object.entries(kept).map(([id, k]) => (
              <option key={id} value={id}>
                {k.emoji} {k.name}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={saving || (!dirty && !!kept[clipId]) || recipe.body.length + recipe.face.length === 0} onClick={() => void save()}>
            <Save size={15} /> {saving ? "Сохраняю…" : "Сохранить"}
          </Button>
        </div>
        <div className="kit-grid">
          <span />
          <div className="kit-ruler" onPointerDown={(e) => seek(e.clientX, e.currentTarget.getBoundingClientRect())}>
            {ticks.map((s) => (
              <span key={s} style={{ left: pct(s) }}>
                {s === 0 ? "0 с" : s}
              </span>
            ))}
          </div>
          <span className="kit-track-name">Тело</span>
          <div ref={track} className="kit-track" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onPointerDown={(e) => e.target === e.currentTarget && seek(e.clientX, e.currentTarget.getBoundingClientRect())}>
            {laid.map((l, i) => (
              <button
                key={l.piece.id}
                type="button"
                draggable
                className={l.piece.id === chosen ? "kit-piece on" : "kit-piece"}
                style={{ left: pct(l.start), width: pct(l.end - l.start), background: COLORS[i % COLORS.length] }}
                onDragStart={(e) => e.dataTransfer.setData("application/x-hv-piece", l.piece.id)}
                onClick={() => setChosen(l.piece.id)}
              >
                <Emoji kind="act" id={l.piece.act} size={18} />
                <span>
                  {nameOf(l.piece.act)}
                  {l.piece.repeat > 1 ? ` ×${l.piece.repeat}` : ""}
                </span>
              </button>
            ))}
            {recipe.body.length === 0 && <span className="kit-drop">Перетащи сюда движение</span>}
            <span className="kit-now" style={{ left: pct(Math.min(time, total)) }} />
          </div>
          <span className="kit-track-name">Лицо</span>
          <div className="kit-track face" onPointerDown={(e) => e.target === e.currentTarget && seek(e.clientX, e.currentTarget.getBoundingClientRect())}>
            {recipe.face.map((f) => (
              <button
                key={f.id}
                type="button"
                className={f.id === chosen ? "kit-piece face on" : "kit-piece face"}
                style={{ left: pct(f.start), width: pct(Math.min(f.length, total - f.start)) }}
                onPointerDown={(e) => onFaceDown(e, f.id, false)}
                onPointerMove={onFaceMove}
                onPointerUp={() => (faceDrag.current = null)}
              >
                <span>{FACE_LOOKS.find((l) => l.id === f.look)?.name}</span>
                <i className="kit-edge" onPointerDown={(e) => onFaceDown(e as unknown as ReactPointerEvent<HTMLButtonElement>, f.id, true)} />
              </button>
            ))}
            <span className="kit-now" style={{ left: pct(Math.min(time, total)) }} />
          </div>
        </div>
      </section>
    </div>
  );
}
