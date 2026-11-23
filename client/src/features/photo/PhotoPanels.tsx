import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Brush, Circle, Copy, Eye, EyeOff, Image, Minus, MoveUpRight, Smile, Square, SquareDashed, Trash2, Type } from "lucide-react";
import type { Layer } from "../../media/photo/doc";
import { ADJUSTS, applyPixels, effectiveAdjust, FILTERS, NO_ADJUST, type Adjust } from "../../media/photo/pixels";
import type { Picture } from "../../media/photo/render";

/** A layer as the list names it. */
export function layerName(layer: Layer): string {
  switch (layer.kind) {
    case "brush":
      return { pen: "Кисть", marker: "Маркер", neon: "Неон", eraser: "Ластик" }[layer.mode];
    case "shape":
      return { rect: "Прямоугольник", ellipse: "Эллипс", line: "Линия", arrow: "Стрелка" }[layer.shape];
    case "text": {
      const first = layer.text.split("\n")[0] ?? "";
      return `Текст «${first.length > 16 ? `${first.slice(0, 16)}…` : first}»`;
    }
    case "sticker":
      return `Наклейка ${layer.emoji}`;
    case "censor":
      return { pixelate: "Скрыто квадратами", blur: "Скрыто размытием", black: "Закрашено чёрным" }[layer.mode];
  }
}

function LayerIcon({ layer }: { layer: Layer }) {
  const Icon =
    layer.kind === "brush"
      ? Brush
      : layer.kind === "text"
        ? Type
        : layer.kind === "sticker"
          ? Smile
          : layer.kind === "censor"
            ? SquareDashed
            : { rect: Square, ellipse: Circle, line: Minus, arrow: MoveUpRight }[layer.shape];
  return <Icon size={15} aria-hidden />;
}

/** «Коррекция»: the sliders of light, colour and details; a double click on a name puts it back. */
export function AdjustPanel({ adjust, onChange, onCommit }: { adjust: Adjust; onChange: (adjust: Adjust) => void; onCommit: () => void }) {
  const changed = (Object.keys(adjust) as (keyof Adjust)[]).some((key) => adjust[key] !== 0);
  return (
    <div className="photo-panel-body">
      {ADJUSTS.map(({ group, items }) => (
        <section key={group} className="photo-group">
          <p className="photo-label">{group}</p>
          {items.map(({ key, name, min, max }) => (
            <label key={key} className="photo-slider" onDoubleClick={() => (onChange({ ...adjust, [key]: 0 }), onCommit())}>
              <span className="photo-slider-head">
                <span>{name}</span>
                <span className="photo-slider-value">{adjust[key] > 0 && min < 0 ? `+${adjust[key]}` : adjust[key]}</span>
              </span>
              <input
                type="range"
                min={min}
                max={max}
                value={adjust[key]}
                aria-label={name}
                onChange={(e) => onChange({ ...adjust, [key]: Number(e.currentTarget.value) })}
                onPointerUp={onCommit}
                onKeyUp={onCommit}
              />
            </label>
          ))}
        </section>
      ))}
      <button type="button" className="photo-text-button" disabled={!changed} onClick={() => (onChange({ ...NO_ADJUST }), onCommit())}>
        Сбросить коррекцию
      </button>
    </div>
  );
}

/** «Фильтры»: each filter on a small copy of the photo, and how strongly it shows. */
export function FiltersPanel({
  picture,
  filter,
  amount,
  onFilter,
  onAmount,
  onCommit,
}: {
  picture: Picture;
  filter: string;
  amount: number;
  onFilter: (id: string) => void;
  onAmount: (amount: number) => void;
  onCommit: () => void;
}) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const side = 112;
    const k = side / Math.max(picture.width, picture.height, 1);
    const base = document.createElement("canvas");
    base.width = Math.max(1, Math.round(picture.width * k));
    base.height = Math.max(1, Math.round(picture.height * k));
    const ctx = base.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(picture, 0, 0, base.width, base.height);
    const source = ctx.getImageData(0, 0, base.width, base.height);
    const out: Record<string, string> = {};
    for (const f of FILTERS) {
      const copy = new ImageData(new Uint8ClampedArray(source.data), base.width, base.height);
      applyPixels(copy.data, base.width, base.height, effectiveAdjust(NO_ADJUST, f.id, 100), f.id, 100, 7);
      ctx.putImageData(copy, 0, 0);
      out[f.id] = base.toDataURL("image/jpeg", 0.8);
    }
    setThumbs(out);
  }, [picture]);
  return (
    <div className="photo-panel-body">
      <div className="photo-filters" role="list" aria-label="Фильтры">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="listitem" className="photo-filter" aria-label={f.name} aria-pressed={filter === f.id} onClick={() => (onFilter(f.id), onCommit())}>
            {thumbs[f.id] ? <img src={thumbs[f.id]} alt="" /> : <span className="photo-filter-blank" />}
            <span>{f.name}</span>
          </button>
        ))}
      </div>
      {filter !== "none" && (
        <label className="photo-slider">
          <span className="photo-slider-head">
            <span>Сила фильтра</span>
            <span className="photo-slider-value">{amount}%</span>
          </span>
          <input type="range" min={0} max={100} value={amount} aria-label="Сила фильтра" onChange={(e) => onAmount(Number(e.currentTarget.value))} onPointerUp={onCommit} onKeyUp={onCommit} />
        </label>
      )}
    </div>
  );
}

type LayerActions = {
  onSelect: (id: string | null) => void;
  onHide: (id: string) => void;
  onRaise: (id: string, step: 1 | -1) => void;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onOpacity: (id: string, opacity: number) => void;
  onCommit: () => void;
};

/** «Слои»: the layers top first, the photo at the bottom; the chosen one's see-through and its order. */
export function LayersPanel({ layers, selected, actions }: { layers: Layer[]; selected: string | null; actions: LayerActions }) {
  const chosen = layers.find((l) => l.id === selected);
  return (
    <div className="photo-panel-body">
      <ul className="photo-layers" aria-label="Слои">
        {[...layers].reverse().map((layer) => (
          <li key={layer.id} className={layer.id === selected ? "photo-layer chosen" : "photo-layer"}>
            <button type="button" className="photo-layer-name" onClick={() => actions.onSelect(layer.id)}>
              <LayerIcon layer={layer} />
              <span>{layerName(layer)}</span>
            </button>
            <button type="button" className="photo-mini" aria-label={layer.hidden ? "Показать слой" : "Скрыть слой"} onClick={() => actions.onHide(layer.id)}>
              {layer.hidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
            </button>
          </li>
        ))}
        <li className="photo-layer photo-layer-base">
          <span className="photo-layer-name">
            <Image size={15} aria-hidden />
            <span>Фото</span>
          </span>
        </li>
      </ul>
      {layers.length === 0 && <p className="photo-hint">Слоёв пока нет: рисуй, добавляй текст, фигуры и наклейки — каждый станет слоем.</p>}
      {chosen && (
        <div className="photo-layer-tools">
          <label className="photo-slider">
            <span className="photo-slider-head">
              <span>Непрозрачность</span>
              <span className="photo-slider-value">{Math.round(chosen.opacity * 100)}%</span>
            </span>
            <input
              type="range"
              min={5}
              max={100}
              value={Math.round(chosen.opacity * 100)}
              aria-label="Непрозрачность слоя"
              onChange={(e) => actions.onOpacity(chosen.id, Number(e.currentTarget.value) / 100)}
              onPointerUp={actions.onCommit}
              onKeyUp={actions.onCommit}
            />
          </label>
          <div className="photo-row">
            <button type="button" className="photo-mini" title="Выше (Ctrl+])" aria-label="Слой выше" onClick={() => actions.onRaise(chosen.id, 1)}>
              <ArrowUp size={15} aria-hidden />
            </button>
            <button type="button" className="photo-mini" title="Ниже (Ctrl+[)" aria-label="Слой ниже" onClick={() => actions.onRaise(chosen.id, -1)}>
              <ArrowDown size={15} aria-hidden />
            </button>
            <button type="button" className="photo-mini" title="Копия (Ctrl+J)" aria-label="Копия слоя" onClick={() => actions.onCopy(chosen.id)}>
              <Copy size={15} aria-hidden />
            </button>
            <button type="button" className="photo-mini danger" title="Удалить (Delete)" aria-label="Удалить слой" onClick={() => actions.onDelete(chosen.id)}>
              <Trash2 size={15} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const STICKERS = [
  "😀", "😂", "🤣", "😍", "😎", "🤔", "😭", "😡", "🥳", "😇", "🤯", "😱", "🥶", "😴", "🤡", "💩",
  "👍", "👎", "👏", "🙏", "💪", "🤝", "👀", "🙈", "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💯",
  "🔥", "✨", "⭐", "🎉", "🎁", "🎂", "🏆", "🎯", "🎮", "🎧", "🎵", "🎤", "📷", "💡", "💰", "👑",
  "💀", "👻", "🤖", "👽", "🐱", "🐶", "🦊", "🐼", "🐸", "🌹", "🌈", "☀️", "🌙", "⚡", "❄️", "🍀",
  "💎", "🚀", "✈️", "🏠", "🍕", "🍔", "☕", "🍺", "⚽", "🏀", "✅", "❌", "⚠️", "❓", "❗", "💬",
  "➡️", "⬅️", "⬆️", "⬇️", "📌", "⏰",
];

/** «Наклейки»: an emoji to put on the photo (in the middle of the view; then moved, resized and turned as any layer). */
export function StickersPanel({ onPut }: { onPut: (emoji: string) => void }) {
  return (
    <div className="photo-panel-body">
      <div className="photo-stickers" role="list" aria-label="Наклейки">
        {STICKERS.map((emoji) => (
          <button key={emoji} type="button" role="listitem" className="photo-sticker" aria-label={`Наклейка ${emoji}`} onClick={() => onPut(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
