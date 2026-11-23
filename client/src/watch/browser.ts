import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentVideo, Report } from "./pageSync";
import { readChoices, type ChoiceKind, type Choices } from "./picks";
import { android } from "../platform/android";

/** A box of the page, CSS pixels from the window's top left. */
export type Box = { x: number; y: number; width: number; height: number };

/**
 * The site right in the call (a webview of the main window over the stage's video box, watch_browser.rs; a PC on
 * Windows only): opened over a box of the page, moved with it, hidden while something of the program covers it.
 */
export const watchView = {
  /** `turn`: a number that only grows (`nextViewTurn`); the close of an older turn leaves a newer one's site open. */
  open: (url: string, box: Box, turn: number) => invoke("watch_view_open", { url, ...box, turn }),
  place: (box: Box, shown: boolean) => invoke("watch_view_place", { ...box, shown }),
  close: (turn: number) => invoke("watch_view_close", { turn }),
};

let viewTurn = 0;
/** The turn of the next opening of the site in the call. */
export const nextViewTurn = () => ++viewTurn;

type Command =
  | { op: "play" | "pause" | "back" | "forward" | "reload" }
  | { op: "seek"; ms: number }
  | { op: "rate"; rate: number }
  | { op: "choose"; kind: ChoiceKind; label: string }
  | { op: "theater"; on: boolean };

/**
 * The window a site is watched in («Любой сайт», watch_browser.rs): opened, moved and closed from here, and what the
 * script in its frames reports about the page's video and its choices.
 */
export const watchBrowser = {
  open: async (url: string) => {
    const bridge = android();
    // A phone: Android's own window (WatchActivity), the address checked by Rust first.
    if (bridge) return bridge.send({ op: "watch-open", url: await invoke<string>("watch_browser_check", { url }) });
    return invoke("watch_browser_open", { url });
  },
  /** Tells the page watched (in the call or in its window) what to do. */
  command: async (c: Command) => {
    const ms = c.op === "seek" ? c.ms : c.op === "rate" ? c.rate : null;
    const kind = c.op === "choose" ? c.kind : null;
    const label = c.op === "choose" ? c.label : null;
    const on = c.op === "theater" ? c.on : null;
    const bridge = android();
    if (bridge) return bridge.send({ op: "watch-command", command: c.op, ms, kind, label, on });
    return invoke("watch_browser_command", { op: c.op, ms, url: null, kind, label, on });
  },
  focus: async () => {
    const bridge = android();
    if (bridge) return bridge.send({ op: "watch-focus" });
    return invoke("watch_browser_focus");
  },
  close: async () => {
    const bridge = android();
    if (bridge) return bridge.send({ op: "watch-close" });
    return invoke("watch_browser_close");
  },
};

/** The longest time an agent may name, ms: a week (as watch_browser.rs). */
const MAX_POS = 7 * 24 * 3600 * 1000;
const plain = (text: unknown, most: number) => (typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, most) : "");
const ms = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_POS, Math.max(0, n)) : 0);

/** What the script in a site's frames says: the site's title, its video, its choices, whether the player is shown alone. */
export type AgentWord = { t: string; v: AgentVideo | null; c: Choices; th: boolean };

/**
 * An agent's word as Android passes it from a site's title: trimmed to what the program shows and to sane numbers, as
 * Rust does on a PC (`read_word`). A site writes that title, so nothing in it is taken as it is.
 */
export function readAgentWord(raw: unknown): AgentWord {
  const word = typeof raw === "object" && raw ? (raw as { t?: unknown; v?: unknown; c?: unknown; th?: unknown }) : {};
  const v = typeof word.v === "object" && word.v ? (word.v as Record<string, unknown>) : null;
  return {
    t: plain(word.t, 200),
    v: v ? { playing: v.playing === true, pos: ms(v.pos), dur: ms(v.dur), frame: plain(v.frame, 500) } : null,
    c: readChoices(word.c),
    th: word.th === true,
  };
}

export type BrowserView = {
  open: boolean;
  /** The page the window shows now. */
  url: string | null;
  /** The site's own title. */
  title: string;
  /** The page's video and when it was last heard of; null while none is found. */
  report: Report | null;
  /** What the page lets one choose (its players, the player's season, episode and dub), as of the last word. */
  choices: Choices;
  /** When those were last heard of (this PC's clock, ms). */
  choicesAt: number;
  /** The page shows its player alone (in the call). */
  theater: boolean;
};

const CLOSED: BrowserView = { open: false, url: null, title: "", report: null, choices: {}, choicesAt: 0, theater: false };

/** The view after an agent's word. */
const heard = (now: BrowserView, word: AgentWord): BrowserView => {
  const wall = Date.now();
  return { ...now, open: true, title: word.t, report: word.v ? { video: word.v, wall } : null, choices: word.c, choicesAt: wall, theater: word.th };
};

/** What the window shows, as its script tells. */
export function useWatchBrowser(): BrowserView {
  const [view, setView] = useState<BrowserView>(CLOSED);
  // Android's window tells the same through the bridge.
  useEffect(
    () =>
      android()?.on((word) => {
        if (word.ev === "watch-agent") {
          const payload = readAgentWord(word.word);
          setView((now) => heard(now, payload));
        } else if (word.ev === "watch-url" && typeof word.url === "string") {
          const url = word.url;
          setView((now) => ({ ...now, open: true, url }));
        } else if (word.ev === "watch-closed") setView(CLOSED);
      }),
    [],
  );
  useEffect(() => {
    if (!isTauri()) return;
    const offs = [
      // Rust has trimmed it already (`read_word`); read again all the same, it is a site's word.
      listen<unknown>("watch-agent", ({ payload }) => setView((now) => heard(now, readAgentWord(payload)))),
      listen<{ url: string }>("watch-browser-url", ({ payload }) => setView((now) => ({ ...now, open: true, url: payload.url }))),
      listen("watch-browser-closed", () => setView(CLOSED)),
    ];
    return () => offs.forEach((off) => void off.then((stop) => stop()));
  }, []);
  return view;
}
