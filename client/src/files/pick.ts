import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Files the person picks: the dialog is the program's own (Rust opens it), and the page gets a one-off token for each
 * file instead of its path. Commands that read or write a file take the token, so nothing in the page can name a file
 * of this PC on its own (picked.rs).
 */
export type Picked = { token: string; name: string; size: number };

/** What is picked: it sets the dialog's filter. */
export type PickKind = "any" | "gif" | "icon" | "identity";

export function pickFiles(kind: PickKind, multiple: boolean, title?: string): Promise<Picked[]> {
  return invoke<Picked[]>("pick_files", { kind, multiple, title: title ?? null });
}

/** Where to save, `name` offered; null when the person changed their mind. */
export function pickSave(kind: PickKind, name: string): Promise<Picked | null> {
  return invoke<Picked | null>("pick_save", { kind, name });
}

/** Files dropped on the window, as Windows told Rust: by token. Gives a way to stop listening. */
export function onFilesDropped(handler: (files: Picked[]) => void): Promise<() => void> {
  return listen<Picked[]>("files-dropped", (event) => handler(event.payload));
}
