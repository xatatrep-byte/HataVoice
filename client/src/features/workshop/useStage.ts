import { useEffect, useRef, useState, type RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { defaultAvatarFor } from "../../characters/gallery";
import type { Joint, JointName, Pose } from "../../characters/motion";
import type { WorkshopStage } from "../../characters/workshopStage";
import { identityInfo } from "../../server/session";
import { usePrefs } from "../../state/prefs";

export function accentColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffb454";
}

/** Who I am on this PC: a character for someone who chose none is picked from it. */
export function useMe(): string {
  const [me, setMe] = useState("me");
  useEffect(() => {
    if (isTauri()) void identityInfo().then((info) => setMe(info.user_id)).catch(() => {});
  }, []);
  return me;
}

type Hooks = {
  onChoose?: (joint: JointName | null) => void;
  onTurn?: (joint: JointName, turn: Joint) => void;
  onTurnEnd?: () => void;
  onPull?: (pose: Pose) => void;
  /** Handles on the joints: off for watching, on for posing. */
  handles?: boolean;
};

/**
 * The workshop's 3D stage on `canvas`, with my character on it (or the figure when this PC has none), resized with its
 * box. `no3d` when this PC draws no 3D.
 */
export function useWorkshopStage(canvas: RefObject<HTMLCanvasElement | null>, hooks: Hooks = {}) {
  const stage = useRef<WorkshopStage | null>(null);
  const [no3d, setNo3d] = useState(false);
  const [ready, setReady] = useState(false);
  const code = usePrefs((s) => s.character);
  const me = useMe();
  const live = useRef(hooks);
  live.current = hooks;

  useEffect(() => {
    let disposed = false;
    let made: WorkshopStage | null = null;
    let observer: ResizeObserver | null = null;
    import("../../characters/workshopStage")
      .then(({ WorkshopStage }) => {
        const element = canvas.current;
        if (disposed || !element) return;
        try {
          made = new WorkshopStage(
            element,
            accentColor(),
            (j) => live.current.onChoose?.(j),
            (j, turn) => live.current.onTurn?.(j, turn),
            () => live.current.onTurnEnd?.(),
            (pose) => live.current.onPull?.(pose),
          );
        } catch {
          setNo3d(true);
          return;
        }
        made.setHandles(!!live.current.handles);
        stage.current = made;
        // For live checks of the dev build only.
        if (import.meta.env.DEV) (globalThis as { __hvStage?: WorkshopStage }).__hvStage = made;
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => made?.resize());
          observer.observe(element);
        }
        setReady(true);
      })
      .catch(() => setNo3d(true));
    return () => {
      disposed = true;
      observer?.disconnect();
      made?.dispose();
      stage.current = null;
      setReady(false);
    };
  }, [canvas]);

  useEffect(() => {
    if (!ready) return;
    void stage.current?.setBody(code ?? defaultAvatarFor(me)).catch(() => stage.current?.setBody(null));
  }, [ready, code, me]);

  useEffect(() => {
    if (ready) stage.current?.setHandles(!!hooks.handles);
  }, [ready, hooks.handles]);

  return { stage, no3d, ready, me };
}
