/**
 * Our own character beyond what fits in a code: a model from a file and motions made in the workshop. Both go into a pack
 * that is sealed and put on every server we are on; the profile then says only `p1.<sha>.<key>`.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { parseClip, type AvatarPack, type Clip } from "./clip";
import { browserPacker, inspectModel, MAX_MODEL_BYTES, ModelError, shrinkModel } from "./glb";
import { packCode, parseAvatar } from "./gallery";
import { parseCharacter } from "./character";

const STORE = "hatavoice.avatar";
const PUBLISHED = "hatavoice.avatar.published";
/** A file put on a server stays 90 days: it is renewed long before. */
const RENEW_MS = 14 * 24 * 3600_000;

export type MyAvatar = {
  /** A model file of ours, sealed here. */
  model: { sha: string; key: string; name: string } | null;
  /** The code of what we are without a file: a model of the gallery or a figure from code. */
  base: string | null;
  clips: Clip[];
  /** The sealed pack of all that, when there is one. */
  pack: { sha: string; key: string } | null;
};

const EMPTY: MyAvatar = { model: null, base: null, clips: [], pack: null };

export function loadMyAvatar(): MyAvatar {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<MyAvatar> | null;
    if (!raw) return { ...EMPTY };
    return {
      model: raw.model ?? null,
      base: raw.base ?? null,
      clips: (raw.clips ?? []).map(parseClip).filter((c): c is Clip => c !== null),
      pack: raw.pack ?? null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** What we are now, for the pages that show it. Motions in the works are kept as they change. */
export const useMyAvatar = create<{ avatar: MyAvatar; setAvatar: (avatar: MyAvatar) => void }>((set) => ({
  avatar: loadMyAvatar(),
  setAvatar: (avatar) => {
    saveMyAvatar(avatar);
    set({ avatar });
  },
}));

function saveMyAvatar(avatar: MyAvatar) {
  try {
    localStorage.setItem(STORE, JSON.stringify(avatar));
  } catch {
    // Too much for the store: it still works until the program closes.
  }
}

async function seal(bytes: Uint8Array): Promise<{ sha: string; key: string }> {
  return invoke<{ sha: string; key: string }>("avatar_seal", bytes, { headers: { "content-type": "application/octet-stream" } });
}

/** What the profile should say for this avatar. */
export function codeOf(avatar: MyAvatar): string | null {
  return avatar.pack ? packCode(avatar.pack.sha, avatar.pack.key) : avatar.base;
}

/** The pack sealed again after a change; without a model file or motions there is no need for one. */
async function repack(avatar: MyAvatar): Promise<MyAvatar> {
  if (!avatar.model && avatar.clips.length === 0) return { ...avatar, pack: null };
  const pack: AvatarPack = { v: 1, clips: avatar.clips };
  if (avatar.model) pack.model = { sha: avatar.model.sha, key: avatar.model.key };
  else {
    const base = avatar.base ? parseAvatar(avatar.base) : null;
    if (base?.kind === "gallery") pack.gallery = base.id;
    else if (avatar.base && parseCharacter(avatar.base)) pack.figure = avatar.base;
  }
  const sealed = await seal(new TextEncoder().encode(JSON.stringify(pack)));
  return { ...avatar, pack: sealed };
}

/** Saved and sealed: the code for the profile comes back. */
export async function commitAvatar(avatar: MyAvatar): Promise<{ avatar: MyAvatar; code: string | null }> {
  const next = await repack(avatar);
  saveMyAvatar(next);
  return { avatar: next, code: codeOf(next) };
}

/** A file from the disk made ready to travel: an FBX becomes a GLB, the pictures are packed, everything is checked. */
export async function prepareModel(file: File): Promise<{ bytes: Uint8Array; title: string | null; triangles: number }> {
  const name = file.name.toLowerCase();
  if (file.size > 400 * 1024 * 1024) throw new ModelError("Файл слишком большой");
  let bytes: ArrayBuffer | Uint8Array = await file.arrayBuffer();
  if (name.endsWith(".fbx")) {
    const { fbxToGlb } = await import("./convert");
    bytes = await fbxToGlb(bytes as ArrayBuffer);
  } else if (!name.endsWith(".vrm") && !name.endsWith(".glb")) {
    throw new ModelError("Нужен файл .vrm, .glb или .fbx");
  }
  // Before the work: a stranger's address inside a file is refused however big the file is.
  inspectModel(bytes, 400 * 1024 * 1024);
  const shrunk = await shrinkModel(bytes, browserPacker, 1024);
  const smaller = shrunk.length > MAX_MODEL_BYTES ? await shrinkModel(shrunk, browserPacker, 512) : shrunk;
  const report = inspectModel(smaller);
  return { bytes: smaller, title: report.title, triangles: report.triangles };
}

/** A file of ours sealed and made our character. */
export async function adoptModelFile(avatar: MyAvatar, bytes: Uint8Array, name: string): Promise<{ avatar: MyAvatar; code: string | null }> {
  const sealed = await seal(bytes);
  return commitAvatar({ ...avatar, model: { ...sealed, name } });
}

type Published = Record<string, number>;

function published(): Published {
  try {
    return JSON.parse(localStorage.getItem(PUBLISHED) ?? "{}") as Published;
  } catch {
    return {};
  }
}

/** Puts our files on this server, unless they were put there lately. Friends fetch them by the code in the profile. */
export async function publishAvatar(address: string, avatar: MyAvatar): Promise<void> {
  const files = [avatar.pack?.sha, avatar.model?.sha].filter((sha): sha is string => !!sha);
  const seen = published();
  const now = Date.now();
  for (const sha of files) {
    const key = `${address}|${sha}`;
    if (now - (seen[key] ?? 0) < RENEW_MS) continue;
    await invoke("avatar_publish", { address, sha });
    seen[key] = now;
    localStorage.setItem(PUBLISHED, JSON.stringify(seen));
  }
}
