import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Floating } from "./Floating";

type Props = {
  /** What the button says to a screen reader: «Чем отличаются кодеки». */
  label: string;
  children: ReactNode;
};

/** How long the pointer rests on the button before the card shows, and how long it stays after the pointer leaves. */
const OPEN_MS = 150;
const CLOSE_MS = 450;

/**
 * A small «i» next to a field with a fuller explanation in a card, so the field itself keeps a short name. Resting the
 * pointer on it shows the card for as long as the pointer is on the button or the card (it forgives the trip between
 * them); a click pins the card open until a click elsewhere, Escape or another click on the «i».
 */
export function InfoTip({ label, children }: Props) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  const later = (value: boolean, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(value), ms);
  };
  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    setPinned(false);
    setOpen(false);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  // A pinned card goes with a click anywhere else, or Escape.
  useEffect(() => {
    if (!pinned) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (button.current?.contains(target) || document.getElementById(id)?.contains(target))) return;
      close();
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [pinned, id]);

  const hoverIn = () => !pinned && later(true, OPEN_MS);
  const hoverOut = () => !pinned && later(false, CLOSE_MS);

  return (
    <span className="infotip" onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
      <button
        ref={button}
        type="button"
        className={pinned ? "infotip-button pinned" : "infotip-button"}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (pinned) return close();
          if (timer.current) clearTimeout(timer.current);
          setPinned(true);
          setOpen(true);
        }}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <Info size={16} aria-hidden />
      </button>
      {open && (
        <Floating anchor={button} className="infotip-card" id={id} role="tooltip" onMouseEnter={() => !pinned && later(true, 0)} onMouseLeave={hoverOut}>
          {children}
        </Floating>
      )}
    </span>
  );
}
