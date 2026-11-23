/**
 * What the one in control does on the picture of the other's screen, turned into input for that screen: where the
 * pointer is as fractions of the picture (0–65535), wheel steps, buttons. Pure, so it is tested without a call.
 */

export type Box = { left: number; top: number; width: number; height: number };

/** The shortest time between two mouse moves sent, ms: 250 a second, as a gaming mouse reports and Parsec sends. */
export const MOVE_EVERY_MS = 4;

/**
 * The point under the pointer as fractions (0–65535) of the picture itself, which `object-fit: contain` puts in the
 * middle of the element with bars around it; null over the bars.
 */
export function videoPoint(element: Box, videoWidth: number, videoHeight: number, clientX: number, clientY: number): { x: number; y: number } | null {
  const box = pictureBox(element, videoWidth, videoHeight);
  if (!box) return null;
  const { left, top, width, height } = box;
  const fx = (clientX - left) / width;
  const fy = (clientY - top) / height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return { x: Math.round(fx * 65535), y: Math.round(fy * 65535) };
}

/** Lines and pages of a wheel event as Windows wheel units (120 a step), down the page being negative as in Windows. */
export function wheelUnits(delta: number, mode: number): number {
  // deltaMode: 0 pixels (about 100 a step in Chromium), 1 lines (3 a step), 2 pages.
  const steps = mode === 1 ? delta / 3 : mode === 2 ? delta * 3 : delta / 100;
  const units = Math.round(-steps * 120);
  return Math.max(-1200, Math.min(1200, units));
}

export type MouseButton = "left" | "right" | "middle";

/** `MouseEvent.button` as the input's button; null for the side buttons (not played). */
export function mouseButton(button: number): MouseButton | null {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : null;
}

/** A key worth sending: a real key code, not «Unidentified». */
export function sendableKey(code: string): boolean {
  return /^[A-Za-z0-9]{1,24}$/.test(code) && code !== "Unidentified";
}

/** Where the picture itself is in its element (contained: bars on two sides), or null before it has a size. */
export function pictureBox(element: Box, videoWidth: number, videoHeight: number): Box | null {
  if (videoWidth <= 0 || videoHeight <= 0 || element.width <= 0 || element.height <= 0) return null;
  const scale = Math.min(element.width / videoWidth, element.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { left: element.left + (element.width - width) / 2, top: element.top + (element.height - height) / 2, width, height };
}
