import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { newClipId } from "../../characters/clip";
import { bakeRecipe, FACE_LOOKS, poseOfRecipe, recipeLength, type FaceLook, type Sampler } from "../../characters/compose";
import { defaultAvatarFor, parseAvatar } from "../../characters/gallery";
import { loadMotions } from "../../characters/mocap";
import { commitAvatar, useMyAvatar } from "../../characters/myAvatar";
import { makeSampler } from "../../characters/pieceSampler";
import { usePrefs } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { Emoji } from "../../ui/Emoji";
import { IconButton } from "../../ui/IconButton";
import { notify } from "../../ui/toasts";
import { IS_MOBILE } from "../../platform";
import {
  actItem,
  forgetEmotion,
  itemId,
  loadEmotions,
  MAX_ITEMS,
  MAX_TIMES,
  saveEmotions,
  SPEEDS,
  toRecipe,
  withPoses,
  type Emotions,
  type Item,
  type PoseItem,
} from "./emotions";
import { GROUP_OF, nameOf, SOLO, SOLO_IDS, type Group } from "./library";
import { PoseBuilder } from "./PoseBuilder";
import { useMe, useWorkshopStage } from "./useStage";

export type AdvancedMode = "compose" | "pose" | "camera";

type Step = 1 | 2 | 3;

const GROUPS: { value: Group | "all"; label: string; emoji: string }[] = [
  { value: "all", label: "Всё", emoji: "" },
  { value: "hello", label: "Привет", emoji: "👋" },
  { value: "dance", label: "Танцы", emoji: "💃" },
  { value: "feel", label: "Чувства", emoji: "😂" },
  { value: "sport", label: "Спорт", emoji: "💪" },
];

export const FACE_EMOJI: Record<FaceLook, string> = { smile: "😊", laugh: "😂", surprise: "😮", angry: "😠", sad: "😢", closed: "😌", blush: "😳" };

const ICONS = ["👋", "😂", "😍", "🎉", "🔥", "💃", "🕺", "🤘", "👍", "🙏", "😎", "🥳", "🤗", "😴", "😡", "😭", "🤔", "🫡", "💪", "✨", "🪄", "🎸", "🎧", "⚡"];

const seconds = (t: number) => `${t.toFixed(1).replace(".", ",")} с`;
const itemName = (item: Item) => (item.kind === "act" ? nameOf(item.act) : item.poses.length > 1 ? `Своя поза (${item.poses.length})` : "Своя поза");

function ItemPicture({ item, size }: { item: Item; size: number }) {
  return item.kind === "act" ? <Emoji kind="act" id={item.act} size={size} /> : <Emoji kind="char" id="✋" size={size} />;
}

type Props = {
  onClose: () => void;
  onAdvanced: (mode: AdvancedMode) => void;
};

/**
 * The motions editor for everyone: three steps with one question each — what the character does (ready motions and
 * poses of one's own, in order), what face it makes, what the emotion is called — then it is in the call's emotes.
 * The old tools stay one click away («Для опытных»).
 */
export function Steps({ onClose, onAdvanced }: Props) {
  const me = useMe();
  const setAvatar = useMyAvatar((s) => s.setAvatar);
  const setCharacter = usePrefs((s) => s.setCharacter);
  const code = usePrefs((s) => s.character);
  const [base, setBase] = useState<Sampler>(() => makeSampler(null));
  const [emotions, setEmotions] = useState<Emotions>(() => loadEmotions(SOLO_IDS, makeSampler(null)));
  const [clipId, setClipId] = useState(newClipId);
  const [name, setName] = useState("Моя эмоция");
  const [emoji, setEmoji] = useState("✨");
  const [items, setItems] = useState<Item[]>([]);
  const [step, setStep] = useState<Step>(1);
  const [builder, setBuilder] = useState<{ item: PoseItem | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sureDelete, setSureDelete] = useState(false);

  useEffect(() => {
    let gone = false;
    void loadMotions().then((lib) => !gone && setBase(makeSampler(lib)));
    return () => {
      gone = true;
    };
  }, []);

  const change = (next: Item[]) => {
    setItems(next);
    setDirty(true);
    setSaved(false);
  };

  const open = (id: string | null) => {
    const kept = id ? emotions[id] : null;
    setClipId(id && kept ? id : newClipId());
    setName(kept?.name ?? "Моя эмоция");
    setEmoji(kept?.emoji ?? "✨");
    setItems(kept?.items ?? []);
    setStep(1);
    setSaved(false);
    setDirty(false);
    setSureDelete(false);
  };

  const save = async () => {
    if (items.length === 0) return;
    setSaving(true);
    try {
      const sampler = withPoses(base, items);
      const baked = bakeRecipe(toRecipe(items, sampler), sampler, { id: clipId, name: name.trim() || "Моя эмоция", emoji: emoji.trim() || "✨" });
      const avatar = useMyAvatar.getState().avatar;
      const clips = avatar.clips.some((c) => c.id === clipId) ? avatar.clips.map((c) => (c.id === clipId ? baked : c)) : [baked, ...avatar.clips];
      const look = parseAvatar(code)?.kind === "pack" ? null : code;
      const done = await commitAvatar({ ...avatar, clips, base: avatar.base ?? look ?? defaultAvatarFor(me) });
      setAvatar(done.avatar);
      setCharacter(done.code);
      const next = { ...emotions, [clipId]: { name: baked.name, emoji: baked.emoji, items } };
      setEmotions(next);
      saveEmotions(next);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      notify.error(`Не сохранилось: ${String(e).slice(0, 160)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!sureDelete) {
      setSureDelete(true);
      return;
    }
    try {
      const avatar = useMyAvatar.getState().avatar;
      if (avatar.clips.some((c) => c.id === clipId)) {
        const done = await commitAvatar({ ...avatar, clips: avatar.clips.filter((c) => c.id !== clipId) });
        setAvatar(done.avatar);
        setCharacter(done.code);
      }
      setEmotions(forgetEmotion(emotions, clipId));
      notify.info("Эмоция удалена");
      open(null);
    } catch (e) {
      notify.error(`Не удалилось: ${String(e).slice(0, 160)}`);
    }
  };

  if (builder) {
    return (
      <PoseBuilder
        initial={builder.item ? { poses: builder.item.poses, gap: builder.item.gap } : null}
        onCancel={() => setBuilder(null)}
        onAdvanced={() => onAdvanced("pose")}
        onDone={(poses, gap, clip) => {
          const was = builder.item;
          if (was) change(items.map((i) => (i.id === was.id ? { ...was, poses, gap, clip } : i)));
          else {
            const made: PoseItem = { id: itemId(), kind: "pose", poses, gap, clip, speed: "normal", repeat: 1, face: null };
            change([...items, made].slice(0, MAX_ITEMS));
          }
          setBuilder(null);
        }}
      />
    );
  }

  const kept = !!emotions[clipId];
  return (
    <>
      <header className="workshop-head wiz-head">
        <IconButton label="Назад" onClick={onClose}>
          <ArrowLeft size={18} />
        </IconButton>
        <h1>Движения персонажа</h1>
        {Object.keys(emotions).length > 0 && (
          <select className="select wiz-mine" aria-label="Какую эмоцию делаю: новую или одну из своих" value={kept ? clipId : ""} onChange={(e) => open(e.currentTarget.value || null)}>
            <option value="">＋ Новая эмоция</option>
            {Object.entries(emotions).map(([id, e]) => (
              <option key={id} value={id}>
                {e.emoji} {e.name}
              </option>
            ))}
          </select>
        )}
        <span className="wiz-spacer" />
        <nav className="wiz-steps" aria-label="Шаги">
          {(["Что делает", "Лицо", "Название"] as const).map((label, i) => {
            const n = (i + 1) as Step;
            return (
              <button key={label} type="button" className={step === n ? "wiz-step on" : step > n ? "wiz-step done" : "wiz-step"} aria-current={step === n ? "step" : undefined} disabled={n > 1 && items.length === 0} onClick={() => setStep(n)}>
                <i>{step > n ? <Check size={13} /> : n}</i>
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        <span className="wiz-spacer" />
        <Button onClick={() => onAdvanced("compose")}>Для опытных</Button>
      </header>
      <Wizard
        step={step}
        setStep={setStep}
        base={base}
        items={items}
        change={change}
        name={name}
        setName={(v) => (setName(v), setDirty(true), setSaved(false))}
        emoji={emoji}
        setEmoji={(v) => (setEmoji(v), setDirty(true), setSaved(false))}
        kept={kept}
        dirty={dirty}
        saving={saving}
        saved={saved}
        sureDelete={sureDelete}
        onSave={() => void save()}
        onDelete={() => void remove()}
        onNew={() => open(null)}
        onClose={onClose}
        onPose={(item) => setBuilder({ item })}
        onCamera={() => onAdvanced("camera")}
      />
    </>
  );
}

type WizardProps = {
  step: Step;
  setStep: (s: Step) => void;
  base: Sampler;
  items: Item[];
  change: (items: Item[]) => void;
  name: string;
  setName: (v: string) => void;
  emoji: string;
  setEmoji: (v: string) => void;
  kept: boolean;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  sureDelete: boolean;
  onSave: () => void;
  onDelete: () => void;
  onNew: () => void;
  onClose: () => void;
  onPose: (item: PoseItem | null) => void;
  onCamera: () => void;
};

/** The steps with their stage: a ready motion shown when it is picked, the whole emotion otherwise. */
function Wizard(props: WizardProps) {
  const { step, setStep, base, items, change } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const { stage, no3d } = useWorkshopStage(canvas);
  const [preview, setPreview] = useState<string | null>(null);
  const [group, setGroup] = useState<Group | "all">("all");
  const [paused, setPaused] = useState(false);
  const bar = useRef<HTMLSpanElement>(null);
  const clock = useRef<HTMLSpanElement>(null);

  const sampler = useMemo(() => withPoses(base, items), [base, items]);
  const recipe = useMemo(() => toRecipe(items, sampler), [items, sampler]);
  const total = items.length ? recipeLength(recipe, sampler) : 0;
  const showing = step === 1 && preview ? preview : null;
  const live = useRef({ sampler, recipe, total, showing, paused });
  live.current = { sampler, recipe, total, showing, paused };

  // The stage plays, over and over: the motion picked in the library, or the whole emotion with a breath between.
  useEffect(() => {
    let frame = 0;
    let t = 0;
    let last = performance.now();
    let was: string | null = null;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const { sampler: s, recipe: r, total: whole, showing: act, paused: hold } = live.current;
      if (act !== was) (t = 0), (was = act);
      if (!hold) t += Math.min(0.1, (now - last) / 1000);
      last = now;
      const length = act ? s.length(act) : whole;
      const round = length + 0.8;
      const at = length > 0 ? t % round : t;
      const pose = act ? s.pose(act, Math.min(at, length)) : whole > 0 ? poseOfRecipe(r, s, Math.min(at, whole)) : s.pose("", t);
      stage.current?.setPose(pose);
      if (bar.current) bar.current.style.width = length > 0 ? `${Math.min(100, (at / length) * 100)}%` : "0%";
      if (clock.current) clock.current.textContent = length > 0 ? `${seconds(Math.min(at, length))} / ${seconds(length)}` : "";
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  const shown = SOLO.filter((e) => group === "all" || GROUP_OF[e.id] === group);
  const add = (act: string) => {
    if (items.length >= MAX_ITEMS) return;
    change([...items, actItem(act)]);
    setPreview(null);
  };
  const pick = (act: string) => (preview === act ? add(act) : setPreview(act));
  const update = (id: string, patch: Partial<Item>) => change(items.map((i) => (i.id === id ? ({ ...i, ...patch } as Item) : i)));
  const move = (index: number, by: -1 | 1) => {
    const j = index + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[index], next[j]] = [next[j]!, next[index]!];
    change(next);
  };

  const label = showing ? nameOf(showing) : items.length ? props.name || "Моя эмоция" : "Стоит и ждёт";

  return (
    <div className="wiz-body">
      <section className="wiz-stage">
        {no3d ? <p className="hint character-no3d">Этот ПК не рисует 3D: персонажа здесь не видно, но эмоцию собрать можно.</p> : <canvas ref={canvas} className="animator-canvas" aria-label="Персонаж показывает движение. Мышью можно вращать камеру" />}
        {showing && <p className="wiz-bubble">Это «{nameOf(showing)}». {IS_MOBILE ? "Нажми" : "Нажми на карточку"} ещё раз — и оно встанет в твою эмоцию</p>}
        <div className="wiz-play">
          <IconButton label={paused ? "Играть" : "Пауза"} active={!paused} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </IconButton>
          <span className="wiz-play-name">{label}</span>
          <span className="wiz-play-bar">
            <span ref={bar} />
          </span>
          <span ref={clock} className="wiz-play-time" />
        </div>
      </section>

      <section className="wiz-side">
        {step === 1 && (
          <>
            <h2 className="wiz-q">Что будет делать персонаж?</h2>
            <div className="wiz-chips" role="toolbar" aria-label="Какие движения">
              {GROUPS.map((g) => (
                <button key={g.value} type="button" className={group === g.value ? "wiz-chip on" : "wiz-chip"} aria-pressed={group === g.value} onClick={() => setGroup(g.value)}>
                  {g.emoji && <Emoji kind="char" id={g.emoji} size={16} />} {g.label}
                </button>
              ))}
              <button type="button" className="wiz-chip own" onClick={() => props.onPose(null)}>
                <Emoji kind="char" id="✋" size={16} /> Своя поза
              </button>
              <button type="button" className="wiz-chip own" onClick={props.onCamera}>
                <Emoji kind="char" id="📷" size={16} /> Повторить за мной с камеры
              </button>
            </div>
            <div className="wiz-cards">
              {shown.map((e) => (
                <button key={e.id} type="button" className={preview === e.id ? "wiz-card on" : "wiz-card"} aria-pressed={preview === e.id} title={preview === e.id ? "Нажми ещё раз, чтобы добавить" : "Посмотреть"} onClick={() => pick(e.id)}>
                  <Emoji kind="act" id={e.id} size={40} />
                  <b>{e.name}</b>
                  <small>{preview === e.id ? "＋ добавить" : seconds(base.length(e.id))}</small>
                </button>
              ))}
            </div>
            <div className="wiz-list">
              <h3>
                Твоя эмоция по порядку {items.length > 0 && <span className="wiz-muted">· {seconds(total)}</span>}
              </h3>
              {items.length === 0 && <p className="hint">Пока пусто. Нажми на движение — персонаж покажет его, нажми ещё раз — и оно встанет сюда. Можно несколько подряд.</p>}
              {items.map((item, i) => (
                <div key={item.id} className="wiz-row">
                  <span className="wiz-n">{i + 1}</span>
                  <ItemPicture item={item} size={28} />
                  <span className="wiz-row-name">{itemName(item)}</span>
                  {item.kind === "pose" && (
                    <button type="button" className="wiz-mini" onClick={() => props.onPose(item)}>
                      <Pencil size={13} /> Изменить
                    </button>
                  )}
                  <span className="wiz-seg" role="radiogroup" aria-label="Скорость">
                    {SPEEDS.map((s) => (
                      <button key={s.value} type="button" role="radio" aria-checked={item.speed === s.value} className={item.speed === s.value ? "on" : ""} onClick={() => update(item.id, { speed: s.value })}>
                        {s.label}
                      </button>
                    ))}
                  </span>
                  <span className="wiz-seg" role="radiogroup" aria-label="Сколько раз">
                    {Array.from({ length: MAX_TIMES }, (_, k) => k + 1).map((n) => (
                      <button key={n} type="button" role="radio" aria-checked={item.repeat === n} className={item.repeat === n ? "on" : ""} onClick={() => update(item.id, { repeat: n })}>
                        ×{n}
                      </button>
                    ))}
                  </span>
                  <span className="wiz-row-tools">
                    <IconButton label="Раньше" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp size={14} />
                    </IconButton>
                    <IconButton label="Позже" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown size={14} />
                    </IconButton>
                    <IconButton label="Убрать" onClick={() => change(items.filter((x) => x.id !== item.id))}>
                      <X size={14} />
                    </IconButton>
                  </span>
                </div>
              ))}
              <div className="wiz-foot">
                {preview && (
                  <Button onClick={() => add(preview)}>
                    <Plus size={15} /> Добавить «{nameOf(preview)}»
                  </Button>
                )}
                <span className="wiz-spacer" />
                <Button variant="primary" className="wiz-next" disabled={items.length === 0} onClick={() => (setPreview(null), setStep(2))}>
                  Дальше: лицо <ArrowRight size={15} />
                </Button>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="wiz-q">Какое лицо у персонажа?</h2>
            <p className="hint">Лицо держится, пока идёт своё движение. «Как в движении» — какое у него и было задумано.</p>
            <div className="wiz-all">
              <span className="wiz-muted">Всем одно лицо:</span>
              <button type="button" className="wiz-chip" onClick={() => change(items.map((i) => ({ ...i, face: null })))}>
                Как в движении
              </button>
              {FACE_LOOKS.map((l) => (
                <button key={l.id} type="button" className="wiz-chip" title={l.name} onClick={() => change(items.map((i) => ({ ...i, face: l.id })))}>
                  <Emoji kind="char" id={FACE_EMOJI[l.id]} size={18} />
                </button>
              ))}
            </div>
            <div className="wiz-list wiz-faces">
              {items.map((item, i) => (
                <div key={item.id} className="wiz-row">
                  <span className="wiz-n">{i + 1}</span>
                  <ItemPicture item={item} size={28} />
                  <span className="wiz-row-name">{itemName(item)}</span>
                  <span className="wiz-spacer" />
                  <span className="wiz-face-pick" role="radiogroup" aria-label={`Лицо: ${itemName(item)}`}>
                    <button type="button" role="radio" aria-checked={item.face === null} className={item.face === null ? "on" : ""} onClick={() => update(item.id, { face: null })}>
                      Как в движении
                    </button>
                    {FACE_LOOKS.map((l) => (
                      <button key={l.id} type="button" role="radio" aria-checked={item.face === l.id} title={l.name} className={item.face === l.id ? "on" : ""} onClick={() => update(item.id, { face: l.id })}>
                        <Emoji kind="char" id={FACE_EMOJI[l.id]} size={20} />
                      </button>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <div className="wiz-foot">
              <Button onClick={() => setStep(1)}>
                <ArrowLeft size={15} /> Назад
              </Button>
              <span className="wiz-spacer" />
              <Button variant="primary" className="wiz-next" onClick={() => setStep(3)}>
                Дальше: название <ArrowRight size={15} />
              </Button>
            </div>
          </>
        )}

        {step === 3 && !props.saved && (
          <>
            <h2 className="wiz-q">Как назовём эмоцию?</h2>
            <label className="field">
              <span className="field-label">Название</span>
              <input className="input" value={props.name} maxLength={32} onChange={(e) => props.setName(e.currentTarget.value)} />
            </label>
            <span className="field-label">Значок в меню эмоций</span>
            <div className="wiz-icons" role="radiogroup" aria-label="Значок">
              {ICONS.map((icon) => (
                <button key={icon} type="button" role="radio" aria-checked={props.emoji === icon} className={props.emoji === icon ? "on" : ""} onClick={() => props.setEmoji(icon)}>
                  <Emoji kind="char" id={icon} size={24} />
                </button>
              ))}
              <input className="input wiz-own-icon" aria-label="Свой значок" placeholder="свой" value={ICONS.includes(props.emoji) ? "" : props.emoji} maxLength={4} onChange={(e) => props.setEmoji(e.currentTarget.value)} />
            </div>
            <div className="wiz-menu-look">
              <span className="wiz-muted">Так она будет в звонке:</span>
              <span className="wiz-menu-button">
                <Emoji kind="char" id={props.emoji || "✨"} size={30} />
                {props.name || "Моя эмоция"}
              </span>
            </div>
            <div className="wiz-foot">
              <Button onClick={() => setStep(2)}>
                <ArrowLeft size={15} /> Назад
              </Button>
              {props.kept && (
                <Button variant="danger" onClick={props.onDelete}>
                  <Trash2 size={15} /> {props.sureDelete ? "Точно удалить?" : "Удалить"}
                </Button>
              )}
              <span className="wiz-spacer" />
              <Button variant="primary" className="wiz-next" disabled={props.saving || (props.kept && !props.dirty)} onClick={props.onSave}>
                <Check size={15} /> {props.saving ? "Сохраняю…" : "Сохранить эмоцию"}
              </Button>
            </div>
          </>
        )}

        {step === 3 && props.saved && (
          <div className="wiz-done">
            <Emoji kind="char" id={props.emoji || "✨"} size={56} />
            <h2>Готово!</h2>
            <p>
              «{props.name || "Моя эмоция"}» уже в звонке: «⋯» → «Эмоции персонажа». Друзья увидят её у себя.
            </p>
            <div className="wiz-foot">
              <Button onClick={() => setStep(1)}>
                <Pencil size={15} /> Изменить
              </Button>
              <Button onClick={props.onNew}>
                <Plus size={15} /> Сделать ещё одну
              </Button>
              <span className="wiz-spacer" />
              <Button variant="primary" onClick={props.onClose}>
                Закрыть
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
