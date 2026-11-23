import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Dices, Palette, RotateCcw, Sparkles } from "lucide-react";
import { commitAvatar, useMyAvatar } from "../../characters/myAvatar";
import { AvatarChooser, AvatarPreview } from "../workshop/AvatarChooser";
import {
  BODIES,
  BODY_NAMES,
  characterCode,
  defaultCharacterFor,
  EXTRA_NAMES,
  EXTRAS,
  EYE_NAMES,
  EYES,
  HAIR_NAMES,
  HAIRS,
  HAT_NAMES,
  HATS,
  parseCharacter,
  SKINS,
  TOP_NAMES,
  TOPS,
  type Character,
} from "../../characters/character";
import { cssColor } from "../../characters/members";
import { OVERLAY_FPS_MS, useOverlayHealth } from "../../characters/overlay";
import { identityInfo } from "../../server/session";
import { usePrefs } from "../../state/prefs";
import { Button } from "../../ui/Button";
import { ColorPicker } from "../../ui/ColorPicker";
import { Swatches } from "../../ui/Swatches";
import { Toggle } from "../../ui/Toggle";
import { Segmented } from "../../ui/Segmented";
import { STAGE_LOOKS, STAGE_LOOK_NAMES, type StageLook } from "../../characters/stageLook";

const OUTFITS = ["#d9663a", "#c94f7c", "#7a4b8c", "#2f4d7a", "#3f7c74", "#4f8a5c", "#d6a02e", "#b5342b", "#2b2738", "#e8e4da"];
const BOTTOMS = ["#3a3f4b", "#2d3a55", "#26282e", "#4a4238", "#5a2f2a", "#31503c", "#c9c2b2", "#d6a02e"];
const HAIR_COLORS = ["#3b2a20", "#14121f", "#a0522d", "#c9a24a", "#e8e0d0", "#d8333f", "#ff7ac8", "#8e5bff", "#5b8cff", "#3ccf8e"];

type ChoiceProps<T extends string> = { label: string; value: T; options: readonly T[]; names: Record<T, string>; onChange: (v: T) => void };

function Choice<T extends string>({ label, value, options, names, onChange }: ChoiceProps<T>) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="char-choices" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={o === value}
            className={o === value ? "char-choice active" : "char-choice"}
            onClick={() => onChange(o)}
          >
            {names[o]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** How smoothly the desktop window draws, as it last said (in a call, with the characters on the desktop). */
function OverlaySmoothness() {
  const { fps, hidden, at } = useOverlayHealth();
  if (fps === null || Date.now() - at > 3 * OVERLAY_FPS_MS) return null;
  const slow = hidden || fps < 15;
  return (
    <p className={slow ? "hint form-error" : "hint"}>
      Персонажи на рабочем столе рисуются {fps} {plural(fps, "кадр", "кадра", "кадров")} в секунду
      {hidden ? ": Windows считает это окно скрытым" : slow ? ": Windows притормаживает это окно" : ""}
    </p>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

function any<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** «Персонаж»: whom friends see in calls, made here, its own motions, and the stage of characters itself. */
export function CharacterSection({ onOpenMotions }: { onOpenMotions?: () => void }) {
  const color = usePrefs((s) => s.color);
  const code = usePrefs((s) => s.character);
  const setCharacter = usePrefs((s) => s.setCharacter);
  const stage3d = usePrefs((s) => s.stage3d);
  const setStage3d = usePrefs((s) => s.setStage3d);
  const stageLook = usePrefs((s) => s.stageLook);
  const setStageLook = usePrefs((s) => s.setStageLook);
  const overlay = usePrefs((s) => s.overlay);
  const setOverlay = usePrefs((s) => s.setOverlay);
  const placed = usePrefs((s) => Object.keys(s.overlaySpots).length > 0);
  const resetSpots = usePrefs((s) => s.resetOverlaySpots);
  const [me, setMe] = useState("me");
  const [pickingOutfit, setPickingOutfit] = useState(false);

  // The character one made none of is made from the user id, as friends see it.
  useEffect(() => {
    if (isTauri()) void identityInfo().then((info) => setMe(info.user_id)).catch(() => {});
  }, []);

  const current = parseCharacter(code) ?? defaultCharacterFor(me, cssColor(color));
  const setFigure = (next: string | null) => {
    const state = useMyAvatar.getState();
    // Motions of one's own stay with whatever one looks like.
    if (state.avatar.clips.length > 0) {
      void commitAvatar({ ...state.avatar, model: null, base: next }).then((done) => {
        state.setAvatar(done.avatar);
        setCharacter(done.code);
      });
      return;
    }
    state.setAvatar({ ...state.avatar, model: null, base: next, pack: null });
    setCharacter(next);
  };
  const change = (part: Partial<Character>) => setFigure(characterCode({ ...current, ...part }));
  const random = () =>
    setFigure(
      characterCode({ body: any(BODIES), skin: any(SKINS), outfit: any(OUTFITS), hair: any(HAIRS), hairColor: any(HAIR_COLORS), hat: any(HATS), eyes: any(EYES), top: any(TOPS), bottom: any(BOTTOMS), extra: any(EXTRAS) }),
    );

  return (
    <>
      <p className="hint">
        Твой персонаж стоит на сцене звонка рядом с персонажами друзей и говорит твоим голосом.
      </p>
      <AvatarPreview />
      <AvatarChooser />
      {onOpenMotions && (
        <>
          <h3 className="settings-sub">Свои движения</h3>
          <p className="hint">Сделай персонажу свои эмоции и танцы: в звонке они будут в «⋯» → «Эмоции персонажа»</p>
          <div className="row">
            <Button onClick={onOpenMotions}>
              <Sparkles size={16} /> Редактор движений
            </Button>
          </div>
        </>
      )}
      <h3 className="settings-sub">Собрать из деталей</h3>
      <div className="row">
        <Button onClick={random}>
          <Dices size={16} /> Случайный
        </Button>
        {code && (
          <Button onClick={() => setFigure(null)}>
            <RotateCcw size={16} /> Как по умолчанию
          </Button>
        )}
      </div>
      <Choice label="Телосложение" value={current.body} options={BODIES} names={BODY_NAMES} onChange={(body) => change({ body })} />
      <Swatches label="Кожа" value={current.skin} options={SKINS} colorOf={(c) => c} nameOf={(c) => c} onChange={(skin) => change({ skin })} />
      <Swatches label="Одежда" value={current.outfit} options={OUTFITS} colorOf={(c) => c} nameOf={(c) => c} onChange={(outfit) => change({ outfit })} />
      <div className="row accent-row">
        <span className="cp-preview" style={{ backgroundColor: current.outfit }} aria-hidden />
        <Button onClick={() => setPickingOutfit((open) => !open)}>
          <Palette size={16} /> {pickingOutfit ? "Готово" : "Свой цвет одежды"}
        </Button>
      </div>
      {pickingOutfit && <ColorPicker label="Свой цвет одежды" value={current.outfit} onChange={(outfit) => change({ outfit })} />}
      <Choice label="Верх" value={current.top} options={TOPS} names={TOP_NAMES} onChange={(top) => change({ top })} />
      <Swatches label="Брюки" value={current.bottom} options={BOTTOMS} colorOf={(c) => c} nameOf={(c) => c} onChange={(bottom) => change({ bottom })} />
      <Choice label="Ещё" value={current.extra} options={EXTRAS} names={EXTRA_NAMES} onChange={(extra) => change({ extra })} />
      <Choice label="Волосы" value={current.hair} options={HAIRS} names={HAIR_NAMES} onChange={(hair) => change({ hair })} />
      <Swatches
        label="Цвет волос"
        value={current.hairColor}
        options={HAIR_COLORS}
        colorOf={(c) => c}
        nameOf={(c) => c}
        onChange={(hairColor) => change({ hairColor })}
      />
      <Choice label="Шапка" value={current.hat} options={HATS} names={HAT_NAMES} onChange={(hat) => change({ hat })} />
      <Choice label="Глаза" value={current.eyes} options={EYES} names={EYE_NAMES} onChange={(eyes) => change({ eyes })} />
      <h3 className="settings-sub">В звонке</h3>
      <Toggle
        label="3D-персонажи в звонке"
        hint="Нажми на персонажа друга, чтобы обнять его, дать пять или кинуть снежок"
        checked={stage3d}
        onChange={setStage3d}
      />
      {stage3d && (
        <Segmented<StageLook>
          label="Где стоят персонажи"
          value={stageLook}
          options={STAGE_LOOKS.map((look) => ({ value: look, label: STAGE_LOOK_NAMES[look] }))}
          onChange={setStageLook}
        />
      )}
      <Toggle
        label="Персонажи на рабочем столе"
        hint="Во время звонка гуляют поверх браузера или игры и говорят вместе с друзьями. Нажми на персонажа — откроется меню, как на сцене звонка; его можно перетащить мышью. Мимо персонажей клики проходят на рабочий стол, а в игре на весь экран — всегда сквозь них. В полноэкранной игре видны только в режиме «Окно без рамки». Размер и места — в звонке «⋯» → «Расставить на экране»"
        checked={overlay}
        onChange={setOverlay}
      />
      {overlay && <OverlaySmoothness />}
      {placed && (
        <div className="row">
          <Button onClick={resetSpots}>
            <RotateCcw size={16} /> Сбросить места на экране
          </Button>
        </div>
      )}
    </>
  );
}
