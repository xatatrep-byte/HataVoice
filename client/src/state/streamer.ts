import { useEffect } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { usePrefs } from "./prefs";
import { IS_MOBILE } from "../platform";

/** «Выключен», «Включён», or «Сам»: on a PC while OBS runs (the default), on a phone while its screen is shown. */
export type StreamerMode = "off" | "on" | "auto";
export const STREAMER_MODES: readonly StreamerMode[] = ["off", "on", "auto"];

/**
 * Whether a program to stream with (OBS, Streamlabs, XSplit…) runs, as the app last saw, whether our studio streams, and
 * whether we show our screen in a call (on a phone that is what others see of it).
 */
export const useStreaming = create<{
  obs: boolean;
  studio: boolean;
  sharing: boolean;
  setObs: (obs: boolean) => void;
  setStudio: (studio: boolean) => void;
  setSharing: (sharing: boolean) => void;
}>((set) => ({
  obs: false,
  studio: false,
  sharing: false,
  setObs: (obs) => set({ obs }),
  setStudio: (studio) => set({ studio }),
  setSharing: (sharing) => set({ sharing }),
}));

/** The streamer mode is on now: by hand, or by itself while OBS runs. */
export function streamerActive(mode: StreamerMode, obs: boolean): boolean {
  return mode === "on" || (mode === "auto" && obs);
}

export function useStreamerActive(): boolean {
  const mode = usePrefs((s) => s.streamer);
  // Our own studio streaming counts as OBS running; on a phone, so does showing its screen (there is no OBS there, and
  // what is on the phone's screen is what friends see).
  const obs = useStreaming((s) => s.obs || s.studio || (IS_MOBILE && s.sharing));
  return streamerActive(mode, obs);
}

/** Keeps `useStreaming` up to date with what the app sees running; called once, by the shell. */
export function useStreamingWatch() {
  useEffect(() => {
    if (!isTauri()) return;
    const setObs = useStreaming.getState().setObs;
    let stop: (() => void) | null = null;
    let disposed = false;
    void invoke<boolean>("streaming_status").then(setObs).catch(() => {});
    void listen<boolean>("streaming", ({ payload }) => setObs(payload))
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
