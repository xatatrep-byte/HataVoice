import { EMOTES } from "../../characters/character";

/** Ready motions by kind, for both editors' libraries. */
export type Group = "hello" | "dance" | "feel" | "sport";

export const GROUP_OF: Record<string, Group> = {
  wave: "hello", byebye: "hello", raise: "hello", call: "hello", guide: "hello", bow: "hello", salute: "hello", thumbsup: "hello", yes: "hello", no: "hello", phone: "hello", hooray: "feel",
  dance: "dance", spin: "dance", robot: "dance", guitar: "dance", dj: "dance",
  laugh: "feel", love: "feel", angry: "feel", cry: "feel", facepalm: "feel", think: "feel", shrug: "feel", fold: "feel", sleep: "feel", faint: "feel", zombie: "feel",
  jump: "sport", flip: "sport", flex: "sport", pushups: "sport", sit: "sport", spell: "sport",
};

/** Motions one does alone: the ones two do together need someone to do them to. */
export const SOLO = EMOTES.filter((e) => e.id in GROUP_OF);
export const SOLO_IDS: ReadonlySet<string> = new Set<string>(SOLO.map((e) => e.id));
export const nameOf = (act: string) => SOLO.find((e) => e.id === act)?.name ?? act;
