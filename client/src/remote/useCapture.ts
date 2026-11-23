import { useEffect, useRef } from "react";
import type { RemoteInput } from "./api";
import { MOVE_EVERY_MS, mouseButton, sendableKey, videoPoint, wheelUnits, type MouseButton } from "./capture";
import { LONG_PRESS_MS, TouchControl } from "./touch";
import type { TouchpadControl } from "./touchpad";

/**
 * Our own pointer over the picture: a ring with a dot. It moves at once, with our mouse; the other PC's arrow in the
 * picture follows it after the picture's way here (capture, encoder, network). Windows' capture always draws that arrow
 * in (Chromium takes no `cursor: "never"`), so ours is a ring, not a second arrow.
 */
export const REMOTE_POINTER =
  'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27%3E%3Ccircle cx=%2710%27 cy=%2710%27 r=%277%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%273.5%27/%3E%3Ccircle cx=%2710%27 cy=%2710%27 r=%277%27 fill=%27none%27 stroke=%27%23fff%27 stroke-width=%271.6%27/%3E%3Ccircle cx=%2710%27 cy=%2710%27 r=%271.6%27 fill=%27%23fff%27 stroke=%27%23000%27 stroke-width=%27.8%27/%3E%3C/svg%3E") 10 10, crosshair';

/**
 * While `on`, what the mouse and (with `keyboard`) the keys do on the picture `video` goes to the PC it shows:
 * moves as fast as the mouse gives them (up to 250 a second, the newest only), clicks, wheel and keys reliably, each
 * click after a move to its place. Whatever is held down is let go of when the picture loses the focus or control ends:
 * no key stays stuck there. Over the picture our pointer is a ring that moves at once (`REMOTE_POINTER`). A finger works
 * as on a touchpad when `pad` is given (a phone: `TouchpadControl`), otherwise as in `TouchControl` (a PC's touch screen):
 * tap to click, move to drag, hold or tap with two fingers for the right button, two fingers to scroll.
 */
export function useCapture(
  video: HTMLVideoElement | null,
  on: boolean,
  keyboard: boolean,
  send: (input: RemoteInput, lossy: boolean) => void,
  pad: TouchpadControl | null = null,
  /** The PC controls a phone: a letter typed goes as the letter (a phone has a field, not a PC's keys). */
  phone = false,
) {
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!video || !on) return;
    const send = (input: RemoteInput, lossy: boolean) => sendRef.current(input, lossy);
    const keys = new Set<string>();
    const buttons = new Set<MouseButton>();
    let timer = 0;
    let sentAt = -Infinity;
    let pending: { x: number; y: number } | null = null;

    const pointAt = (e: MouseEvent) => videoPoint(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, e.clientX, e.clientY);
    const touch = new TouchControl((x, y) => videoPoint(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, x, y), send);
    let holdTimer = 0;
    const flushMove = () => {
      timer = 0;
      if (pending) send({ t: "move", ...pending }, true);
      pending = null;
      sentAt = performance.now();
    };
    // A move goes at once, unless one went less than MOVE_EVERY_MS ago: then the newest goes when that time is up.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        if (e.type !== "pointermove") return;
        if (pad) pad.move(e.pointerId, e.clientX, e.clientY, performance.now());
        else touch.move(e.pointerId, e.clientX, e.clientY);
        return;
      }
      pending = pointAt(e);
      if (!pending || timer) return;
      const wait = MOVE_EVERY_MS - (performance.now() - sentAt);
      if (wait <= 0) flushMove();
      else timer = window.setTimeout(flushMove, wait);
    };
    // `pointerrawupdate` comes as the mouse reports, not once a frame; the ordinary moves too, in case it never comes
    // (the limit above keeps the two from doubling what goes out).
    const moveEvents = "onpointerrawupdate" in video ? ["pointerrawupdate", "pointermove"] : ["pointermove"];
    const onButton = (down: boolean) => (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        e.preventDefault();
        const now = performance.now();
        if (pad) {
          if (down) {
            pad.down(e.pointerId, e.clientX, e.clientY, now);
            try {
              video.setPointerCapture?.(e.pointerId);
            } catch {
              // A pointer the browser no longer knows: the touch is followed without it.
            }
          } else pad.up(e.pointerId, now);
          return;
        }
        if (down) {
          touch.down(e.pointerId, e.clientX, e.clientY, now);
          try {
            video.setPointerCapture?.(e.pointerId);
          } catch {
            // A pointer the browser no longer knows: the touch is followed without it.
          }
          clearTimeout(holdTimer);
          holdTimer = window.setTimeout(() => touch.hold(performance.now()), LONG_PRESS_MS);
        } else touch.up(e.pointerId, now);
        return;
      }
      const button = mouseButton(e.button);
      const point = pointAt(e);
      if (!button || (down && !point)) return;
      e.preventDefault();
      if (down) video.focus();
      if (point) send({ t: "move", ...point }, false);
      send({ t: "button", b: button, down }, false);
      if (down) buttons.add(button);
      else buttons.delete(button);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = wheelUnits(e.deltaY, e.deltaMode);
      const dx = -wheelUnits(e.deltaX, e.deltaMode);
      if (dx || dy) send({ t: "wheel", dx, dy }, false);
    };
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (!keyboard) return;
      if (phone && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (down) send({ t: "text", s: e.key }, false);
        return;
      }
      if (!sendableKey(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      send({ t: "key", code: e.code, down }, false);
      if (down) keys.add(e.code);
      else keys.delete(e.code);
    };
    const letGo = () => {
      touch.cancel();
      pad?.cancel();
      for (const code of keys) send({ t: "key", code, down: false }, false);
      for (const b of buttons) send({ t: "button", b, down: false }, false);
      keys.clear();
      buttons.clear();
    };
    const noMenu = (e: Event) => e.preventDefault();
    const down = onButton(true);
    const up = onButton(false);
    const keyDown = onKey(true);
    const keyUp = onKey(false);

    const onCancel = () => {
      touch.cancel();
      pad?.cancel();
    };
    video.tabIndex = 0;
    video.style.cursor = REMOTE_POINTER;
    // A finger on the picture is the friend's mouse: the page neither scrolls nor zooms under it.
    video.style.touchAction = "none";
    for (const name of moveEvents) video.addEventListener(name, onMove as EventListener);
    video.addEventListener("pointerdown", down);
    video.addEventListener("pointerup", up);
    video.addEventListener("pointercancel", onCancel);
    video.addEventListener("wheel", onWheel, { passive: false });
    video.addEventListener("contextmenu", noMenu);
    video.addEventListener("keydown", keyDown);
    video.addEventListener("keyup", keyUp);
    video.addEventListener("blur", letGo);
    return () => {
      letGo();
      clearTimeout(timer);
      clearTimeout(holdTimer);
      video.removeEventListener("pointercancel", onCancel);
      video.style.touchAction = "";
      for (const name of moveEvents) video.removeEventListener(name, onMove as EventListener);
      video.removeEventListener("pointerdown", down);
      video.removeEventListener("pointerup", up);
      video.removeEventListener("wheel", onWheel);
      video.removeEventListener("contextmenu", noMenu);
      video.removeEventListener("keydown", keyDown);
      video.removeEventListener("keyup", keyUp);
      video.removeEventListener("blur", letGo);
      video.removeAttribute("tabindex");
      video.style.cursor = "";
    };
  }, [video, on, keyboard, pad, phone]);
}
