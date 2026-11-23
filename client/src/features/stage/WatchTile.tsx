import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Crown, Maximize, Minimize, Monitor, Pause, Play, RotateCcw, RotateCw, X } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { Button } from "../../ui/Button";
import { nextViewTurn, useWatchBrowser, watchBrowser, watchView, type Box, type BrowserView } from "../../watch/browser";
import { linkTitle, pageLink, parseWatchLink, type WatchLink } from "../../watch/links";
import { followCommands, SETTLE_MS as PAGE_SETTLE_MS, viewerAction, reportedNow, type PageCommand, type Report } from "../../watch/pageSync";
import { IS_MOBILE } from "../../platform";
import { CHOICE_KINDS, nextChoice, viewerPicks, type ChoiceKind, type Choices } from "../../watch/picks";
import { playerProtocol, type PlayerProtocol } from "../../watch/players";
import { expectedPosition, needsSeek } from "../../watch/sync";
import type { WatchControls } from "../../watch/useWatch";
import { visiblePart } from "../../watch/viewBox";
import { hostView } from "../../voice/ownCapture";

/** After we moved the player to follow the others, what it reports is ours, not the viewer's doing. */
const SETTLE_MS = 1500;
/** After a choice made on the page to follow the others, it loads: what it shows meanwhile is ours, and no other is made. */
const CHOICE_SETTLE_MS = 3000;
/** A site is watched right in the call on a PC with Windows (a second webview of the window); elsewhere, in a window of its own. */
const IN_CALL = hostView() !== null;
/** How often the site in the call is put over its box again (the stage moves, a menu opens over it). */
const PLACE_MS = 120;
/** In full screen, the bars go after this long with no move of the mouse while the video plays. */
const IDLE_MS = 3000;

/**
 * The cinema in full screen as a whole (its bars over the picture), in and out by the same button. While it plays, the
 * bars fade after a few still seconds and come back with the mouse: over a site's frame the page hears no mouse, so a
 * clear cover catches the first move once they are gone. `autoHide: false` keeps them (the site in the call is a
 * webview of its own: no cover of the page goes over it).
 */
function useFullCinema(figure: React.RefObject<HTMLElement | null>, playing: boolean, autoHide: boolean) {
  const [full, setFull] = useState(false);
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const changed = () => setFull(!!figure.current && document.fullscreenElement === figure.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [figure]);
  const hiding = full && playing && autoHide;
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(timer.current);
    if (hiding) timer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, [hiding]);
  useEffect(() => {
    wake();
    return () => clearTimeout(timer.current);
  }, [wake]);
  const toggle = () => {
    if (document.fullscreenElement === figure.current) void document.exitFullscreen?.().catch(() => {});
    else void figure.current?.requestFullscreen?.().catch(() => {});
  };
  return { full, idle: hiding && idle, wake, toggle };
}
/** A jump this big between two reports of the player is someone seeking, not a stall. */
const JUMP_MS = 3000;
const STEP_MS = 10_000;

type Props = {
  watch: WatchControls;
  /** Who started or moved it last. */
  byName: string;
  /** Starts showing our screen (for «Трансляцией»: the window of the site). */
  onShareScreen?: () => void;
  /** Something else is in front of the stage: the watching goes on, hidden. */
  parked?: boolean;
};

/** 8:24, 1:02:10. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * «Кинозал»: what the call watches together. A header (the site, how it is watched, who leads), the player, and one
 * control bar everyone uses: play and pause, ten seconds back and forward, the time bar. Whatever anyone does with it, or
 * with the site's own player, happens for everyone.
 */
export function WatchTile({ watch, byName, onShareScreen, parked = false }: Props) {
  const state = watch.state;
  const url = state?.url ?? null;
  const link = url ? parseWatchLink(url) : null;
  // One protocol per link: it keeps track of the player's adverts.
  const protocol = useMemo(() => (link ? playerProtocol(link, window.location.origin) : null), [url]);
  const browser = useWatchBrowser();
  const [duration, setDuration] = useState(0);
  const screen = useRef<HTMLDivElement>(null);
  const figure = useRef<HTMLElement>(null);
  const siteInCall = link?.kind === "page" && IN_CALL && !link.stream;
  const cinema = useFullCinema(figure, !!state?.playing, !siteInCall);
  if (!state || !link) return null;
  const mine = state.by === watch.me;
  const pageDuration = link.kind === "page" ? (browser.report?.video.dur ?? 0) : 0;
  const classes = ["screen-tile", "cinema", parked ? "parked" : "", cinema.full ? "full" : "", cinema.idle ? "idle" : ""].filter(Boolean).join(" ");
  return (
    <figure ref={figure} className={classes} aria-label="Совместный просмотр" onPointerMove={cinema.wake} onKeyDown={cinema.wake}>
      <header className="cinema-head">
        <span className="cinema-site">{link.kind === "page" && browser.title ? browser.title : linkTitle(link)}</span>
        {link.kind === "page" && <span className="cinema-chip">{link.stream ? "Трансляцией" : "Синхронно"}</span>}
        <span className="cinema-by">
          <Crown size={13} aria-hidden /> Ведёт: {mine ? "ты" : byName}
        </span>
        <IconButton label="Остановить для всех" onClick={watch.stop}>
          <X size={16} />
        </IconButton>
      </header>
      {link.kind === "page" && !(link.stream && !mine) && <CinemaChoices choices={browser.choices} onChoose={watch.choose} />}
      <div className="cinema-screen" ref={screen}>
        {protocol ? (
          <FramedPlayer key={state.url} protocol={protocol} watch={watch} />
        ) : link.kind === "file" ? (
          <FilePlayer key={link.url} url={link.url} watch={watch} onDuration={setDuration} />
        ) : link.kind === "page" ? (
          <PageWatch key={state.url} link={link} watch={watch} browser={browser} mine={mine} byName={byName} onShareScreen={onShareScreen} />
        ) : null}
        {cinema.idle && <div className="cinema-wake" onPointerMove={cinema.wake} onPointerDown={cinema.wake} onDoubleClick={cinema.toggle} />}
      </div>
      <ControlBar
        watch={watch}
        duration={link.kind === "page" ? pageDuration : duration}
        full={link.kind !== "page" || siteInCall ? cinema.full : null}
        onFull={cinema.toggle}
        window={link.kind === "page" && browser.open && !siteInCall}
      />
      {protocol && (
        <p className="cinema-note">
          Видео идёт с {protocol.name} напрямую: {protocol.name} видит, что ты смотришь
        </p>
      )}
    </figure>
  );
}

const CHOICE_NAMES: Record<Exclude<ChoiceKind, "players">, string> = { season: "Сезон", episode: "Серия", dub: "Озвучка" };

/**
 * What a site's page lets one choose, as the call's own buttons: the site's players side by side, the player's season,
 * episode and dub as lists. A choice is everyone's: each one's page makes it.
 */
export function CinemaChoices({ choices, onChoose }: { choices: Choices; onChoose: (kind: ChoiceKind, label: string) => void }) {
  if (!CHOICE_KINDS.some((kind) => choices[kind])) return null;
  const players = choices.players;
  return (
    <div className="cinema-choices" aria-label="Выбор на сайте">
      {players && (
        <div className="cinema-players" role="group" aria-label="Плеер">
          {players.items.map((item, i) => (
            <button key={`${i} ${item}`} type="button" className="cinema-player" aria-pressed={i === players.active} onClick={() => i !== players.active && onChoose("players", item)}>
              {item}
            </button>
          ))}
        </div>
      )}
      {(["season", "episode", "dub"] as const).map((kind) => {
        const group = choices[kind];
        if (!group) return null;
        return (
          <label key={kind} className="cinema-pick">
            <span className="cinema-pick-name">{CHOICE_NAMES[kind]}</span>
            <select aria-label={CHOICE_NAMES[kind]} value={String(group.active)} onChange={(e) => onChoose(kind, group.items[Number(e.currentTarget.value)]!)}>
              {group.items.map((item, i) => (
                <option key={`${i} ${item}`} value={String(i)}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}

/**
 * The site right in the call: a webview of the window over this box, the player alone shown in it («theater», see
 * watch_agent.js). It follows the box as the stage moves, steps above the call's buttons floating over it, and hides
 * while a window or a menu of the program is over it (a webview covers everything of the page).
 */
function InCallSite({ url, status }: { url: string; status: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let alive = true;
    let opened = false;
    let last = "";
    const measure = (): { at: Box; shown: boolean } => {
      const r = el.getBoundingClientRect();
      const whole = { x: r.left, y: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
      const part =
        document.visibilityState === "visible"
          ? visiblePart(whole, (x, y) => document.elementFromPoint(x, y), (hit) => !!hit && (hit === el || el.contains(hit)))
          : null;
      return part ? { at: part, shown: true } : { at: whole, shown: false };
    };
    const place = () => {
      if (!alive || !opened) return;
      const { at, shown } = measure();
      const key = [Math.round(at.x), Math.round(at.y), Math.round(at.width), Math.round(at.height), shown].join();
      if (key === last) return;
      last = key;
      void watchView.place(at, shown).catch(() => {});
    };
    setError(null);
    const turn = nextViewTurn();
    void watchView
      .open(url, measure().at, turn)
      .then(() => {
        opened = true;
        place();
      })
      .catch((e: unknown) => alive && setError(String(e)));
    const timer = setInterval(place, PLACE_MS);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    observer?.observe(el);
    window.addEventListener("resize", place);
    return () => {
      alive = false;
      clearInterval(timer);
      observer?.disconnect();
      window.removeEventListener("resize", place);
      void watchView.close(turn).catch(() => {});
    };
  }, [url]);
  return (
    <div ref={box} className="cinema-live">
      {error ? <p className="form-error">{error}</p> : status}
    </div>
  );
}

/** The bar under the player: where everyone is now, and the buttons that move it for everyone. */
function ControlBar({
  watch,
  duration,
  full,
  onFull,
  window: hasWindow,
}: {
  watch: WatchControls;
  duration: number;
  /** Whether the cinema fills the screen; null: no such button (a site in a window of its own). */
  full: boolean | null;
  onFull: () => void;
  window: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, []);
  const state = watch.state;
  if (!state) return null;
  const now = expectedPosition(state, watch.serverNow());
  const at = duration > 0 ? Math.min(now, duration) : now;
  return (
    <div className="cinema-bar">
      {duration > 0 && (
        <input
          className="cinema-time"
          type="range"
          min={0}
          max={duration}
          step={1000}
          value={at}
          aria-label="Перемотать для всех"
          onChange={(e) => watch.seek(Number(e.currentTarget.value))}
          style={{ ["--done" as string]: `${(at / duration) * 100}%` }}
        />
      )}
      <div className="cinema-buttons">
        <button type="button" className="cinema-play" aria-label={state.playing ? "Пауза для всех" : "Играть для всех"} onClick={() => (state.playing ? watch.pause(now) : watch.play(now))}>
          {state.playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <IconButton label="Назад на 10 секунд" onClick={() => watch.seek(Math.max(0, now - STEP_MS))}>
          <RotateCcw size={18} />
        </IconButton>
        <IconButton label="Вперёд на 10 секунд" onClick={() => watch.seek(duration > 0 ? Math.min(duration, now + STEP_MS) : now + STEP_MS)}>
          <RotateCw size={18} />
        </IconButton>
        <span className="cinema-clock">
          {clock(at)}
          {duration > 0 && <span className="cinema-total"> / {clock(duration)}</span>}
        </span>
        <span className="cinema-spacer" />
        {hasWindow && (
          <IconButton label="Показать окно просмотра" onClick={() => void watchBrowser.focus().catch(() => {})}>
            <AppWindow size={18} />
          </IconButton>
        )}
        {full !== null && (
          <IconButton label={full ? "Выйти из полного экрана" : "Во весь экран"} onClick={onFull}>
            {full ? <Minimize size={18} /> : <Maximize size={18} />}
          </IconButton>
        )}
      </div>
    </div>
  );
}

/**
 * Any site: the video plays in a window of its own, where each viewer picks the player and the dub as on the site.
 * «Синхронно»: everyone opens the page and the window is kept in step with the call. «Трансляцией»: the one who started
 * shows their window as a screen, and the others watch that.
 */
function PageWatch({
  link,
  watch,
  browser,
  mine,
  byName,
  onShareScreen,
}: {
  link: Extract<WatchLink, { kind: "page" }>;
  watch: WatchControls;
  browser: BrowserView;
  mine: boolean;
  byName: string;
  onShareScreen?: () => void;
}) {
  const settled = useRef(0);
  const last = useRef<Report | null>(null);
  // The page's video speed as we last set it (catching up with everyone), and how far ahead a move lands: a phone's
  // video takes a second or more to play again after one.
  const rate = useRef(1);
  const lead = IS_MOBILE ? 1200 : 300;
  const obey = (commands: PageCommand[], wall: number) => {
    // A speed change is no move: the viewer's own presses are still heard right after it.
    if (commands.some((c) => c.op !== "rate")) settled.current = wall + PAGE_SETTLE_MS;
    for (const c of commands) {
      if (c.op === "rate") rate.current = c.rate;
      void watchBrowser.command(c).catch(() => {});
    }
  };
  // The page's choices as of its last word, and until when what it shows is the doing of our own choice.
  const lastChoices = useRef<Choices | null>(null);
  const choiceSettled = useRef(0);
  const latest = useRef(watch);
  latest.current = watch;
  const [error, setError] = useState<string | null>(null);
  // Only the one who started a stream opens the window; in step, everyone does.
  const ownsWindow = !link.stream || mine;
  // In step on a PC: right in the call, opened by itself for everyone.
  const inCall = IN_CALL && !link.stream;

  const open = () => {
    setError(null);
    void watchBrowser.open(link.url).catch((e: unknown) => setError(String(e)));
  };

  // Follow the last word: when it changes, and when the page first reports its video.
  const report = browser.report;
  useEffect(() => {
    const w = latest.current;
    if (!w.state || !report || !ownsWindow) return;
    const wall = Date.now();
    // While a choice loads (a dub, an episode), what the page's video does is the page's own doing too.
    const action = viewerAction(last.current, report, w.state, Math.max(settled.current, choiceSettled.current));
    last.current = report;
    if (action) {
      // The viewer pressed or dragged something in the site's player: that is said to everyone.
      if (action.op === "play") w.play(action.pos);
      else if (action.op === "pause") w.pause(action.pos);
      else w.seek(action.pos);
      return;
    }
    obey(followCommands(w.state, w.serverNow(), report, wall, { rate: rate.current, lead }), wall);
  }, [report, ownsWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const w = latest.current;
    if (!w.state || !last.current || !ownsWindow) return;
    const wall = Date.now();
    obey(followCommands(w.state, w.serverNow(), { video: { ...last.current.video, pos: reportedNow(last.current, wall) }, wall }, wall, { rate: rate.current, lead }), wall);
  }, [watch.state, ownsWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page's player, season, episode and dub: as everyone's, one choice at a time; a choice the viewer made in the site's
  // own player is everyone's from then on.
  useEffect(() => {
    const w = latest.current;
    if (!w.state || !ownsWindow || !browser.choicesAt) return;
    const now = Date.now();
    const prev = lastChoices.current;
    lastChoices.current = browser.choices;
    if (now < choiceSettled.current) return;
    const theirs = viewerPicks(prev, browser.choices, w.state.picks);
    if (theirs) {
      w.adopt(theirs.picks, theirs.restart);
      return;
    }
    const next = nextChoice(w.state.picks, browser.choices);
    if (!next) return;
    choiceSettled.current = now + CHOICE_SETTLE_MS;
    void watchBrowser.command({ op: "choose", ...next }).catch(() => {});
  }, [browser.choicesAt, watch.state?.picks, ownsWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  // In the call the page shows its player alone: asked again whenever it says it does not (a new page, or one whose
  // adverts never let it finish loading, so the program's own ask on load never came).
  const theaterAsked = useRef(0);
  useEffect(() => {
    if (!inCall || !browser.choicesAt || browser.theater) return;
    const now = Date.now();
    if (now - theaterAsked.current < 2000) return;
    theaterAsked.current = now;
    void watchBrowser.command({ op: "theater", on: true }).catch(() => {});
  }, [browser.choicesAt, browser.theater, inCall]);

  // The one who leads went to another page of the site (the next episode): everyone can be called there.
  const elsewhere = mine && browser.url && browser.url !== link.url && !browser.url.startsWith("about:") ? browser.url : null;

  if (link.stream && !mine) {
    return (
      <div className="cinema-card">
        <Monitor size={28} aria-hidden />
        <strong>{byName} показывает видео своим экраном</strong>
        <span>Его экран появится здесь, как только он начнёт показ. Пауза и перемотка — общие.</span>
      </div>
    );
  }
  if (inCall) {
    return (
      <>
        <InCallSite
          url={link.url}
          status={
            <span className="cinema-live-status">
              {!report ? "Открываю сайт и ищу на нём видео…" : "Видео здесь, под окном программы: закрой его, и оно вернётся"}
            </span>
          }
        />
        {elsewhere && (
          <Button className="cinema-elsewhere" onClick={() => watch.start(pageLink(elsewhere, link.stream))}>
            Позвать всех на эту страницу
          </Button>
        )}
      </>
    );
  }
  return (
    <div className="cinema-card">
      <AppWindow size={28} aria-hidden />
      {!browser.open ? (
        <>
          <strong>Видео идёт в отдельном окне</strong>
          <span>
            {link.stream
              ? "Открой сайт, выбери плеер и озвучку, потом покажи окно друзьям: они увидят ровно его."
              : "Открой сайт у себя: плеер, сезон, серия и озвучка встанут как у всех сами. Пауза и перемотка общие для всех."}
          </span>
          <Button variant="primary" onClick={open}>
            Открыть сайт
          </Button>
        </>
      ) : !report ? (
        <>
          <strong>Ищу видео на странице…</strong>
          <span>Если видео не нашлось само, нажми ▶ в самом плеере: окно найдёт его и встанет вместе со всеми.</span>
          <Button onClick={() => void watchBrowser.focus().catch(() => {})}>Показать окно</Button>
        </>
      ) : (
        <>
          <strong>
            Видео найдено · {clock(reportedNow(report, Date.now()))}
            {report.video.dur > 0 && ` из ${clock(report.video.dur)}`}
          </strong>
          <span>{report.video.playing ? "Идёт вместе со всеми." : "На паузе вместе со всеми."} Окно можно развернуть на весь экран.</span>
          <div className="cinema-actions">
            <Button onClick={() => void watchBrowser.focus().catch(() => {})}>Показать окно</Button>
            {link.stream && mine && onShareScreen && (
              <Button variant="primary" onClick={onShareScreen}>
                Показать окно друзьям
              </Button>
            )}
          </div>
          {link.stream && mine && <span className="hint">В выборе экрана нажми на окно, в названии которого «ХатаВойс — просмотр».</span>}
        </>
      )}
      {elsewhere && (
        <Button onClick={() => watch.start(pageLink(elsewhere, link.stream))}>Позвать всех на эту страницу</Button>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

/** A video file: the `<video>` element tells us everything itself. */
function FilePlayer({ url, watch, onDuration }: { url: string; watch: WatchControls; onDuration: (ms: number) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const settled = useRef(0);
  const latest = useRef(watch);
  latest.current = watch;
  const state = watch.state;
  const [broken, setBroken] = useState(false);

  // Follow the last word — only when it changes, not on every redraw of the stage.
  useEffect(() => {
    const element = video.current;
    if (!element || !state) return;
    const expected = expectedPosition(state, latest.current.serverNow());
    const follow = () => (settled.current = Date.now() + SETTLE_MS);
    if (needsSeek(element.currentTime * 1000, expected)) {
      follow();
      element.currentTime = expected / 1000;
    }
    if (state.playing && element.paused) {
      follow();
      // A browser may refuse to start by itself; the viewer then presses play, and that is said to everyone.
      const started: Promise<void> | undefined = element.play();
      void started?.catch(() => {});
    }
    if (!state.playing && !element.paused) {
      follow();
      element.pause();
    }
  }, [state]);

  const ours = () => Date.now() < settled.current;
  const at = () => (video.current?.currentTime ?? 0) * 1000;
  if (broken) return <div className="screen-wait watch-player">Видео по этой ссылке не открывается</div>;
  return (
    <video
      ref={video}
      className="watch-player screen-video"
      src={url}
      playsInline
      onLoadedMetadata={(e) => onDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration * 1000 : 0)}
      onPlay={() => !ours() && !watch.state?.playing && watch.play(at())}
      onPause={() => !ours() && watch.state?.playing && watch.pause(at())}
      onSeeked={() => !ours() && watch.state && needsSeek(at(), expectedPosition(watch.state, watch.serverNow())) && watch.seek(at())}
      onError={() => setBroken(true)}
    />
  );
}

/** A site's player in its frame, run by messages: no script of the site ever runs in this window. */
function FramedPlayer({ protocol, watch }: { protocol: PlayerProtocol; watch: WatchControls }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const settled = useRef(0);
  const report = useRef<{ pos: number; wall: number; playing: boolean } | null>(null);
  // An advert is running: the player is neither moved nor listened to.
  const advert = useRef(false);
  const latest = useRef(watch);
  latest.current = watch;
  const state = watch.state;

  const post = (message: unknown) => {
    if (message !== null) frame.current?.contentWindow?.postMessage(message, protocol.origin);
  };

  /** Puts the player where the last word says the video is. */
  const follow = () => {
    const now = latest.current.state;
    if (!now || advert.current) return;
    const expected = expectedPosition(now, latest.current.serverNow());
    const known = report.current;
    if (!known || needsSeek(known.pos + (known.playing ? Date.now() - known.wall : 0), expected)) {
      settled.current = Date.now() + SETTLE_MS;
      post(protocol.seek(expected));
    }
    if (now.playing !== (known?.playing ?? false)) {
      settled.current = Date.now() + SETTLE_MS;
      post(now.playing ? protocol.play() : protocol.pause());
    }
  };
  const followRef = useRef(follow);
  followRef.current = follow;

  // What the player says: its time, whether it plays, that it is ready, its adverts.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== protocol.origin || e.source !== frame.current?.contentWindow) return;
      const wall = Date.now();
      const news = protocol.read(e.data, wall);
      if (!news) return;
      const w = latest.current;
      const now = w.state;
      if (!now) return;
      const wasAdvert = advert.current;
      advert.current = news.ad ?? advert.current;
      const last = report.current;
      const pos = news.pos ?? (last ? last.pos + (last.playing ? wall - last.wall : 0) : 0);
      report.current = { pos, wall, playing: news.playing ?? last?.playing ?? false };
      // Ready, or back from an advert: to where the others are.
      if (news.ready || (wasAdvert && !advert.current)) return followRef.current();
      if (wall < settled.current || advert.current) return;
      // Someone pressed play or pause in the player itself.
      if (news.playing === true && !now.playing) w.play(pos);
      else if (news.playing === false && now.playing) w.pause(pos);
      // Someone dragged the time bar.
      else if (last && news.pos !== undefined && Math.abs(pos - last.pos - (last.playing ? wall - last.wall : 0)) > JUMP_MS) w.seek(pos);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [protocol]);

  // Follow the last word — only when it changes, not on every redraw of the stage.
  useEffect(() => followRef.current(), [state]);

  // Loaded once where the others are (where the player takes a start); from then on it is moved by messages.
  const [src] = useState(() => protocol.src((state ? expectedPosition(state, watch.serverNow()) : 0) / 1000));
  return (
    <iframe
      ref={frame}
      className="watch-player screen-video"
      title={`Плеер ${protocol.name}`}
      src={src}
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      onLoad={() => post(protocol.hello())}
    />
  );
}
