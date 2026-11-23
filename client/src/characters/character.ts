/**
 * A person's 3D character: a little figure built in code from simple shapes (no model files), told by a short code
 * that travels in the signed profile, so friends see it in calls.
 */

export const BODIES = ["round", "tall", "chunky"] as const;
export const HAIRS = ["none", "short", "spiky", "long", "bun", "curly", "mohawk", "ponytail", "bob"] as const;
export const HATS = ["none", "cap", "beanie", "crown", "cowboy", "horns", "bunny", "cat", "headphones"] as const;
export const EYES = ["dots", "happy", "sleepy", "cool"] as const;
export const TOPS = ["hoodie", "tee", "suit", "dress"] as const;
export const EXTRAS = ["none", "glasses", "beard", "scarf", "backpack", "cape"] as const;

export type Body = (typeof BODIES)[number];
export type Hair = (typeof HAIRS)[number];
export type Hat = (typeof HATS)[number];
export type Eyes = (typeof EYES)[number];
export type Top = (typeof TOPS)[number];
export type Extra = (typeof EXTRAS)[number];

export type Character = {
  body: Body;
  /** `#rrggbb` */
  skin: string;
  outfit: string;
  hair: Hair;
  hairColor: string;
  hat: Hat;
  eyes: Eyes;
  top: Top;
  /** Trousers and shoes. */
  bottom: string;
  extra: Extra;
};

export const BODY_NAMES: Record<Body, string> = { round: "Круглый", tall: "Высокий", chunky: "Крепыш" };
export const HAIR_NAMES: Record<Hair, string> = {
  none: "Без волос",
  short: "Короткие",
  spiky: "Ёжик",
  long: "Длинные",
  bun: "Пучок",
  curly: "Кудри",
  mohawk: "Ирокез",
  ponytail: "Хвост",
  bob: "Каре",
};
export const HAT_NAMES: Record<Hat, string> = {
  none: "Без шапки",
  cap: "Кепка",
  beanie: "Шапка",
  crown: "Корона",
  cowboy: "Ковбойская",
  horns: "Рожки",
  bunny: "Зайка",
  cat: "Котик",
  headphones: "Наушники",
};
export const EYE_NAMES: Record<Eyes, string> = { dots: "Точки", happy: "Весёлые", sleepy: "Сонные", cool: "Тёмные очки" };
export const TOP_NAMES: Record<Top, string> = { hoodie: "Худи", tee: "Футболка", suit: "Костюм", dress: "Платье" };
export const EXTRA_NAMES: Record<Extra, string> = { none: "Ничего", glasses: "Очки", beard: "Борода", scarf: "Шарф", backpack: "Рюкзак", cape: "Плащ" };

export const SKINS = ["#f6d1b1", "#e9b48a", "#c98b62", "#8d5a3b", "#5a3825", "#b7e3a0", "#a8c8ff"];

export const DEFAULT_CHARACTER: Character = {
  body: "round",
  skin: "#f6d1b1",
  outfit: "#ff8a4c",
  hair: "short",
  hairColor: "#3b2a20",
  hat: "none",
  eyes: "dots",
  top: "hoodie",
  bottom: "#3a3f4b",
  extra: "none",
};

const HEX6 = /^[0-9a-f]{6}$/;
/** `c1` is the code of a first version, with fewer parts; the rest of a character comes from its defaults. */
const CODE = /^c1(\.[a-z0-9]+){7}$|^c2(\.[a-z0-9]+){10}$/;

/** The character as a short code for the profile: `c2.body.skin.outfit.hair.haircolor.hat.eyes.top.bottom.extra` (colors without #). */
export function characterCode(c: Character): string {
  const hex = (color: string) => color.replace("#", "").toLowerCase();
  return ["c2", c.body, hex(c.skin), hex(c.outfit), c.hair, hex(c.hairColor), c.hat, c.eyes, c.top, hex(c.bottom), c.extra].join(".");
}

/** A character from its code; null when it is none (a friend's newer version, or garbage). */
export function parseCharacter(code: unknown): Character | null {
  if (typeof code !== "string" || code.length > 96 || !CODE.test(code)) return null;
  const [version, body, skin, outfit, hair, hairColor, hat, eyes, top, bottom, extra] = code.split(".");
  const one = <T extends string>(value: string | undefined, allowed: readonly T[]) => (allowed.includes(value as T) ? (value as T) : null);
  const color = (value: string | undefined) => (value && HEX6.test(value) ? `#${value}` : null);
  const parsed = {
    body: one(body, BODIES),
    skin: color(skin),
    outfit: color(outfit),
    hair: one(hair, HAIRS),
    hairColor: color(hairColor),
    hat: one(hat, HATS),
    eyes: one(eyes, EYES),
    top: version === "c1" ? DEFAULT_CHARACTER.top : one(top, TOPS),
    bottom: version === "c1" ? DEFAULT_CHARACTER.bottom : color(bottom),
    extra: version === "c1" ? DEFAULT_CHARACTER.extra : one(extra, EXTRAS),
  };
  return Object.values(parsed).every((v) => v !== null) ? (parsed as Character) : null;
}

/** Someone who made no character gets one from their avatar color, the same on every PC. */
export function defaultCharacterFor(userId: string, color: string): Character {
  let seed = 0;
  for (const ch of userId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const pick = <T>(list: readonly T[], shift: number) => list[(seed >>> shift) % list.length]!;
  const outfit = /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_CHARACTER.outfit;
  return {
    body: pick(BODIES, 0),
    skin: pick(SKINS.slice(0, 5), 3),
    outfit,
    hair: pick(HAIRS, 6),
    hairColor: pick(["#3b2a20", "#14121f", "#c9a24a", "#a0522d", "#e8e0d0"], 9),
    hat: "none",
    eyes: pick(EYES.slice(0, 3), 12),
    top: pick(TOPS.slice(0, 2), 15),
    bottom: pick(["#3a3f4b", "#2d3a55", "#4a4238", "#26282e"], 17),
    extra: "none",
  };
}

/** What a character can do by a button, and what two can do together. */
export const EMOTES = [
  { id: "wave", name: "Помахать", emoji: "👋" },
  { id: "byebye", name: "Пока-пока", emoji: "🖐️" },
  { id: "hooray", name: "Ура!", emoji: "🙌" },
  { id: "raise", name: "Я тут!", emoji: "🙋" },
  { id: "call", name: "Позвать", emoji: "📣" },
  { id: "guide", name: "Сюда!", emoji: "👉" },
  { id: "jump", name: "Прыжок", emoji: "🦘" },
  { id: "dance", name: "Танец", emoji: "💃" },
  { id: "spin", name: "Волчок", emoji: "🌀" },
  { id: "laugh", name: "Смех", emoji: "😂" },
  { id: "love", name: "Любовь", emoji: "😍" },
  { id: "angry", name: "Злость", emoji: "😡" },
  { id: "cry", name: "Слёзы", emoji: "😭" },
  { id: "clap", name: "Хлопать", emoji: "👏" },
  { id: "sleep", name: "Спать", emoji: "😴" },
  { id: "bow", name: "Поклон", emoji: "🙇" },
  { id: "flex", name: "Мускулы", emoji: "💪" },
  { id: "facepalm", name: "Рука-лицо", emoji: "🤦" },
  { id: "think", name: "Думать", emoji: "🤔" },
  { id: "shrug", name: "Не знаю", emoji: "🤷" },
  { id: "thumbsup", name: "Класс", emoji: "👍" },
  { id: "salute", name: "Честь", emoji: "🫡" },
  { id: "flip", name: "Сальто", emoji: "🤸" },
  { id: "robot", name: "Робот", emoji: "🤖" },
  { id: "guitar", name: "Гитара", emoji: "🎸" },
  { id: "dj", name: "Диджей", emoji: "🎧" },
  { id: "sit", name: "Присесть", emoji: "🪑" },
  { id: "pushups", name: "Отжимания", emoji: "🏋️" },
  { id: "yes", name: "Кивнуть", emoji: "🙆" },
  { id: "no", name: "Нет-нет", emoji: "🙅" },
  { id: "fold", name: "Руки на груди", emoji: "😤" },
  { id: "phone", name: "Позвонить", emoji: "📞" },
  { id: "spell", name: "Колдовать", emoji: "🪄" },
  { id: "zombie", name: "Зомби", emoji: "🧟" },
  { id: "faint", name: "Упасть", emoji: "😵" },
] as const;

export const INTERACTIONS = [
  { id: "hug", name: "Обнять", emoji: "🤗" },
  { id: "highfive", name: "Дать пять", emoji: "🙌" },
  { id: "push", name: "Толкнуть", emoji: "🫸" },
  { id: "heart", name: "Сердечко", emoji: "💖" },
  { id: "snowball", name: "Снежок", emoji: "❄️" },
  { id: "fistbump", name: "Кулачки", emoji: "🤜" },
  { id: "handshake", name: "Пожать руку", emoji: "🤝" },
  { id: "pat", name: "Погладить", emoji: "🫳" },
  { id: "pie", name: "Торт в лицо", emoji: "🥧" },
  { id: "kiss", name: "Чмок", emoji: "😘" },
  { id: "dancewith", name: "Танец вдвоём", emoji: "🕺" },
  { id: "tickle", name: "Щекотать", emoji: "🤭" },
  { id: "bonk", name: "Подзатыльник", emoji: "🔨" },
] as const;

export type EmoteId = (typeof EMOTES)[number]["id"];
export type InteractionId = (typeof INTERACTIONS)[number]["id"];

export function isAct(id: unknown): id is EmoteId | InteractionId {
  return EMOTES.some((e) => e.id === id) || INTERACTIONS.some((i) => i.id === id) || isMove(id) || (typeof id === "string" && /^clip[a-z]{1,12}$/.test(id));
}

/** Where someone put their character on the stage goes out as an act of letters: `go`, then x and z in base 16 of a–p. */
const MOVE = /^go[a-p]{6}$/;
const MOVE_RANGE = 6;

export function isMove(id: unknown): id is string {
  return typeof id === "string" && MOVE.test(id);
}

const letters = (n: number) => [(n >> 8) & 15, (n >> 4) & 15, n & 15].map((d) => String.fromCharCode(97 + d)).join("");

export function moveAct(x: number, z: number): string {
  const part = (v: number) => Math.round(((Math.max(-MOVE_RANGE, Math.min(MOVE_RANGE, v)) + MOVE_RANGE) / (MOVE_RANGE * 2)) * 4095);
  return `go${letters(part(x))}${letters(part(z))}`;
}

export function parseMove(id: string): { x: number; z: number } | null {
  if (!isMove(id)) return null;
  const part = (from: number) => {
    let n = 0;
    for (let i = from; i < from + 3; i++) n = n * 16 + (id.charCodeAt(i) - 97);
    return (n / 4095) * MOVE_RANGE * 2 - MOVE_RANGE;
  };
  return { x: part(2), z: part(5) };
}

export function isInteraction(id: unknown): id is InteractionId {
  return INTERACTIONS.some((i) => i.id === id);
}
