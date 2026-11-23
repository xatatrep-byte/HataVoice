import { studio } from "../../studio/engine";
import { DEFAULT_LOOK, type StudioSource } from "../../studio/layout";
import { Button } from "../../ui/Button";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";

/** What can be done with the source chosen: its text or color, crop, look and green screen. */
export function SourceProperties({ source }: { source: StudioSource }) {
  const { id, look, kind, text, color } = source;
  const picture = kind === "screen" || kind === "camera" || kind === "image";
  const setCrop = (side: keyof typeof look.crop, percent: number) => studio.setLook(id, { crop: { ...look.crop, [side]: percent / 100 } });
  return (
    <section className="studio-section" aria-label="Свойства источника">
      <h2>{source.name}</h2>
      {(kind === "text" || kind === "clock") && text && (
        <>
          {kind === "text" && (
            <label className="field">
              <span className="field-label">Текст</span>
              <input className="input" aria-label="Текст надписи" value={text.text} maxLength={120} onChange={(e) => studio.update(id, { text: { ...text, text: e.currentTarget.value } })} />
            </label>
          )}
          <Slider label="Размер" min={16} max={240} step={2} value={text.size} onChange={(size) => studio.update(id, { text: { ...text, size } })} />
          <Slider label="Обводка" min={0} max={16} value={text.outline} format={(v) => `${v} пкс`} onChange={(outline) => studio.update(id, { text: { ...text, outline } })} />
          <div className="field-row">
            <label className="studio-color">
              <input type="color" aria-label="Цвет надписи" value={text.color} onChange={(e) => studio.update(id, { text: { ...text, color: e.currentTarget.value } })} />
              Цвет
            </label>
          </div>
          <Toggle label="Жирный" checked={text.bold} onChange={(bold) => studio.update(id, { text: { ...text, bold } })} />
        </>
      )}
      {kind === "color" && (
        <div className="field-row">
          <label className="studio-color">
            <input type="color" aria-label="Цвет заливки" value={color ?? "#000000"} onChange={(e) => studio.update(id, { color: e.currentTarget.value })} />
            Цвет заливки
          </label>
        </div>
      )}
      <Slider label="Непрозрачность" min={0} max={100} step={1} value={Math.round(look.opacity * 100)} format={(v) => `${v}%`} onChange={(v) => studio.setLook(id, { opacity: v / 100 })} />
      <Slider label="Поворот" min={-180} max={180} value={look.rotate} format={(v) => `${v}°`} onChange={(rotate) => studio.setLook(id, { rotate })} />
      <Slider label="Скругление углов" min={0} max={200} value={look.radius} format={(v) => `${v} пкс`} onChange={(radius) => studio.setLook(id, { radius })} />
      {picture && (
        <>
          <h3 className="settings-sub">Обрезка</h3>
          <Slider label="Слева" min={0} max={45} value={Math.round(look.crop.left * 100)} format={(v) => `${v}%`} onChange={(v) => setCrop("left", v)} />
          <Slider label="Справа" min={0} max={45} value={Math.round(look.crop.right * 100)} format={(v) => `${v}%`} onChange={(v) => setCrop("right", v)} />
          <Slider label="Сверху" min={0} max={45} value={Math.round(look.crop.top * 100)} format={(v) => `${v}%`} onChange={(v) => setCrop("top", v)} />
          <Slider label="Снизу" min={0} max={45} value={Math.round(look.crop.bottom * 100)} format={(v) => `${v}%`} onChange={(v) => setCrop("bottom", v)} />
          <Toggle label="Отразить" checked={look.flip} onChange={(flip) => studio.setLook(id, { flip })} />
          <h3 className="settings-sub">Цвет</h3>
          <Slider label="Яркость" min={40} max={180} value={look.brightness} format={(v) => `${v}%`} onChange={(brightness) => studio.setLook(id, { brightness })} />
          <Slider label="Контраст" min={40} max={180} value={look.contrast} format={(v) => `${v}%`} onChange={(contrast) => studio.setLook(id, { contrast })} />
          <Slider label="Насыщенность" min={0} max={200} value={look.saturate} format={(v) => `${v}%`} onChange={(saturate) => studio.setLook(id, { saturate })} />
          <Slider label="Размытие" min={0} max={40} value={look.blur} format={(v) => `${v} пкс`} onChange={(blur) => studio.setLook(id, { blur })} />
        </>
      )}
      {(kind === "camera" || kind === "screen") && (
        <>
          <h3 className="settings-sub">Хромакей</h3>
          <Toggle label="Убрать фон одного цвета" hint="Для зелёного экрана за спиной" checked={!!look.chroma} onChange={(on) => studio.setLook(id, { chroma: on ? { color: "#00b140", similarity: 0.13, smooth: 0.08 } : null })} />
          {look.chroma && (
            <>
              <div className="field-row">
                <label className="studio-color">
                  <input type="color" aria-label="Цвет фона" value={look.chroma.color} onChange={(e) => studio.setLook(id, { chroma: { ...look.chroma!, color: e.currentTarget.value } })} />
                  Цвет фона
                </label>
              </div>
              <Slider label="Схожесть" min={1} max={50} value={Math.round(look.chroma.similarity * 100)} format={(v) => `${v}`} onChange={(v) => studio.setLook(id, { chroma: { ...look.chroma!, similarity: v / 100 } })} />
              <Slider label="Мягкость края" min={1} max={40} value={Math.round(look.chroma.smooth * 100)} format={(v) => `${v}`} onChange={(v) => studio.setLook(id, { chroma: { ...look.chroma!, smooth: v / 100 } })} />
            </>
          )}
        </>
      )}
      <Button variant="ghost" onClick={() => studio.setLook(id, DEFAULT_LOOK)}>
        Сбросить вид
      </Button>
    </section>
  );
}
