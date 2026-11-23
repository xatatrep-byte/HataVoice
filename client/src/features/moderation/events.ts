import type { MediaRef, ServerEvent } from "../../server/session";

/** What a moderation event means for us. */
export type ModerationAction =
  | { kind: "moved"; channel: string; by: string }
  | { kind: "disconnected"; by: string }
  | { kind: "punished"; punishment: "kick" | "ban"; by: string; reason: string; media: MediaRef | null; until: number | null }
  | { kind: "notice"; user: string; punishment: "kick" | "ban"; reason: string; media: MediaRef | null }
  | { kind: "muted"; by: string; until: number | null; reason: string }
  | { kind: "unmuted" };

const text = (v: unknown) => (typeof v === "string" ? v : "");
const media = (v: unknown) => (v && typeof v === "object" ? (v as MediaRef) : null);
const time = (v: unknown) => (typeof v === "number" ? v : null);

/**
 * Moves, kicks and bans reach only their target; mutes and notices go to many, so the ones about
 * us (mutes) or about others (notices) are picked out by `me`.
 */
export function moderationAction(event: ServerEvent, me: string): ModerationAction | null {
  switch (event.type) {
    case "moved":
      return { kind: "moved", channel: text(event.channel), by: text(event.by) };
    case "disconnected":
      return { kind: "disconnected", by: text(event.by) };
    case "kicked":
    case "banned":
      return {
        kind: "punished",
        punishment: event.type === "kicked" ? "kick" : "ban",
        by: text(event.by),
        reason: text(event.reason),
        media: media(event.media),
        until: time(event.until),
      };
    case "mute":
      return event.user === me ? { kind: "muted", by: text(event.by), until: time(event.until), reason: text(event.reason) } : null;
    case "unmute":
      return event.user === me ? { kind: "unmuted" } : null;
    case "moderation_notice":
      if (event.user === me) return null;
      return {
        kind: "notice",
        user: text(event.user),
        punishment: event.kind === "ban" ? "ban" : "kick",
        reason: text(event.reason),
        media: media(event.media),
      };
    default:
      return null;
  }
}

/** «на 15 минут», «на 1 час», «на 1 день», «до снятия». */
export function muteSpan(seconds: number | null): string {
  if (seconds === null) return "до снятия";
  const minutes = Math.max(1, Math.round(seconds / 60));
  const plural = (n: number, forms: [string, string, string]) => {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? forms[1] : forms[2];
  };
  if (minutes % 1440 === 0) return `на ${minutes / 1440} ${plural(minutes / 1440, ["день", "дня", "дней"])}`;
  if (minutes % 60 === 0) return `на ${minutes / 60} ${plural(minutes / 60, ["час", "часа", "часов"])}`;
  return `на ${minutes} ${plural(minutes, ["минуту", "минуты", "минут"])}`;
}
