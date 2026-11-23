import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type Props = {
  /** What the card belongs to: it opens below it, or above when there is no room below. */
  anchor: RefObject<HTMLElement | null>;
  className: string;
  id?: string;
  role?: string;
  children: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

const GAP = 8;
const MARGIN = 12;

/**
 * A card over everything, on the window itself rather than inside its box: a settings page that scrolls, or a tile that
 * clips what sticks out, cannot cut it. Kept inside the window; taller than the window, it scrolls.
 */
export function Floating({ anchor, className, id, role, children, onMouseEnter, onMouseLeave }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const c = card.current?.getBoundingClientRect();
    if (!a || !c) return;
    const height = Math.min(c.height, window.innerHeight - 2 * MARGIN);
    let top = a.bottom + GAP;
    if (top + height > window.innerHeight - MARGIN && a.top - GAP - height >= MARGIN) top = a.top - GAP - height;
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - MARGIN - height));
    const left = Math.max(MARGIN, Math.min(a.left - 12, window.innerWidth - MARGIN - c.width));
    setPlace({ left, top });
  }, [anchor]);

  return createPortal(
    <div
      ref={card}
      className={className}
      id={id}
      role={role}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: "fixed",
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: place ? "visible" : "hidden",
        maxHeight: `calc(100vh - ${2 * MARGIN}px)`,
        overflowY: "auto",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
