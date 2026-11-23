import { useEffect, useRef, type ReactNode } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import type { Drawer as DrawerState, DrawerTab } from "./useDrawer";
import "./drawer.css";

type Props = {
  drawer: DrawerState;
  /** It stands beside the page instead of over it. */
  pinned: boolean;
  /** The window is wide enough for that (and it is not a phone). */
  canPin: boolean;
  onPin: (on: boolean) => void;
  /** New messages, on the tab «Чаты». */
  unread: number;
  /** An open chat fills the panel; it gets the panel's buttons for its own head. */
  conversation: ((actions: ReactNode) => ReactNode) | null;
  chats: ReactNode;
  people: ReactNode;
};

const TABS: { id: DrawerTab; label: string }[] = [
  { id: "chats", label: "Чаты" },
  { id: "people", label: "Люди" },
];

/** Whether a click landed in something that floats over the panel: a dialog, the palette, a menu of the bar. */
function overPanel(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[role="dialog"], [role="alertdialog"], .modal-backdrop, .palette-shade, .top-chats, .dock-chat, .toast');
}

/** The panel of chats and people at the left of the window. */
export function Drawer({ drawer, pinned, canPin, onPin, unread, conversation, chats, people }: Props) {
  const box = useRef<HTMLElement>(null);
  const floating = !pinned;
  const { open, peek, hide } = drawer;

  // A panel opened by a click goes on Escape or a click elsewhere; one that peeks goes with the mouse.
  useEffect(() => {
    if (!open || !floating || peek) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !overPanel(e.target)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if (e.key === "Escape" && !typing && !document.querySelector('[role="dialog"]')) hide();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, floating, peek, hide]);

  // A panel that peeks follows the mouse itself: a quick move off the edge may never cross it, so no leave would come.
  const { enter, leave } = drawer;
  useEffect(() => {
    if (!open || !peek || pinned) return;
    const move = (e: MouseEvent) => (box.current?.contains(e.target as Node) || overPanel(e.target) ? enter() : leave());
    document.addEventListener("mousemove", move);
    return () => document.removeEventListener("mousemove", move);
  }, [open, peek, pinned, enter, leave]);

  if (!open && !pinned) return null;

  const actions = (
    <>
      {canPin && (
        <IconButton label={pinned ? "Открепить панель" : "Закрепить панель"} active={pinned} className="drawer-pin" onClick={() => onPin(!pinned)}>
          {pinned ? <PinOff size={16} /> : <Pin size={16} />}
        </IconButton>
      )}
      <IconButton label="Закрыть панель" onClick={() => (pinned ? onPin(false) : hide())}>
        <X size={16} />
      </IconButton>
    </>
  );

  return (
    <aside
      ref={box}
      className={pinned ? "drawer pinned" : "drawer"}
      aria-label="Чаты и люди"
      onMouseEnter={drawer.enter}
      onMouseLeave={drawer.leave}
      onPointerDown={drawer.touch}
      onKeyDown={drawer.touch}
    >
      {conversation ? (
        conversation(actions)
      ) : (
        <>
          <header className="drawer-head">
            <div className="drawer-tabs" role="tablist" aria-label="Чаты и люди">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={drawer.tab === t.id} className="drawer-tab" onClick={() => drawer.setTab(t.id)}>
                  {t.label}
                  {t.id === "chats" && unread > 0 && <span className="top-count">{unread > 99 ? "99+" : unread}</span>}
                </button>
              ))}
            </div>
            <span className="drawer-head-actions">{actions}</span>
          </header>
          {drawer.tab === "chats" ? chats : people}
        </>
      )}
    </aside>
  );
}

/** The thin handle at the window's left edge: rest the mouse on it and the panel slides out. */
export function DrawerEdge({ drawer, news }: { drawer: DrawerState; news: boolean }) {
  return (
    <div className="drawer-edge" aria-hidden onMouseEnter={drawer.edgeEnter} onMouseLeave={drawer.edgeLeave}>
      <span className={news ? "drawer-handle news" : "drawer-handle"} />
    </div>
  );
}
