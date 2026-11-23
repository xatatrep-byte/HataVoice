/**
 * The phone's back key for what opens over the page (a window, a menu): each takes a step in the web view's history, and
 * back closes the one on top — not the app (without a step of its own, back left the app from inside the settings).
 * Closed by its own button, a window takes its step out again, quietly. The shell's own back (to the home page) leaves a
 * step taken here alone (`backTakenBy`).
 */

type Entry = { close: () => void };

const stack: Entry[] = [];
/** Steps taken out by a window closed with its own button: the history moves, nobody is closed for it. */
let quiet = 0;
let handled: Event | null = null;

function onPop(event: PopStateEvent) {
  if (quiet > 0) {
    quiet--;
    handled = event;
    return;
  }
  const top = stack.pop();
  if (!top) return;
  handled = event;
  top.close();
}

let listening = false;

/**
 * Takes a history step for something open; back calls `close`. The returned function is for when it closed by itself
 * (its own button, Escape): the step goes out, quietly.
 */
export function holdBack(close: () => void): () => void {
  if (!listening && typeof window !== "undefined") {
    // Capture: at the window itself capture listeners run first, so this sees the step before the shell does.
    window.addEventListener("popstate", onPop, true);
    listening = true;
  }
  const entry: Entry = { close };
  stack.push(entry);
  history.pushState({ hvBack: stack.length }, "");
  return () => {
    const at = stack.indexOf(entry);
    if (at < 0) return;
    stack.splice(at, 1);
    quiet++;
    history.back();
  };
}

/** Whether this history step closed a window (the shell then does nothing with it). */
export function backTakenBy(event: Event): boolean {
  return handled === event;
}

/** For tests: forget everything. */
export function resetBack() {
  stack.length = 0;
  quiet = 0;
  handled = null;
}
