import { invoke } from "@tauri-apps/api/core";
import { loadJson } from "../../state/persist";

/**
 * «Мои гифки»: files used in a kick or ban before, uploaded again to whichever server needs it. Rust keeps the list (the
 * page sees names and ids, never paths: picked.rs), so nothing in the page can make it read another file.
 */
export type MyGif = { id: string; name: string };

/** Where the page kept the list before 0.14.1: paths, handed to Rust once (it takes in only real GIFs and clips). */
const LEGACY_KEY = "hatavoice.myGifs";

function legacyPaths(): string[] | null {
  const stored = loadJson(LEGACY_KEY);
  if (!Array.isArray(stored)) return null;
  const paths = stored.flatMap((g) => (typeof g?.path === "string" ? [g.path as string] : []));
  return paths.length > 0 ? paths : null;
}

export async function loadMyGifs(): Promise<MyGif[]> {
  const legacy = legacyPaths();
  const gifs = await invoke<MyGif[]>("my_gifs", { legacy });
  if (legacy) {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // Storage may be unavailable; the list is in Rust now anyway.
    }
  }
  return gifs;
}
