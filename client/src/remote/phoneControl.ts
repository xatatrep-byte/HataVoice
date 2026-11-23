import { useEffect, useState } from "react";
import { android } from "../platform/android";

/**
 * Whether a friend may be asked in to control this device: a PC, and an Android phone (its accessibility service plays
 * the touches). An iPhone lets no program touch for a person, so its answer is no at once. (0.23.0 refused every phone.)
 */
export function controllable(mobile: boolean, isAndroid: boolean): boolean {
  return !mobile || isAndroid;
}

/**
 * This phone's «Управление с ПК»: whether its accessibility service is on, as Android says (asked again on coming back
 * from the settings), and a way to Android's page where the person turns it on, as only they may. Null off a phone.
 */
export function usePhoneControl(): { ready: boolean; openSettings: () => void; openAppInfo: () => void } | null {
  const bridge = android();
  const [ready, setReady] = useState(() => !!bridge?.features?.control);
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.on((word) => {
      if (word.ev === "control" && typeof word.ready === "boolean") setReady(word.ready);
    });
    bridge.send({ op: "control-status" });
    const again = () => {
      if (document.visibilityState === "visible") bridge.send({ op: "control-status" });
    };
    document.addEventListener("visibilitychange", again);
    return () => {
      off();
      document.removeEventListener("visibilitychange", again);
    };
  }, [bridge]);
  if (!bridge) return null;
  return {
    ready,
    openSettings: () => bridge.send({ op: "control-settings" }),
    // Android 13+ greys the switch out for an app installed from a file («Ограниченная настройка») until it is allowed
    // on the app's own page.
    openAppInfo: () => bridge.send({ op: "app-settings" }),
  };
}
