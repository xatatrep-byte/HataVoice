/**
 * Our icons for voices, a character's acts and the chat's quick reactions: Microsoft's Fluent Emoji in 3D (MIT,
 * github.com/microsoft/fluentui-emoji), 128 px WebP in public/emoji. The same on every PC, unlike Windows' emoji font.
 * Anything we have no picture for (an emoji typed by a person, a workshop motion's own mark) stays a character.
 */

/** Act ids with a picture of their own (`/emoji/<id>.webp`). */
const ACTS = new Set([
  "wave", "jump", "dance", "spin", "laugh", "love", "angry", "cry", "clap", "sleep", "bow", "flex", "facepalm", "think",
  "shrug", "thumbsup", "salute", "flip", "robot", "guitar", "dj", "sit", "pushups", "hug", "highfive", "push", "heart",
  "snowball", "fistbump", "handshake", "pat", "pie", "kiss", "dancewith", "tickle", "bonk",
  "yes", "no", "fold", "phone", "spell", "zombie", "faint",
]);
/** Acts whose picture is a PNG (Fluent Emoji 3D, 256 px), not a WebP. */
const PNG_ACTS = new Set(["hooray", "byebye", "raise", "call", "guide"]);

/** Voice presets with a picture (`/emoji/v-<id>.webp`). */
const VOICES = new Set(["none", "chipmunk", "helium", "giant", "demon", "robot", "alien", "tipsy", "radio", "cave", "announcer", "ghost", "custom"]);

/** The chat's quick reactions, by the character people send. */
const REACTIONS: Record<string, string> = {
  "👍": "r-thumbsup",
  "❤️": "r-heart",
  "❤": "r-heart",
  "😂": "r-laugh",
  "😮": "r-wow",
  "😢": "r-sad",
  "🔥": "r-fire",
  "👀": "r-eyes",
  "✅": "r-check",
};

export function emojiPicture(kind: "act" | "voice" | "char", key: string): string | null {
  if (kind === "act") return PNG_ACTS.has(key) ? `/emoji/${key}.png` : ACTS.has(key) ? `/emoji/${key}.webp` : null;
  if (kind === "voice") return VOICES.has(key) ? `/emoji/v-${key}.webp` : null;
  const id = REACTIONS[key];
  return id ? `/emoji/${id}.webp` : null;
}

type Props = {
  /** What it is: an act's id, a voice preset's id, or an emoji character. */
  kind: "act" | "voice" | "char";
  id: string;
  /** What to show where there is no picture. */
  fallback?: string;
  size?: number;
  className?: string;
};

export function Emoji({ kind, id, fallback, size = 24, className = "" }: Props) {
  const src = emojiPicture(kind, id);
  if (!src) {
    return (
      <span className={`emoji-char ${className}`.trim()} style={{ fontSize: size * 0.82, lineHeight: 1 }} aria-hidden>
        {fallback ?? (kind === "char" ? id : "")}
      </span>
    );
  }
  return <img className={`emoji ${className}`.trim()} src={src} width={size} height={size} alt="" draggable={false} aria-hidden />;
}
