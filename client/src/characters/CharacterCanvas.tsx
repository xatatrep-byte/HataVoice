import { useEffect, useRef, type MutableRefObject } from "react";
import { usePrefs } from "../state/prefs";
import type { CharacterScene, SceneAct, SceneMember } from "./scene";

type Props = {
  members: SceneMember[];
  acts: SceneAct[];
  onPick?: (id: string, x: number, y: number) => void;
  /** Our figure was dragged to a new place. */
  onMoved?: (x: number, z: number) => void;
  /** On the desktop: someone was carried to a new place (feet, parts of the screen). */
  onPlaced?: (id: string, spot: [number, number]) => void;
  /** Filled with the scene's answer to «whose character is at this point of the canvas». */
  probe?: MutableRefObject<((x: number, y: number) => string | null) | null>;
  /** Filled with the scene's frames-per-second meter (see `CharacterScene.takeDrawRate`). */
  rate?: MutableRefObject<(() => number) | null>;
  /** No background: what is under it shows through. */
  transparent?: boolean;
  /** One figure, close, turning. */
  preview?: boolean;
  /** The characters on the desktop: each at its spot (feet, parts of the screen), `size` of the screen's height tall. */
  desk?: { spots: Record<string, [number, number]>; size: number };
  /** On the desktop: where each one walks on the call's stage (see `stageWalks`). */
  walks?: Record<string, [number, number]>;
  /** The call's stage: it tells where each one walks, for the desktop (see `stageWalks`). */
  feedWalks?: boolean;
  fps?: number;
  className?: string;
  /** This PC cannot draw 3D (or three.js did not load). */
  onFail?: () => void;
  /** Out of sight for now: nothing is drawn, the models stay loaded. */
  paused?: boolean;
  label?: string;
};

function accent(): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

/** A canvas with the characters' stage; three.js loads only when one is shown. */
export function CharacterCanvas({
  members,
  acts,
  onPick,
  onMoved,
  onPlaced,
  probe,
  rate,
  transparent = false,
  preview = false,
  desk,
  walks,
  feedWalks = false,
  fps,
  className,
  onFail,
  label,
  paused = false,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<CharacterScene | null>(null);
  const latest = useRef({ members, acts, desk, onPick, onMoved, onPlaced, onFail, paused });
  latest.current = { members, acts, desk, onPick, onMoved, onPlaced, onFail, paused };
  const onDesk = !!desk;
  const look = usePrefs((s) => s.stageLook);

  useEffect(() => {
    let disposed = false;
    let made: CharacterScene | null = null;
    let observer: ResizeObserver | null = null;
    import("./scene")
      .then(({ CharacterScene }) => {
        const element = canvas.current;
        if (disposed || !element) return;
        try {
          made = new CharacterScene(element, {
            transparent: transparent || onDesk,
            desk: onDesk,
            feedWalks,
            preview,
            fps,
            accent: accent(),
            look,
            onPick: (id, x, y) => latest.current.onPick?.(id, x, y),
            onMoved: (x, z) => latest.current.onMoved?.(x, z),
            onPlaced: (id, spot) => latest.current.onPlaced?.(id, spot),
          });
        } catch {
          latest.current.onFail?.();
          return;
        }
        scene.current = made;
        if (probe) probe.current = (x, y) => made?.figureAtPoint(x, y) ?? null;
        if (rate) rate.current = () => made?.takeDrawRate() ?? 0;
        const placing = latest.current.desk;
        if (placing) made.setDesk(placing.spots, placing.size);
        made.setMembers(latest.current.members);
        latest.current.acts.forEach((act) => made!.play(act));
        made.setPaused(latest.current.paused);
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => made?.resize());
          observer.observe(element);
        }
      })
      .catch(() => latest.current.onFail?.());
    return () => {
      disposed = true;
      observer?.disconnect();
      made?.dispose();
      scene.current = null;
      if (probe) probe.current = null;
      if (rate) rate.current = null;
    };
  }, [transparent, preview, onDesk, fps, look, feedWalks]);
  const walking = walks ? JSON.stringify(walks) : "";
  useEffect(() => {
    if (walks) scene.current?.setWalks(walks);
  }, [walking]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => scene.current?.setMembers(members), [members]);
  useEffect(() => scene.current?.setPaused(paused), [paused]);
  useEffect(() => acts.forEach((act) => scene.current?.play(act)), [acts]);
  const placing = desk ? JSON.stringify(desk) : "";
  useEffect(() => {
    const now = latest.current.desk;
    if (now) scene.current?.setDesk(now.spots, now.size);
  }, [placing]);

  return <canvas ref={canvas} className={className} role="img" aria-label={label ?? "3D-персонажи"} />;
}
