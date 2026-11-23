import { useState, type CSSProperties } from "react";
import { knownFrame } from "./frames";

/** First letters of up to two words, upper-cased; "?" for an empty name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** What an avatar is painted with: a named color's variable, or one's own `#rrggbb`. */
export function avatarFill(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : `var(--av-${color}, var(--av-blue))`;
}

type Props = {
  name: string;
  /** One of the avatar colors (--av-*), or `#rrggbb`. */
  color: string;
  size?: number;
  speaking?: boolean;
  /** 0–1 voice level; widens the speaking ring. */
  level?: number;
  /** The frame around it (see `frames.ts`); unknown ones are not drawn. */
  frame?: string | null;
  /** The face of one's 3D character (see `portraitFor`): it takes the place of the letters. */
  picture?: string | null;
};

export function Avatar({ name, color, size = 32, speaking, level = 0, frame, picture }: Props) {
  // A picture that does not load leaves the letters.
  const [broken, setBroken] = useState<string | null>(null);
  const shown = picture && picture !== broken ? picture : null;
  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.4),
    background: shown ? `color-mix(in srgb, ${avatarFill(color)} 38%, #161a22)` : avatarFill(color),
    "--level": Math.max(0, Math.min(1, level)),
  } as CSSProperties;
  const avatar = (
    <span className={[speaking ? "avatar speaking" : "avatar", shown ? "pictured" : ""].filter(Boolean).join(" ")} style={style} aria-hidden="true">
      {shown ? <img className="avatar-picture" src={shown} alt="" draggable={false} onError={() => setBroken(shown)} /> : initials(name)}
    </span>
  );
  const drawn = knownFrame(frame);
  if (!drawn) return avatar;
  return (
    <span className={`framed frame-${drawn}`} style={{ "--s": `${size}px` } as CSSProperties} aria-hidden="true">
      {avatar}
      <span className="frame-a" />
      <span className="frame-b" />
    </span>
  );
}
