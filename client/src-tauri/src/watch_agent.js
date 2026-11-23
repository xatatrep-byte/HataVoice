// Runs in every frame of a page opened for watching together («Любой сайт»): finds the frame's video and the choices
// around it (the site's «Плеер 1/2/3», the player's season, episode and dub), tells the top frame about them, and the
// top frame tells the program through the page's title (the program reads only titles that start with the mark).
// Commands come back into the top frame and go down to the frames by postMessage: play, pause, seek, speed, a choice
// to make, and «theater» (in the call: the player alone over the whole page). Nothing of the program is reachable from
// here: Tauri refuses every command from a remote page that has no capability, and this page has none.
(() => {
  if (window.__hvWatch) return;
  const MARK = "⁣HV⁣";
  const isTop = window === window.top;
  const me = Math.random().toString(36).slice(2, 12);
  const frames = new Map();
  let siteTitle = "";
  // The site's own title is read first: before that, the mark would write over it and it would be lost.
  let titleKnown = !isTop;
  let writing = false;
  let lastKey = "";
  let lastAt = 0;

  const num = (v, max) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);

  /** The video worth watching in this frame: a playing one, a big one, a long one. */
  function best() {
    let pick = null;
    let score = -1;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 4000 && v.paused) continue;
      const s = area + (v.paused ? 0 : 1e7) + ((v.duration || 0) > 120 ? 5e6 : 0);
      if (s > score) {
        score = s;
        pick = v;
      }
    }
    return pick;
  }

  function stateOf(v) {
    if (!v) return null;
    const r = v.getBoundingClientRect();
    return {
      playing: !v.paused && !v.ended,
      pos: num(v.currentTime * 1000, 6.048e8),
      dur: Number.isFinite(v.duration) ? num(v.duration * 1000, 6.048e8) : 0,
      area: num(r.width * r.height, 1e8),
      frame: String(location.href).slice(0, 500),
    };
  }

  function clean(s) {
    if (!s || typeof s !== "object") return null;
    return { playing: s.playing === true, pos: num(s.pos, 6.048e8), dur: num(s.dur, 6.048e8), area: num(s.area, 1e8), frame: String(s.frame || "").slice(0, 500) };
  }

  // ---- Choices: the site's players, the player's seasons, episodes and dubs.

  const KINDS = ["players", "season", "episode", "dub"];
  const MOST = { players: 12, season: 60, episode: 400, dub: 60 };
  const LABEL_MAX = 60;
  const ACTIVE_WORDS = new Set(["active", "selected", "current", "checked", "chosen", "picked"]);
  const PLAYER_RE = /(плеер|player|источник|сервер|server|балансер)\s*№?\s*\d+/i;
  const SEASON_RE = /сезон|season/i;
  const EPISODE_RE = /сери[яи]|эпизод|episode|выпуск/i;
  const QUALITY_RE = /^(\d{3,4}\s*[pр]\+?|sd|hd|fhd|full\s*hd|uhd|4k|2k|auto|авто|высокое|среднее|низкое)$/i;
  const NUMBER_RE = /^\s*[№#]?\s*\d{1,4}\s*$/;
  /** A speed: 0.5, 1.25, 2x — a list of these is the player's speeds. */
  const SPEED_RE = /^\s*\d{1,2}([.,]\d{1,2})?\s*[xх×]?\s*$|^(обычн|normal)/i;
  const DUB_HINT = /translat|voice|dub|озвуч|перевод|studio|audio|аудио/i;
  const OTHER_HINT = /quality|качеств|resolut|speed|скорост|subtit|субтит|caption|playback|share|social/i;

  const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  const classOf = (el) => (typeof el.className === "string" ? el.className : (el.getAttribute && el.getAttribute("class")) || "");

  /** Marked as the one chosen: by the page's own words for it, an aria state or a class like «active». */
  function marked(el) {
    for (const name of ["aria-selected", "aria-checked", "aria-pressed", "aria-current", "data-active", "data-selected"]) {
      const v = el.getAttribute(name);
      if (v !== null && v !== "false") return true;
    }
    return classOf(el)
      .split(/\s+/)
      .some((token) => token.split(/[_-]+/).some((part) => ACTIVE_WORDS.has(part.toLowerCase())));
  }

  /** The kind of an item by its looks: tag and the first word of its first class (a CSS module's hash left out), the chosen one's mark aside. */
  const looks = (el) =>
    el.tagName +
    "." +
    (
      classOf(el)
        .split(/\s+/)
        .find((token) => token && !token.split(/[_-]+/).some((part) => ACTIVE_WORDS.has(part.toLowerCase()))) || ""
    ).split(/[_-]/)[0];

  /** What the list is said to be by its surroundings: names, classes and labels of it and a few of its parents. */
  function hintOf(el) {
    const words = [];
    let at = el;
    for (let i = 0; i < 4 && at && at.getAttribute; i++, at = at.parentElement) {
      words.push(at.id || "", classOf(at), at.getAttribute("aria-label") || "", at.getAttribute("title") || "", at.getAttribute("name") || "", at.getAttribute("data-type") || "");
    }
    const label = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (label) words.push(textOf(label));
    return words.join(" ");
  }

  /** What a list is, by its items and its surroundings; null for the page's other menus (quality, speed, the site's own). */
  function kindOf(labels, hint, wide) {
    const share = (re) => labels.filter((l) => re.test(l)).length / labels.length;
    if (share(PLAYER_RE) >= 0.6) return "players";
    if (wide) return null;
    if (share(SEASON_RE) >= 0.6) return "season";
    if (share(EPISODE_RE) >= 0.6) return "episode";
    if (share(QUALITY_RE) >= 0.5) return null;
    if (share(SPEED_RE) >= 0.8 && labels.some((l) => /[.,xх×]/i.test(l))) return null;
    if (share(NUMBER_RE) >= 0.8) {
      if (SEASON_RE.test(hint)) return "season";
      if (/episod|сери|эпизод/i.test(hint)) return "episode";
      return null;
    }
    if (DUB_HINT.test(hint)) return "dub";
    if (OTHER_HINT.test(hint)) return null;
    return "dub";
  }

  /**
   * The lists of choices in this frame, each with its elements. `wide`: the whole page of a site (only its players are
   * looked for there: the rest of a site's menus are no dubs); otherwise only inside `within`, or the whole frame.
   */
  function groups(within, wide) {
    const found = [];
    const root = within || document.body;
    if (!root) return found;
    for (const select of root.querySelectorAll("select")) {
      const options = [...select.options].filter((o) => textOf(o));
      if (options.length < 2 || options.length > 400) continue;
      const labels = options.map((o) => textOf(o).slice(0, LABEL_MAX));
      const hint = hintOf(select);
      const kind = kindOf(labels, hint, wide);
      if (kind) found.push({ kind, labels, active: Math.max(0, options.indexOf(select.selectedOptions[0])), els: options, select, named: kind !== "dub" || DUB_HINT.test(hint) });
    }
    for (const parent of root.getElementsByTagName("*")) {
      const count = parent.childElementCount;
      if (count < 2 || count > 400 || parent.tagName === "SELECT") continue;
      const items = [];
      for (const child of parent.children) {
        // An item is a small thing: a word or a few, not a box with lists of its own.
        if (child.childElementCount > 3 || child.getElementsByTagName("*").length > 6) continue;
        const label = textOf(child);
        if (label && label.length <= LABEL_MAX) items.push(child);
      }
      if (items.length < 2 || items.length < count * 0.7) continue;
      const kinds = new Map();
      for (const item of items) kinds.set(looks(item), (kinds.get(looks(item)) || 0) + 1);
      if (Math.max(...kinds.values()) < items.length * 0.7) continue;
      const labels = items.map(textOf);
      const active = items.findIndex((item) => marked(item) || (item.firstElementChild && marked(item.firstElementChild)));
      if (active < 0) continue;
      const hint = hintOf(parent);
      const kind = kindOf(labels, hint, wide);
      if (kind) found.push({ kind, labels, active, els: items, named: kind !== "dub" || DUB_HINT.test(hint) });
    }
    return found;
  }

  /** The same choice in two words: seasons, episodes and players by their number, the rest by their letters. */
  function same(kind, a, b) {
    if (kind !== "dub") {
      const x = String(a).match(/\d+/);
      const y = String(b).match(/\d+/);
      if (x && y) return Number(x[0]) === Number(y[0]);
    }
    const plain = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    return plain(a) === plain(b);
  }

  /** A press of the element as a person's would be: some players listen for the pointer, some for the click. */
  function press(group, i) {
    if (group.select) {
      group.select.selectedIndex = i;
      group.select.dispatchEvent(new Event("input", { bubbles: true }));
      group.select.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const el = group.els[i].querySelector("a, button") || group.els[i];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try {
        el.dispatchEvent(new (type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true }));
      } catch (e) {}
    }
    el.click();
  }

  /** Makes the choice `label` of kind `kind` in this frame, if a list of that kind has it. */
  function choose(kind, label, within, wide) {
    for (const group of groups(within, wide)) {
      if (group.kind !== kind) continue;
      const i = group.labels.findIndex((l) => same(kind, l, label));
      if (i < 0) continue;
      if (i !== group.active) press(group, i);
      return true;
    }
    return false;
  }

  /** The lists as they travel: the kinds alone, items trimmed, without the elements. */
  const plainGroups = (list) => list.map((g) => ({ kind: g.kind, items: g.labels.slice(0, MOST[g.kind]), active: Math.min(g.active, MOST[g.kind] - 1), named: g.named === true }));

  function cleanGroups(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const g of list.slice(0, 12)) {
      if (!g || !KINDS.includes(g.kind) || !Array.isArray(g.items)) continue;
      const items = g.items.slice(0, MOST[g.kind]).map((s) => String(s).slice(0, LABEL_MAX));
      out.push({ kind: g.kind, items, active: num(g.active, items.length - 1), named: g.named === true });
    }
    return out;
  }

  // ---- The top frame: which frame holds the player, what to tell the program, the player over the whole page.

  /** The iframe of this page that `source` (a frame's window, at any depth) is in. */
  function hostOf(source) {
    let w = source;
    try {
      for (let i = 0; i < 12 && w && w.parent !== window; i++) w = w.parent;
    } catch (e) {
      return null;
    }
    if (!w || w.parent !== window) return null;
    for (const f of document.querySelectorAll("iframe, frame")) if (f.contentWindow === w) return f;
    return null;
  }

  function chosen() {
    const now = Date.now();
    let pick = null;
    let score = -1;
    for (const [id, f] of frames) {
      if (now - f.at > 4000) {
        frames.delete(id);
        continue;
      }
      if (!f.s) continue;
      const s = f.s.area + (f.s.playing ? 1e7 : 0) + (f.s.dur > 120000 ? 5e6 : 0);
      if (s > score) {
        score = s;
        pick = f;
      }
    }
    return pick;
  }

  /** In the top page: the box around its own video (as big as it, with the player's buttons). */
  function boxOf(video) {
    const r = video.getBoundingClientRect();
    const area = Math.max(1, r.width * r.height);
    let box = video;
    for (let at = video.parentElement; at && at !== document.body; at = at.parentElement) {
      const b = at.getBoundingClientRect();
      if (b.width * b.height > area * 1.6) break;
      box = at;
    }
    return box;
  }

  /** The element of this page the player is: the frame with the video, the box of the page's own video, or the biggest frame that looks like one. */
  function playerEl() {
    const f = chosen();
    if (f && f.el && f.el.isConnected) return f.el;
    if (f && f.own) {
      const v = best();
      if (v) return boxOf(v);
    }
    let pick = null;
    let score = 0;
    for (const el of document.querySelectorAll("iframe")) {
      const r = el.getBoundingClientRect();
      const looksLike = /player|плеер|embed|video|kino|film/i.test([el.title, el.id, classOf(el), el.getAttribute("src") || "", el.getAttribute("data-src") || ""].join(" "));
      const s = r.width * r.height * (looksLike ? 4 : 1);
      if (r.width >= 200 && r.height >= 120 && s > score) {
        score = s;
        pick = el;
      }
    }
    return pick;
  }

  /** The choices to tell: the site's players from the page, the rest from the player alone. */
  function choicesNow() {
    const player = playerEl();
    const own = groups(null, true).filter((g) => g.kind === "players");
    const list = plainGroups(own);
    if (player && player.tagName !== "IFRAME" && player.tagName !== "FRAME") list.push(...plainGroups(groups(player, false)));
    for (const f of frames.values()) if (f.el && f.el === player && f.g) list.push(...f.g);
    const out = {};
    for (const g of list) {
      const was = out[g.kind];
      // Of two lists of one kind the one named so wins (a dub list called «перевод»), then the longer.
      if (!was || (g.named && !was.named) || (g.named === was.named && g.items.length > was.items.length)) out[g.kind] = { items: g.items, active: g.active, named: g.named };
    }
    for (const kind of Object.keys(out)) delete out[kind].named;
    return out;
  }

  /** The word in the title stays short: the longest lists are cut around the chosen item. */
  function fit(word) {
    let json = JSON.stringify(word);
    for (const kind of ["episode", "dub", "season"]) {
      const g = word.c[kind];
      while (json.length > 3500 && g && g.items.length > 20) {
        const from = Math.max(0, Math.min(g.active - 10, g.items.length - 20));
        g.items = g.items.slice(from, from + Math.max(20, Math.floor(g.items.length * 0.6)));
        g.active -= from;
        json = JSON.stringify(word);
      }
    }
    return json.length > 4000 ? JSON.stringify({ t: word.t, v: word.v, c: {}, th: word.th }) : json;
  }

  let theater = false;
  let staged = null;
  /** Takes the site's own title and starts telling (the top frame, once the page is parsed). */
  let hook = () => {};

  /** In the call: the player alone over the whole page, nothing of the site around it (nor its adverts). */
  function stage() {
    if (!isTop) return;
    const el = theater ? playerEl() : null;
    if (el === staged) return;
    if (staged) {
      staged.removeAttribute("data-hv-theater");
      for (const up of document.querySelectorAll("[data-hv-theater-up]")) up.removeAttribute("data-hv-theater-up");
    }
    staged = el;
    if (el) {
      if (!document.getElementById("hv-theater-style")) {
        const style = document.createElement("style");
        style.id = "hv-theater-style";
        style.textContent =
          "html[data-hv-theater-on],html[data-hv-theater-on] body{overflow:hidden!important;background:#000!important}" +
          "html[data-hv-theater-on] body *{visibility:hidden!important}" +
          "html[data-hv-theater-on] [data-hv-theater],html[data-hv-theater-on] [data-hv-theater] *{visibility:visible!important}" +
          "[data-hv-theater]{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483647!important;transform:none!important;background:#000!important}" +
          "[data-hv-theater-up]{transform:none!important;filter:none!important;perspective:none!important;contain:none!important;will-change:auto!important;backdrop-filter:none!important}";
        (document.head || document.documentElement).appendChild(style);
      }
      el.setAttribute("data-hv-theater", "");
      for (let up = el.parentElement; up; up = up.parentElement) up.setAttribute("data-hv-theater-up", "");
      // A frame that waits to be scrolled to before it loads (lazy players) is in sight now.
      if (el.tagName === "IFRAME" && !el.getAttribute("src") && el.getAttribute("data-src")) el.setAttribute("src", el.getAttribute("data-src"));
    }
    document.documentElement.toggleAttribute("data-hv-theater-on", !!el);
    publish(true);
  }

  /** The top frame's word to the program: at once on a change, every 2 s while nothing changes. */
  function publish(force) {
    if (!titleKnown) return;
    const f = chosen();
    const v = f ? f.s : null;
    const c = choicesNow();
    const word = { t: siteTitle.slice(0, 200), v, c, th: !!staged };
    const key = JSON.stringify([siteTitle, v && v.playing, v && Math.round(v.pos / 2000), v && v.dur, v && v.frame, c, word.th]);
    const now = Date.now();
    if (!force && key === lastKey && now - lastAt < 2000) return;
    lastKey = key;
    lastAt = now;
    writing = true;
    document.title = MARK + fit(word);
    writing = false;
  }

  function report(force) {
    const s = stateOf(best());
    // A frame big enough to be a player says what lists it has (an advert's little frame has none worth the look).
    const g = !isTop && window.innerWidth * window.innerHeight >= 30000 ? plainGroups(groups(null, false)) : [];
    if (isTop) {
      frames.set(me, { s, at: Date.now(), own: true, el: null, g: null });
      publish(force === true);
    } else {
      try {
        window.top.postMessage({ __hvWatch: "state", id: me, s, g, force: force === true }, "*");
      } catch (e) {}
    }
  }

  function apply(c) {
    if (!c || typeof c !== "object") return;
    if (c.op === "choose") {
      if (KINDS.includes(c.kind) && typeof c.label === "string" && c.label.length <= LABEL_MAX) {
        // In the top page: its players anywhere, the rest only inside its own player (a site's menus are no dubs).
        if (isTop) {
          if (!choose(c.kind, c.label, null, true)) {
            const player = playerEl();
            if (player && player.tagName !== "IFRAME") choose(c.kind, c.label, player, false);
          }
        } else choose(c.kind, c.label, null, false);
      }
      return;
    }
    if (c.op === "theater") {
      if (isTop) {
        theater = c.on === true;
        stage();
      }
      return;
    }
    const v = best();
    if (!v) return;
    if (c.op === "play") v.play().catch(() => {});
    else if (c.op === "pause") v.pause();
    else if (c.op === "seek" && typeof c.ms === "number" && Number.isFinite(c.ms)) v.currentTime = Math.max(0, c.ms) / 1000;
    // Catching up with everyone by speed, rather than a move the video has to load again for.
    else if (c.op === "rate" && typeof c.rate === "number" && Number.isFinite(c.rate)) v.playbackRate = Math.min(2, Math.max(0.5, c.rate));
  }

  function down(c) {
    for (const f of document.querySelectorAll("iframe, frame")) {
      try {
        f.contentWindow.postMessage({ __hvWatch: "cmd", c }, "*");
      } catch (e) {}
    }
  }

  window.__hvWatch = {
    command(c) {
      apply(c);
      if (!c || c.op !== "theater") down(c);
      setTimeout(() => report(true), 250);
    },
    /** What the program would be told now about the choices (for checks). */
    scan() {
      report(false);
      return choicesNow();
    },
  };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.__hvWatch === "state" && isTop) {
      frames.set(String(d.id).slice(0, 20), { s: clean(d.s), g: cleanGroups(d.g), at: Date.now(), el: hostOf(e.source), own: false });
      publish(d.force === true);
    } else if (d.__hvWatch === "cmd" && e.source === window.parent) {
      apply(d.c);
      down(d.c);
    }
  });

  for (const name of ["play", "pause", "seeked", "ended", "loadedmetadata", "ratechange"]) {
    document.addEventListener(name, () => report(true), true);
  }
  setInterval(() => {
    // A page whose adverts never finish loading never says DOMContentLoaded: its title is taken once it is parsed.
    if (isTop && !titleKnown && document.readyState !== "loading") hook();
    report(false);
    stage();
  }, 1000);

  if (isTop) {
    // The site's own title: kept for the program, and put back under the mark whenever the site changes it.
    const watchTitle = () => {
      if (writing) return;
      const now = document.title;
      if (now.startsWith(MARK)) return;
      siteTitle = now;
      publish(true);
    };
    hook = () => {
      if (titleKnown) return;
      const el = document.querySelector("title");
      if (el) new MutationObserver(watchTitle).observe(el, { childList: true, characterData: true, subtree: true });
      // A title the site puts in later, or replaces: only the head is watched, not every change of the page.
      new MutationObserver(watchTitle).observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
      titleKnown = true;
      watchTitle();
      report(true);
    };
    // Parsed is enough («interactive»): DOMContentLoaded waits for every deferred script, and an advert's may never come.
    if (document.readyState === "loading") document.addEventListener("readystatechange", () => document.readyState !== "loading" && hook());
    else hook();
  }
})();
