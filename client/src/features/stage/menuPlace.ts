/** Between the click and the menu. */
export const MENU_GAP = 12;
/** Between the menu and the window's edges. */
export const MENU_EDGE = 12;
/** The menu stays this small at most, by the click: a longer list scrolls in it (the owner: not the whole window). */
export const MENU_MAX_HEIGHT = 420;

type Point = { x: number; y: number };
type Size = { width: number; height: number };
export type MenuPlace = { left: number; top: number; maxHeight: number };

/**
 * Where the menu over a clicked character goes: under the click if it fits, over it if that fits, else as low as it
 * can while whole. It is never taller than MENU_MAX_HEIGHT nor the window: a longer list scrolls inside it.
 */
export function placeActMenu(at: Point, size: Size, view: Size): MenuPlace {
  const maxHeight = Math.max(0, Math.min(MENU_MAX_HEIGHT, view.height - 2 * MENU_EDGE));
  const height = Math.min(size.height, maxHeight);
  const left = Math.max(MENU_EDGE, Math.min(at.x - size.width / 2, view.width - MENU_EDGE - size.width));
  const below = at.y + MENU_GAP;
  const above = at.y - MENU_GAP - height;
  let top: number;
  if (below + height <= view.height - MENU_EDGE) top = below;
  else if (above >= MENU_EDGE) top = above;
  else top = Math.max(MENU_EDGE, view.height - MENU_EDGE - height);
  return { left, top, maxHeight };
}

/** Between a tile and its menu. */
const NEAR_GAP = 6;

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Where a menu of something on the page goes (a friend's tile): under it if it fits, over it if that fits, else as low
 * as it can while whole; within the window's sides. Never taller than the window: a longer menu scrolls inside.
 */
export function placeNear(rect: Rect, size: Size, view: Size): MenuPlace {
  const maxHeight = Math.max(0, view.height - 2 * MENU_EDGE);
  const height = Math.min(size.height, maxHeight);
  const left = Math.max(MENU_EDGE, Math.min(rect.left, view.width - MENU_EDGE - size.width));
  const below = rect.bottom + NEAR_GAP;
  const above = rect.top - NEAR_GAP - height;
  let top: number;
  if (below + height <= view.height - MENU_EDGE) top = below;
  else if (above >= MENU_EDGE) top = above;
  else top = Math.max(MENU_EDGE, view.height - MENU_EDGE - height);
  return { left, top, maxHeight };
}
