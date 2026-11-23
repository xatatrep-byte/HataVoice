import { useEffect, useRef, useState } from "react";
import { android } from "../../platform/android";
import type { PhoneRoute } from "../../state/prefs";

type Options = {
  inCall: boolean;
  /** Our camera is on (Android must know, or it cuts the camera when the app goes to the background). */
  camera: boolean;
  /** The server hosted on this phone runs. */
  hosting: boolean;
  /** The person allows the small window over other apps during a call. */
  pip: boolean;
  route: PhoneRoute;
  /** The person wants chat messages told while the app is in the background. */
  online: boolean;
  onLeave: () => void;
};

/** Chromium sets where the call is heard when the microphone opens: ours is set again a moment after. */
const ROUTE_AGAIN_MS = 1500;

/**
 * What Android has to know about the app — a call, the camera, a server hosted here, so it keeps them going with the screen
 * off — and what it tells back: «Выйти из звонка» from the notification, the small window over other apps. In the small
 * window the page shows only the call's stage (`html[data-pip]`, see phone.css).
 */
export function useAndroid({ inCall, camera, hosting, pip, route, online, onLeave }: Options) {
  const [inPip, setInPip] = useState(false);
  const leave = useRef(onLeave);
  leave.current = onLeave;

  useEffect(() => {
    android()?.send({ op: "call", on: inCall, camera: inCall && camera });
  }, [inCall, camera]);
  useEffect(() => {
    android()?.send({ op: "server", on: hosting });
  }, [hosting]);
  useEffect(() => {
    android()?.send({ op: "online", on: online });
  }, [online]);
  useEffect(() => {
    android()?.send({ op: "pip", allowed: inCall && pip });
  }, [inCall, pip]);
  useEffect(() => {
    const bridge = android();
    if (!bridge || !inCall) return;
    bridge.send({ op: "route", to: route });
    const again = setTimeout(() => bridge.send({ op: "route", to: route }), ROUTE_AGAIN_MS);
    return () => clearTimeout(again);
  }, [inCall, route]);
  useEffect(
    () =>
      android()?.on((word) => {
        if (word.ev === "leave") leave.current();
        else if (word.ev === "pip") setInPip(word.on === true);
      }),
    [],
  );
  useEffect(() => {
    document.documentElement.toggleAttribute("data-pip", inPip);
  }, [inPip]);
  return { inPip };
}

/** Where the call can be heard now, as Android tells it (for the setting). */
export function useAudioRoutes(): { available: PhoneRoute[]; now: PhoneRoute } | null {
  const [routes, setRoutes] = useState<{ available: PhoneRoute[]; now: PhoneRoute } | null>(null);
  useEffect(() => {
    const bridge = android();
    if (!bridge) return;
    const off = bridge.on((word) => {
      if (word.ev !== "route" || !Array.isArray(word.available)) return;
      setRoutes({ available: word.available.filter((r): r is PhoneRoute => typeof r === "string"), now: (typeof word.now === "string" ? word.now : "auto") as PhoneRoute });
    });
    bridge.send({ op: "routes" });
    return off;
  }, []);
  return routes;
}
