import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { Check, Move, RotateCcw } from "lucide-react";
import { CharacterCanvas } from "./CharacterCanvas";
import {
  actsFrom,
  clampSpot,
  DEFAULT_SIZE,
  MAX_SIZE,
  MIN_SIZE,
  OVERLAY_ACT,
  OVERLAY_DONE,
  OVERLAY_EVENT,
  OVERLAY_FPS,
  OVERLAY_FPS_MS,
  OVERLAY_PLACED,
  OVERLAY_SIZE,
  overlayCursor,
  spotsFor,
  takeMouse,
  type OverlayState,
  type Spot,
} from "./overlay";
import type { SceneAct, SceneMember } from "./scene";
import { ActMenu } from "../features/stage/ActMenu";
import "./overlay.css";

const MAIN = "main";
/** How often the window looks where the mouse is, to take it only over a character. */
const LOOK_MS = 50;
/** How often it asks whether a game fills the screen: then it never takes the mouse. */
const GAME_MS = 2000;
/** A menu nobody chose from goes away by itself: while it is open, the window holds the whole desktop's mouse. */
const MENU_MS = 12_000;

/** A character's frame while they are being put in place: dragged, it takes the character with it. */
function Handle({ spot, size, onMove, onDrop }: { spot: Spot; size: number; onMove: (spot: Spot) => void; onDrop: (spot: Spot) => void }) {
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const last = useRef(spot);
  const height = size * window.innerHeight;
  const width = height * 0.52;
  const style: CSSProperties = {
    left: spot[0] * window.innerWidth - width / 2,
    top: spot[1] * window.innerHeight - height,
    width,
    height,
  };
  const at = (e: React.PointerEvent): Spot =>
    clampSpot([(e.clientX - grab.current!.dx) / window.innerWidth, (e.clientY - grab.current!.dy) / window.innerHeight], size);
  return (
    <div
      className={grab.current ? "overlay-handle held" : "overlay-handle"}
      style={style}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        grab.current = { dx: e.clientX - spot[0] * window.innerWidth, dy: e.clientY - spot[1] * window.innerHeight };
      }}
      onPointerMove={(e) => {
        if (!grab.current) return;
        last.current = at(e);
        onMove(last.current);
      }}
      onPointerUp={() => {
        if (!grab.current) return;
        grab.current = null;
        onDrop(last.current);
      }}
    >
      <span className="overlay-handle-grip" aria-hidden>
        <Move size={14} />
      </span>
    </div>
  );
}

/**
 * The page of the characters' window on the desktop: nothing but the call's characters on a see-through background, each
 * where the person put them, strolling about. The window lets the mouse through, except while a character is under it:
 * the scene says whose figure is at the mouse wherever it has walked, so one may click a character for its menu or carry
 * it elsewhere, and the rest of the desktop stays clickable. While they are being put in place it takes the mouse whole.
 */
export function OverlayApp() {
  const [state, setState] = useState<OverlayState>({ members: [], acts: [], arranging: false, spots: {}, size: DEFAULT_SIZE });
  const [acts, setActs] = useState<SceneAct[]>([]);
  // Moves and a size not yet heard back from the main window.
  const [moved, setMoved] = useState<Record<string, Spot>>({});
  const [sizing, setSizing] = useState<number | null>(null);
  const known = useRef(new Set<number>());
  const probe = useRef<((x: number, y: number) => string | null) | null>(null);
  const rate = useRef<(() => number) | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const hold = useRef({ menu: false, pressed: false, game: false });
  hold.current.menu = !!menu;

  useEffect(() => {
    document.documentElement.classList.add("overlay");
    let stop: (() => void) | null = null;
    let disposed = false;
    void listen<OverlayState>(OVERLAY_EVENT, ({ payload }) => {
      setState(payload);
      // An act is taken once, on this window's clock.
      const fresh = payload.acts.filter((a) => !known.current.has(a.key));
      if (fresh.length) {
        fresh.forEach((a) => known.current.add(a.key));
        setActs((list) => [...list.slice(-20), ...actsFrom(fresh, performance.now())]);
      }
    }).then((unlisten) => (disposed ? unlisten() : (stop = unlisten)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (state.arranging) return;
    setMoved({});
    setSizing(null);
  }, [state.arranging]);

  // The mouse: taken while a character, its menu or a carried figure is under it; never over a game that fills the screen.
  useEffect(() => {
    if (state.arranging) return;
    // Out of arranging the main window has just let the mouse through.
    let taken = false;
    let busy = false;
    const want = (on: boolean) => {
      if (taken === on) return;
      taken = on;
      void takeMouse(on).catch(() => (taken = !on));
    };
    const look = async () => {
      if (busy) return;
      busy = true;
      try {
        const at = await overlayCursor();
        const over = at && probe.current ? probe.current(at[0], at[1]) : null;
        const { menu, pressed, game } = hold.current;
        want(!game && (!!over || menu || pressed));
      } catch {
        // No answer: the mouse goes through, so the desktop is never held by a window that cannot tell where it is.
        want(false);
      } finally {
        busy = false;
      }
    };
    const games = () =>
      void invoke<boolean>("fullscreen_app")
        .then((game) => {
          hold.current.game = game;
          if (game) {
            hold.current.pressed = false;
            setMenu(null);
          }
        })
        .catch(() => {});
    const down = () => (hold.current.pressed = true);
    const up = () => (hold.current.pressed = false);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    document.addEventListener("lostpointercapture", up);
    games();
    const looking = setInterval(() => void look(), LOOK_MS);
    const gaming = setInterval(games, GAME_MS);
    return () => {
      clearInterval(looking);
      clearInterval(gaming);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("lostpointercapture", up);
    };
  }, [state.arranging]);

  // How smoothly this window really draws, for the settings: Windows may hold back a see-through window over everything.
  useEffect(() => {
    const timer = setInterval(() => {
      const fps = rate.current?.();
      if (fps === undefined) return;
      void emitTo(MAIN, OVERLAY_FPS, { fps, hidden: document.visibilityState !== "visible" }).catch(() => {});
    }, OVERLAY_FPS_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const timer = setTimeout(() => setMenu(null), MENU_MS);
    return () => clearTimeout(timer);
  }, [menu]);

  const members: SceneMember[] = state.members;
  const size = sizing ?? state.size;
  const spots = spotsFor(
    members.map((m) => m.id),
    { ...state.spots, ...moved },
    size,
  );
  const tell = (event: string, payload: unknown) => void emitTo(MAIN, event, payload).catch(() => {});
  const picked = menu ? members.find((m) => m.id === menu.id) : undefined;

  return (
    <>
      {members.length > 0 && (
        <CharacterCanvas
          className="overlay-canvas"
          members={members}
          acts={acts}
          desk={{ spots, size }}
          walks={state.walks}
          fps={30}
          probe={probe}
          rate={rate}
          onPick={(id, x, y) => !state.arranging && setMenu((open) => (open?.id === id ? null : { id, x, y }))}
          onPlaced={(id, spot) => {
            setMoved((all) => ({ ...all, [id]: spot }));
            tell(OVERLAY_PLACED, { id, spot });
          }}
        />
      )}
      {menu && picked && !state.arranging && (
        <ActMenu
          key={`${menu.id} ${menu.x} ${menu.y}`}
          at={menu}
          mine={!!picked.local}
          name={picked.name}
          onAct={(act) => {
            tell(OVERLAY_ACT, { act, to: picked.local ? null : picked.id });
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {state.arranging && (
        <div className="overlay-arrange">
          {members.map((m) => (
            <Handle
              key={m.id}
              spot={spots[m.id]!}
              size={size}
              onMove={(spot) => setMoved((all) => ({ ...all, [m.id]: spot }))}
              onDrop={(spot) => {
                setMoved((all) => ({ ...all, [m.id]: spot }));
                tell(OVERLAY_PLACED, { id: m.id, spot });
              }}
            />
          ))}
          <div className="overlay-panel" role="dialog" aria-label="Расставить персонажей">
            <div className="overlay-panel-text">
              <b>Расставь персонажей</b>
              <span>Перетащи каждого мышью куда хочешь. Места запомнятся.</span>
            </div>
            <label className="overlay-size">
              <span>Размер</span>
              <input
                type="range"
                className="range"
                min={MIN_SIZE * 100}
                max={MAX_SIZE * 100}
                step={1}
                value={Math.round(size * 100)}
                onChange={(e) => {
                  const next = Number(e.currentTarget.value) / 100;
                  setSizing(next);
                  tell(OVERLAY_SIZE, { size: next });
                }}
              />
            </label>
            <button
              type="button"
              className="overlay-button"
              onClick={() => {
                const reset = Object.fromEntries(members.map((m) => [m.id, null]));
                setMoved({});
                setSizing(DEFAULT_SIZE);
                tell(OVERLAY_SIZE, { size: DEFAULT_SIZE });
                for (const id of Object.keys(reset)) tell(OVERLAY_PLACED, { id, spot: null });
              }}
            >
              <RotateCcw size={15} aria-hidden /> Сбросить
            </button>
            <button type="button" className="overlay-button primary" onClick={() => tell(OVERLAY_DONE, {})}>
              <Check size={16} aria-hidden /> Готово
            </button>
          </div>
        </div>
      )}
    </>
  );
}
