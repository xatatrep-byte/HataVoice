import { useLayoutEffect, useRef, useState } from "react";
import { EMOTES, INTERACTIONS } from "../../characters/character";
import { Emoji } from "../../ui/Emoji";
import { type MenuPlace, placeActMenu } from "./menuPlace";
import "./stage.css";

type Props = {
  /** Where the character was clicked, window coordinates. */
  at: { x: number; y: number };
  /** Our own character: its emotes; someone else's: what to do with them. */
  mine: boolean;
  name: string;
  onAct: (act: string) => void;
  onClose: () => void;
};

/**
 * The menu over a clicked character, on the call's stage and on the desktop alike: whole inside the window wherever the
 * click was, a long list scrolling in it under its title; a click beside it closes it.
 */
export function ActMenu({ at, mine, name, onAct, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<MenuPlace | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const menu = box.current;
      const grid = list.current;
      if (!menu || !grid) return;
      // The whole list's height, though the menu may already be cut to the window and scrolling.
      const height = menu.offsetHeight - grid.clientHeight + grid.scrollHeight;
      setPlace(placeActMenu(at, { width: menu.offsetWidth, height }, { width: window.innerWidth, height: window.innerHeight }));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [at]);
  return (
    <>
      <div className="act-menu-shade" onClick={onClose} />
      <div
        ref={box}
        className="act-menu"
        role="menu"
        aria-label={mine ? "Эмоции" : `Что сделать с ${name}`}
        style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { left: 0, top: 0, visibility: "hidden" }}
      >
        <span className="act-menu-title">{mine ? "Твой персонаж" : name}</span>
        <div ref={list} className="act-grid">
          {(mine ? EMOTES : INTERACTIONS).map((a) => (
            <button key={a.id} type="button" role="menuitem" className="act-button" onClick={() => onAct(a.id)}>
              <Emoji kind="act" id={a.id} fallback={a.emoji} size={40} />
              {a.name}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
