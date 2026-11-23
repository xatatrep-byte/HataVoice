import { useCallback, useEffect, useRef, useState } from "react";

export type DrawerTab = "chats" | "people";

/** The mouse rests at the window's edge this long before the panel slides out: passing by opens nothing. */
export const PEEK_MS = 220;
/** A panel the edge opened may lose the mouse this long before it slides back. */
export const LEAVE_MS = 400;

/**
 * The panel of chats and people at the left: open or not, which tab, and whether it only peeks (the edge opened it,
 * so it goes when the mouse leaves) or stays (a click opened it, or it was touched).
 */
export function useDrawer() {
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const [tab, setTab] = useState<DrawerTab>("chats");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opening = useRef(false);
  const closing = useRef(false);
  const now = useRef({ open, peek });
  now.current = { open, peek };

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    opening.current = false;
    closing.current = false;
  };
  useEffect(() => clear, []);

  const show = useCallback((next?: DrawerTab) => {
    clear();
    if (next) setTab(next);
    setOpen(true);
    setPeek(false);
  }, []);
  const hide = useCallback(() => {
    clear();
    setOpen(false);
    setPeek(false);
  }, []);
  /** The button in the bar: a peek becomes a stay; a stay goes. */
  const toggle = useCallback(() => {
    if (now.current.open && !now.current.peek) hide();
    else show();
  }, [hide, show]);
  const edgeEnter = useCallback(() => {
    if (now.current.open) return;
    clear();
    opening.current = true;
    timer.current = setTimeout(() => {
      opening.current = false;
      timer.current = null;
      setOpen(true);
      setPeek(true);
    }, PEEK_MS);
  }, []);
  const edgeLeave = useCallback(() => {
    if (opening.current) clear();
  }, []);
  /** The mouse over the panel again. */
  const enter = useCallback(() => {
    if (now.current.peek) clear();
  }, []);
  /** The mouse away from the panel; said again while it moves away, the countdown goes on. */
  const leave = useCallback(() => {
    if (!now.current.peek || closing.current) return;
    clear();
    closing.current = true;
    timer.current = setTimeout(() => {
      timer.current = null;
      closing.current = false;
      setOpen(false);
      setPeek(false);
    }, LEAVE_MS);
  }, []);
  /** A click or a key inside: whoever touched it wants it to stay. */
  const touch = useCallback(() => {
    if (!now.current.peek) return;
    clear();
    setPeek(false);
  }, []);

  return { open, peek, tab, setTab, show, hide, toggle, edgeEnter, edgeLeave, enter, leave, touch };
}

export type Drawer = ReturnType<typeof useDrawer>;
