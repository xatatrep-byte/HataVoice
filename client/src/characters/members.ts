import type { ParticipantView } from "../voice/participants";
import { defaultCharacterFor, parseCharacter } from "./character";
import { defaultAvatarFor, GALLERY, galleryPicture, parseAvatar } from "./gallery";
import type { SceneMember } from "./scene";

/**
 * The face of whom one is on the stage, for an avatar: a model of the gallery (chosen, or given to whoever chose nothing).
 * A figure built in code and a model of one's own have no picture: their letters stay.
 */
export function portraitFor(character: string | null | undefined, userId: string): string | null {
  if (parseCharacter(character)) return null;
  const code = parseAvatar(character) ? (character as string) : defaultAvatarFor(userId);
  const model = parseAvatar(code);
  return model?.kind === "gallery" && GALLERY.some((m) => m.id === model.id) ? galleryPicture(model.id) : null;
}

/**
 * The call's people on the stage: ours as we set it just now, the others' from their signed profiles. Whoever chose
 * nothing gets a person of the gallery, the same on every PC. `colorOf` turns a named avatar color into `#rrggbb`;
 * `address` is the server that keeps models of one's own.
 */
export function sceneMembers(participants: ParticipantView[], mine: string | null, colorOf: (color: string) => string, address?: string | null): SceneMember[] {
  return participants.map((p) => {
    const code = p.isLocal ? mine : p.character;
    const built = parseCharacter(code);
    return {
      id: p.identity,
      name: p.name,
      character: built ?? defaultCharacterFor(p.identity, colorOf(p.color)),
      ...(built ? {} : { avatar: parseAvatar(code) ? (code as string) : defaultAvatarFor(p.identity) }),
      ...(address ? { source: address } : {}),
      level: p.muted ? 0 : p.level,
      speaking: p.speaking && !p.muted,
      local: p.isLocal,
    };
  });
}

/** A named avatar color as the theme paints it (`--av-*`), or the color itself when it is one of one's own. */
export function cssColor(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (typeof document === "undefined") return color;
  return getComputedStyle(document.documentElement).getPropertyValue(`--av-${color}`).trim() || color;
}
