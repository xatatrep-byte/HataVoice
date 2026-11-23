/**
 * A shared window that froze. A game in Windows' own full-screen mode (Minecraft's «Полный экран», for one) gives its
 * window's picture to no one: the capture keeps the last frame — friends see the game standing still, often on the menu
 * where full screen was switched on — and on some PCs the player's own pointer goes while the capture runs. Windows
 * does this to Discord and OBS alike; what helps is the game's «borderless window» mode. So while we show a window, the
 * picture is looked at every couple of seconds: a thumbnail that does not change while Windows says a program fills the
 * screen means the friends see a frozen frame, and they (and we) are told why.
 */

/** How often the shared window is looked at, ms. */
export const FROZEN_CHECK_MS = 2000;
/** Looks in a row that saw the same frame (or none) with a full-screen program in front before it counts as frozen. */
export const FROZEN_AFTER = 3;
/** The thumbnail's size: the moving pointer is about one of its pixels, a game that plays changes many. */
export const THUMB_WIDTH = 32;
export const THUMB_HEIGHT = 18;
/** Mean change of a thumbnail's channel (0–255) under which two frames are the same picture. */
const SAME_BELOW = 1.5;

/** Two thumbnails of the same size (RGBA): the same picture, but for noise and a pointer. */
export function samePicture(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    count += 3;
  }
  return sum / count < SAME_BELOW;
}

/**
 * One more look: `frame` is the thumbnail, or null when no frame came at all; `fullscreen` whether Windows says a
 * program fills the screen. Gives the new count of stuck looks (frozen from FROZEN_AFTER on) and the frame to compare
 * the next one with.
 */
export function nextLook(
  state: { stuck: number; last: Uint8ClampedArray | null },
  frame: Uint8ClampedArray | null,
  fullscreen: boolean,
): { stuck: number; last: Uint8ClampedArray | null } {
  const still = frame === null || (state.last !== null && samePicture(state.last, frame));
  return { stuck: fullscreen && still ? state.stuck + 1 : 0, last: frame ?? state.last };
}

export const isFrozen = (stuck: number) => stuck >= FROZEN_AFTER;

/** What we are told when the window we show froze (friends get the same on the picture). */
export const FROZEN_WINDOW_TEXT =
  "Друзья видят застывший кадр: игра на весь экран, а в этом режиме Windows не отдаёт картинку окна. Переключи игру в «оконный без рамки» — в Minecraft это F11, а потом развернуть окно";
