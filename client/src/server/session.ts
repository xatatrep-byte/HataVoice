import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePrefs } from "../state/prefs";

// Mirrors of the Rust types (client/src-tauri/src/server_state.rs and hv-roster). Every call
// goes through the Rust side: it holds the key, signs requests and checks the journal.

export type Permission =
  | "manage_server"
  | "manage_roles"
  | "manage_channels"
  | "create_invites"
  | "view_audit_log"
  | "mute_members"
  | "move_members"
  | "kick_members"
  | "ban_members"
  | "connect"
  | "speak"
  | "stream";

export type Tri = "inherit" | "allow" | "deny";
export type RoleDef = { id: string; name: string; color: string | null; permissions: Permission[] };
export type ChannelOverride = { role: string; view: Tri; connect: Tri; speak: Tri };
/** `text` — a channel for the chat only; every channel has a chat, a voice one has calls too. */
export type ChannelKind = "voice" | "text";
export type ChannelDef = { id: string; name: string; user_limit: number; overrides: ChannelOverride[]; kind?: ChannelKind };
export type ChannelAccess = { view: boolean; connect: boolean; speak: boolean };
export type MediaRef = { sha256: string; mime: string; size: number };
export type ServerProfile = { name: string; description: string; welcome: string; icon: MediaRef | null };
/** `history_days`: how many days of the chat a newcomer is given (0, 7, 30 or 90). */
export type ServerSettings = { afk_channel: string | null; afk_minutes: number; history_days: number };
export type MuteView = { by: string; at: number; until: number | null; reason: string };

export type MemberView = {
  user_id: string;
  nickname: string;
  color: string;
  /** The frame around their avatar, as their profile says. */
  frame?: string | null;
  /** Their 3D character's code, as their profile says. */
  character?: string | null;
  fingerprint: string;
  /** Someone else has the same nickname: show the fingerprint next to it. */
  name_clash: boolean;
  roles: string[];
  rank: number;
  is_owner: boolean;
  top_role_color: string | null;
  activity: string | null;
  muted: MuteView | null;
  channel: string | null;
};

export type ChannelView = {
  id: string;
  name: string;
  user_limit: number;
  /** User ids of the people inside. */
  people: string[];
  access: ChannelAccess;
  overrides: ChannelOverride[];
  kind: ChannelKind;
  /** Some role may not see it: no chat in it yet. */
  closed: boolean;
};

export type MeView = { user_id: string; is_owner: boolean; permissions: Permission[]; rank: number };

export type BanView = {
  user_id: string;
  nickname: string | null;
  by: string;
  at: number;
  until: number | null;
  reason: string;
  media: MediaRef | null;
};

/** A live invite; its secret is never kept, so a link can only be shown when it is made. */
export type InviteView = {
  key: string;
  roles: string[];
  max_uses: number | null;
  uses: number;
  expires_at: number | null;
  by: string;
  at: number;
};

export type ServerStateView = {
  address: string;
  server_key: string;
  profile: ServerProfile;
  settings: ServerSettings;
  roles: RoleDef[];
  members: MemberView[];
  channels: ChannelView[];
  me: MeView;
  bans: BanView[];
  invites: InviteView[];
  server_time: number;
  /** The server's address in the P2P tunnel, when it answers there. */
  tunnel?: string | null;
};

/** A journal entry body, tagged like `hv_roster::Body`. */
export type Body =
  | ({ type: "role_create" } & RoleDef)
  | ({ type: "role_update" } & RoleDef)
  | { type: "role_delete"; id: string }
  | { type: "role_order"; ids: string[] }
  | { type: "member_roles"; user: string; roles: string[] }
  | { type: "invite_revoke"; invite: string }
  | { type: "leave" }
  | { type: "kick"; user: string; reason: string; media: MediaRef | null }
  | { type: "ban"; user: string; until: number | null; reason: string; media: MediaRef | null }
  | { type: "unban"; user: string }
  | { type: "owner_transfer"; to: string }
  | ({ type: "server_profile" } & ServerProfile)
  | ({ type: "server_settings" } & ServerSettings)
  | ({ type: "channel_create" } & ChannelDef)
  | ({ type: "channel_update" } & ChannelDef)
  | { type: "channel_delete"; id: string }
  | { type: "channel_order"; ids: string[] };

/** A moderation command, tagged like the server's `moderation::Command`. */
export type Command =
  | { action: "mute"; user: string; minutes: number | null; reason: string }
  | { action: "unmute"; user: string }
  | { action: "move"; user: string; channel: string }
  | { action: "disconnect"; user: string };

/** An event from a server's live stream (`resync` after a reconnect). */
export type ServerEvent = { type: string } & Record<string, unknown>;

export type InvitePreview = {
  address: string;
  server_name: string;
  description: string;
  welcome: string;
  icon: MediaRef | null;
  inviter_name: string | null;
  inviter_fingerprint: string;
  valid: boolean;
};

export type Opened = { serverKey: string; name: string };

/** Texts of the Rust side's errors that the UI acts on. */
export const SERVER_TEXT = {
  unreachable: "Сервер недоступен",
  unclaimed: "Сервер ещё не настроен владельцем",
  joinNeeded: "Ты не участник этого сервера. Попроси ссылку у владельца",
  ownedByOther: "Владелец этого сервера другая личность. Загрузи свою копию (.hvid)",
} as const;

/** "http://1.2.3.4:7350/" → "1.2.3.4:7350": servers are saved as host:port. */
export function normalizeAddress(text: string): string {
  return text.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function serverErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Что-то пошло не так";
}

export const isUnreachable = (e: unknown) => serverErrorText(e).startsWith(SERVER_TEXT.unreachable);

/** How a tunnel to a server is doing; null when it is reached by its own address. */
export type TunnelState = { connected: boolean; direct: boolean; rtt_ms: number | null };

export function tunnelState(address: string): Promise<TunnelState | null> {
  return invoke<TunnelState | null>("p2p_state", { address });
}

/** From now on the server's traffic goes through `tunnel`, until the program closes. */
export function routeThroughTunnel(address: string, tunnel: string): Promise<boolean> {
  return invoke<boolean>("server_use_tunnel", { address, tunnel });
}

export function isInviteLink(text: string): boolean {
  return text.trim().toLowerCase().startsWith("hatavoice://");
}

type OpenedRaw = { address: string; server_key: string; name: string };

/** Our nickname and color, if there is a nickname to sign. */
function profile(): { nickname: string; color: string; frame: string | null; character: string | null } | null {
  const { nickname, color, frame, character } = usePrefs.getState();
  return nickname.trim() ? { nickname: nickname.trim(), color, frame, character } : null;
}

export async function openServer(address: string, serverKey?: string): Promise<Opened> {
  const opened = await invoke<OpenedRaw>("server_open", { address, serverKey: serverKey ?? null, profile: profile() });
  return { serverKey: opened.server_key, name: opened.name };
}

export async function joinByInvite(link: string): Promise<{ address: string; serverKey: string; name: string }> {
  const opened = await invoke<OpenedRaw>("server_join", { link: link.trim(), profile: profile() });
  return { address: opened.address, serverKey: opened.server_key, name: opened.name };
}

export function previewInvite(link: string): Promise<InvitePreview> {
  return invoke<InvitePreview>("invite_preview", { link: link.trim() });
}

type Claimed = { address: string; server_key: string; backup_suggested: boolean };

/**
 * Makes this PC's identity the owner of the server hosted here; without `channels` the server's
 * channels from before the journal are kept.
 */
export async function claimHost(serverName: string, channels: { id: string; name: string }[] | null) {
  const claimed = await invoke<Claimed>("host_claim", { serverName, channels });
  const mine = profile();
  if (mine) await invoke("profile_set", mine);
  return { address: claimed.address, serverKey: claimed.server_key, backupSuggested: claimed.backup_suggested };
}

type HostView = { config: { name: string; api_port: number } | null };

/**
 * Opens a saved server. Our own server that has no owner yet (made by an older version) is
 * claimed on the spot, keeping its channels.
 */
export async function connectServer(address: string, serverKey?: string): Promise<Opened & { backupSuggested: boolean }> {
  try {
    return { ...(await openServer(address, serverKey)), backupSuggested: false };
  } catch (e) {
    const text = serverErrorText(e);
    if (text !== SERVER_TEXT.unclaimed && text !== SERVER_TEXT.joinNeeded) throw e;
    const config = (await invoke<HostView | null>("host_view").catch(() => null))?.config;
    if (!config || address !== `127.0.0.1:${config.api_port}`) throw e;
    // Not a member of the server on this very PC: its owner is an identity this PC no longer has.
    if (text === SERVER_TEXT.joinNeeded) throw SERVER_TEXT.ownedByOther;
    const claimed = await claimHost(config.name, null);
    return { serverKey: claimed.serverKey, name: config.name, backupSuggested: claimed.backupSuggested };
  }
}

export function serverState(address: string): Promise<ServerStateView> {
  return invoke<ServerStateView>("server_state", { address });
}

export function onServerEvent(handler: (address: string, event: ServerEvent) => void): Promise<() => void> {
  return listen<{ address: string; event: ServerEvent }>("server-event", ({ payload }) =>
    handler(payload.address, payload.event),
  );
}

/**
 * A LiveKit pass for `channel`; the server decides our identity, name and rights. `url` is the
 * Rust side's local bridge to the server's LiveKit: connect to it as is.
 */
export function voiceToken(address: string, channel: string): Promise<{ url: string; token: string }> {
  return invoke<{ url: string; token: string }>("voice_token", { address, channel });
}

/** One sender's frame key for the call's current epoch; `key` is base64url (no padding), 32 bytes. */
export type CallKey = { identity: string; index: number; key: string };
export type CallKeysEvent = { address: string; channel: string; epoch: number; keys: CallKey[] };
export type CallLockState = "pending" | "secure" | "failed";
/** `members`: identities of the people inside the encryption, by leaf. */
export type CallStateEvent = {
  address: string;
  channel: string;
  state: CallLockState;
  code: string | null;
  members: string[];
  error: string | null;
};

/** Joins (or starts) the encrypted call of `channel`; keys and the lock state arrive as events. */
export function callJoin(address: string, channel: string): Promise<void> {
  return invoke("call_join", { address, channel });
}

/** Who LiveKit says is in the room: the call adds and removes people to match. */
export function callPresence(address: string, channel: string, identities: string[]): Promise<void> {
  return invoke("call_presence", { address, channel, identities });
}

export function callLeave(): Promise<void> {
  return invoke("call_leave");
}

export function onCallKeys(handler: (event: CallKeysEvent) => void): Promise<() => void> {
  return listen<CallKeysEvent>("call-keys", ({ payload }) => handler(payload));
}

export function onCallState(handler: (event: CallStateEvent) => void): Promise<() => void> {
  return listen<CallStateEvent>("call-state", ({ payload }) => handler(payload));
}

export async function postEntry(address: string, body: Body): Promise<number> {
  return (await invoke<{ seq: number }>("server_post", { address, body })).seq;
}

export function setProfile(nickname: string, color: string, frame: string | null, character: string | null): Promise<void> {
  return invoke("profile_set", { nickname, color, frame, character });
}

/** `lost_previous`: the old identity file could not be decrypted and a new identity started. */
export type IdentityInfo = { user_id: string; fingerprint: string; lost_previous: boolean };

export function identityInfo(): Promise<IdentityInfo> {
  return invoke<IdentityInfo>("identity_info");
}

/**
 * Where the window gets a server's uploaded file: the Rust side serves it through the `hvmedia`
 * scheme (pinned TLS to the server). The scheme sets no CORS headers, so use the URL only as an
 * `<img>`/`<video>` source, never with `fetch`.
 */
export function mediaUrl(address: string, media: MediaRef): string {
  return convertFileSrc(`${address.trim()}/${media.sha256}`, "hvmedia");
}

/** The owner may do everything; anyone else needs the right through a role. */
export function hasPermission(me: MeView, permission: Permission): boolean {
  return me.is_owner || me.permissions.includes(permission);
}

/** «Петя», or «Петя · k7q3» when someone else is also called Петя. */
export function displayName(member: MemberView): string {
  return member.name_clash ? `${member.nickname} · ${member.fingerprint}` : member.nickname;
}

/** Mute, unmute, move or disconnect someone; the server checks rights and enforces it. */
export function moderate(address: string, command: Command): Promise<unknown> {
  return invoke("moderate", { address, command });
}

/** Uploads a GIF/clip for a kick or ban, or the server icon (`token` of a file the person picked); the type is checked. */
export function uploadMedia(address: string, token: string, purpose: "moderation" | "icon"): Promise<MediaRef> {
  return invoke<MediaRef>("media_upload", { address, token, purpose });
}

/** One of «Мои гифки» (kept by Rust, see picked.rs), uploaded to `address` for a kick or ban. */
export function uploadMyGif(address: string, id: string): Promise<MediaRef> {
  return invoke<MediaRef>("my_gif_upload", { address, id });
}

/** A new invite link; `shareAddress` is how friends reach this server. */
export async function createInvite(
  address: string,
  invite: { shareAddress: string; roles: string[]; maxUses: number | null; expiresMinutes: number | null },
): Promise<string> {
  return (await invoke<{ link: string }>("invite_create", { address, ...invite })).link;
}

/** One line of the action log: a journal entry or a signed moderation command. */
/** `verified`: checked by this client against the journal or the command's own signature. */
export type AuditEntry = {
  at: number;
  actor: string;
  kind: string;
  target: string | null;
  detail: Record<string, unknown>;
  verified: boolean;
};

export function auditLog(address: string, filter: { user: string | null; kind: string | null; before: number | null }): Promise<AuditEntry[]> {
  return invoke<AuditEntry[]>("audit", { address, ...filter });
}
