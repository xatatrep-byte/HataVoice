import { invoke } from "@tauri-apps/api/core";
import type { CustomGame } from "../../state/prefs";

/**
 * Hands «Показывать, во что я играю» and the user's own games to the Rust watcher. Turning it
 * off clears the status on every server right away instead of at the next 15-second check.
 */
export async function applyGameStatus(enabled: boolean, custom: CustomGame[]): Promise<void> {
  const games = custom
    .map((g) => ({ exe: g.exe.trim(), title: g.title.trim() }))
    .filter((g) => g.exe && g.title);
  await invoke("games_custom", { games });
  await invoke("games_enable", { enabled });
  if (!enabled) await invoke("presence_set", { activity: null });
}
