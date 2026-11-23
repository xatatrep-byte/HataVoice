import type { VideoTrack } from "livekit-client";
import { displayName, type MemberView } from "../server/session";
import { parseProfileColor, type ProfileColor } from "../state/prefs";
import type { CallSecurity } from "./callSecurity";
import { judgeNet, type NetJudgement } from "./netQuality";
import type { NetStats } from "./useNetStats";

/** The subset of a LiveKit participant the UI reads. */
export type ParticipantLike = {
  identity: string;
  name?: string;
  isSpeaking: boolean;
  isMicrophoneEnabled: boolean;
  isLocal: boolean;
  attributes?: Readonly<Record<string, string>>;
  connectionQuality?: string;
  audioLevel?: number;
};

export type Quality = "excellent" | "good" | "poor" | "lost" | "unknown";

export type ParticipantView = {
  identity: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  isLocal: boolean;
  quality: Quality;
  /** Voice level 0–1, drives the speaking ring. */
  level: number;
  deafened: boolean;
  color: ProfileColor;
  /** The frame around the avatar, from the person's profile. */
  frame?: string | null;
  /** The 3D character's code, from the person's profile. */
  character?: string | null;
  /** Inside the call's encryption group. Someone outside it has no key: we do not hear them, nor they us. */
  encrypted: boolean;
  /** The bars and who makes the link worse, once measured (`withNet`). */
  net?: NetJudgement | null;
  /** Their camera's picture while it is on and may be shown (encrypted, inside the call's encryption). */
  camera?: VideoTrack | null;
  /** They play music for the call (music together) and it may be heard; for ourselves, while ours goes. */
  music?: boolean;
};

const QUALITIES: readonly Quality[] = ["excellent", "good", "poor", "lost", "unknown"];

/**
 * Names and colors from the signed journal and profiles, matched by identity (the user id the
 * server put in the pass). LiveKit lets a client rename itself, so its own `name` only stands in
 * for someone the journal doesn't know.
 */
export function withMemberNames(views: ParticipantView[], members: MemberView[]): ParticipantView[] {
  const byId = new Map(members.map((m) => [m.user_id, m]));
  return views
    .map((view) => {
      const member = byId.get(view.identity);
      if (!member) return view;
      const color = parseProfileColor(member.color) ?? view.color;
      return { ...view, name: displayName(member), color, frame: member.frame ?? null, character: member.character ?? null };
    })
    .sort(byStage);
}

/** Us first, then everyone by name. */
function byStage(a: ParticipantView, b: ParticipantView): number {
  if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
  return a.name.localeCompare(b.name, "ru");
}

/**
 * Who is inside the call's encryption: the people in the group, and us once the call is secure.
 * Someone in the room but not in the group has no key, so they are neither heard nor hear us. Nor
 * is someone who showed an unencrypted track in this call (`tainted`), whatever the group says.
 */
export function withEncryption(
  views: ParticipantView[],
  security: CallSecurity,
  tainted: ReadonlySet<string> = new Set(),
): ParticipantView[] {
  const group = new Set(security.members);
  return views.map((view) => ({
    ...view,
    encrypted: view.isLocal ? security.state === "secure" : group.has(view.identity) && !tainted.has(view.identity),
  }));
}

/** LiveKit participant attributes we publish about ourselves: only what is not who we are (that is in the group). */
export const ATTR_DEAFENED = "deafened";
/** «1» while the window we show froze: a game in full screen gives Windows no picture (`frozenShare.ts`). */
export const ATTR_SCREEN_FROZEN = "screen-frozen";
/** «phone» from a phone: its screen can be watched, never driven (Android lets no app put a friend's touches in). */
export const ATTR_DEVICE = "device";

export type SpeechState = { speaking: boolean; level: number };

/**
 * `local` is what we send (our voice activation), `remote` the voices as heard on this PC.
 * LiveKit's own `isSpeaking` uses a fixed server threshold that quiet mics never reach, so it is
 * only the fallback for someone not measured yet.
 */
export function toParticipantViews(
  list: ParticipantLike[],
  {
    local = { speaking: false, level: 0 },
    remote = () => undefined,
  }: { local?: SpeechState; remote?: (identity: string) => SpeechState | undefined } = {},
): ParticipantView[] {
  return list
    .map((p): ParticipantView => {
      const attrs = p.attributes ?? {};
      const quality = QUALITIES.includes(p.connectionQuality as Quality) ? (p.connectionQuality as Quality) : "unknown";
      const speech = p.isLocal ? local : (remote(p.identity) ?? { speaking: p.isSpeaking, level: p.audioLevel ?? 0 });
      return {
        identity: p.identity,
        // LiveKit knows no nickname: `withMemberNames` gives it from the server's group.
        name: p.name || "Без ника",
        speaking: speech.speaking,
        muted: !p.isMicrophoneEnabled,
        isLocal: p.isLocal,
        quality,
        level: speech.level,
        deafened: attrs[ATTR_DEAFENED] === "1",
        color: "blue",
        // Set by `withEncryption`, which knows the call.
        encrypted: false,
      };
    })
    .sort(byStage);
}

/** The bars and blame of every one in the call, by what this PC measured and what the server says of each. */
export function withNet(views: ParticipantView[], stats: NetStats | null): { views: ParticipantView[]; mine: NetJudgement | null } {
  if (!stats) return { views, mine: null };
  const people = views
    .filter((v) => !v.isLocal)
    .map((v) => ({ id: v.identity, name: v.name, server: v.quality, inbound: stats.inbound[v.identity] ?? null }));
  const judged = judgeNet({ me: stats.me, people });
  return {
    views: views.map((v) => ({ ...v, net: v.isLocal ? judged.me : (judged.people[v.identity] ?? null) })),
    mine: judged.me,
  };
}
