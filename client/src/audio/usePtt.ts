import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IS_MOBILE } from "../platform";
import { android, IS_ANDROID } from "../platform/android";
import { createPttGate, type PttGate } from "./pttGate";

// Event names emitted by client/src-tauri/src/ptt_hook.rs.
const PTT_EVENT = "ptt";
const CAPTURED_EVENT = "ptt-captured";

// The key is watched by a Windows hook or a Mac's event tap; Linux has no such thing to offer yet.
export const pttSupported = isTauri() && !IS_MOBILE && !/linux/i.test(navigator.userAgent);

/**
 * An Android phone: a key on the call's screen held while speaking, and a key of the phone if one is set (volume, a
 * headset's, a Bluetooth keyboard's), while the app is in front.
 */
export const pttPhone = IS_ANDROID && android() !== null;

/** Push-to-talk can be picked here at all. */
export const pttAvailable = pttSupported || pttPhone;

/** A phone's key as the person reads it. */
export function phoneKeyLabel(key: string | null): string {
  if (!key) return "Не назначена";
  const known: Record<string, string> = {
    KEYCODE_VOLUME_DOWN: "Громкость −",
    KEYCODE_VOLUME_UP: "Громкость +",
    KEYCODE_HEADSETHOOK: "Кнопка гарнитуры",
    KEYCODE_MEDIA_PLAY_PAUSE: "Пауза на гарнитуре",
    KEYCODE_SPACE: "Пробел",
    KEYCODE_CAMERA: "Кнопка камеры",
  };
  return known[key] ?? key.replace(/^KEYCODE_/, "").replace(/_/g, " ").toLowerCase();
}

/**
 * Push-to-talk. While `enabled`, the Rust hook watches `binding` (a PC), or Android the key `phoneKey` and the screen's
 * key calls `press`/`release` (a phone); `open` is true while held plus `tailMs` after release.
 */
export function usePtt({
  enabled,
  binding,
  tailMs,
  phoneKey = null,
}: {
  enabled: boolean;
  binding: string[];
  tailMs: number;
  phoneKey?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const captureUnlisten = useRef<UnlistenFn | null>(null);
  const phoneGate = useRef<PttGate | null>(null);
  const bindingKey = binding.join("|");

  useEffect(() => {
    if (!pttSupported) return;
    const active = enabled ? bindingKey.split("|").filter(Boolean) : [];
    invoke("ptt_set_binding", { binding: active })
      .then(() => setError(null))
      .catch((e) => setError(String(e)));
  }, [enabled, bindingKey]);

  useEffect(() => {
    if (!pttSupported || !enabled) return;
    const gate = createPttGate({ tailMs, onChange: setOpen });
    const unlisten = listen<boolean>(PTT_EVENT, (e) => (e.payload ? gate.press() : gate.release()));
    return () => {
      gate.dispose();
      setOpen(false);
      void unlisten.then((f) => f());
    };
  }, [enabled, tailMs]);

  // A phone: the screen's key and the phone's own key open the same gate.
  useEffect(() => {
    const bridge = android();
    if (!pttPhone || !bridge || !enabled) return;
    const gate = createPttGate({ tailMs, onChange: setOpen });
    phoneGate.current = gate;
    bridge.send({ op: "keys", watch: phoneKey ? [phoneKey] : [] });
    const off = bridge.on((word) => {
      if (word.ev === "key" && word.key === phoneKey) (word.down === true ? gate.press() : gate.release());
    });
    return () => {
      off();
      bridge.send({ op: "keys", watch: [] });
      gate.dispose();
      phoneGate.current = null;
      setOpen(false);
    };
  }, [enabled, tailMs, phoneKey]);

  const press = useCallback(() => phoneGate.current?.press(), []);
  const release = useCallback(() => phoneGate.current?.release(), []);

  const stopCapture = useCallback(() => {
    captureUnlisten.current?.();
    captureUnlisten.current = null;
    setCapturing(false);
  }, []);

  /** Waits for the user to press a new combo (on a phone: a key of the phone) and passes it to `onCaptured`. */
  const startCapture = useCallback(
    async (onCaptured: (binding: string[]) => void) => {
      const bridge = android();
      if (pttPhone && bridge) {
        stopCapture();
        setCapturing(true);
        const off = bridge.on((word) => {
          if (word.ev !== "key-captured" || typeof word.key !== "string") return;
          stopCapture();
          onCaptured([word.key]);
        });
        captureUnlisten.current = () => {
          off();
          bridge.send({ op: "keys", capture: false });
        };
        bridge.send({ op: "keys", capture: true });
        return;
      }
      if (!pttSupported) return;
      stopCapture();
      setCapturing(true);
      captureUnlisten.current = await listen<string[]>(CAPTURED_EVENT, (e) => {
        stopCapture();
        onCaptured(e.payload);
      });
      try {
        await invoke("ptt_capture", { active: true });
      } catch (e) {
        stopCapture();
        setError(String(e));
      }
    },
    [stopCapture],
  );

  const cancelCapture = useCallback(() => {
    stopCapture();
    if (pttSupported) void invoke("ptt_capture", { active: false });
  }, [stopCapture]);

  useEffect(() => stopCapture, [stopCapture]);

  return { open, error, capturing, startCapture, cancelCapture, press, release };
}
