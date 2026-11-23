// Test helpers: a server state as the Rust side would build it.
import type { ChannelView, MemberView, ServerStateView } from "./session";

export function member(user_id: string, nickname: string, extra: Partial<MemberView> = {}): MemberView {
  return {
    user_id,
    nickname,
    color: "blue",
    fingerprint: user_id.slice(0, 4),
    name_clash: false,
    roles: [],
    rank: 0,
    is_owner: false,
    top_role_color: null,
    activity: null,
    muted: null,
    channel: null,
    ...extra,
  };
}

export function channel(id: string, name: string, extra: Partial<ChannelView> = {}): ChannelView {
  return {
    id,
    name,
    user_limit: 0,
    people: [],
    access: { view: true, connect: true, speak: true },
    overrides: [],
    kind: "voice",
    closed: false,
    ...extra,
  };
}

export function serverState(extra: Partial<ServerStateView> = {}): ServerStateView {
  return {
    address: "a:1",
    server_key: "SK",
    profile: { name: "Хата", description: "", welcome: "", icon: null },
    settings: { afk_channel: null, afk_minutes: 0, history_days: 30 },
    roles: [],
    members: [member("me00", "Петя")],
    channels: [channel("general", "Общий")],
    me: { user_id: "me00", is_owner: false, permissions: ["connect", "speak", "stream"], rank: 0 },
    bans: [],
    invites: [],
    server_time: 1_800_000_000,
    ...extra,
  };
}
