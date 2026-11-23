import type { MeView, MemberView, Permission, ServerStateView } from "../../server/session";

/** In the journal's own order (`hv_roster::Permission`), which is also how rights are saved. */
export const PERMISSIONS: readonly Permission[] = [
  "manage_server",
  "manage_roles",
  "manage_channels",
  "create_invites",
  "view_audit_log",
  "mute_members",
  "move_members",
  "kick_members",
  "ban_members",
  "connect",
  "speak",
  "stream",
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_server: "Управлять сервером",
  manage_roles: "Управлять ролями",
  manage_channels: "Управлять комнатами",
  create_invites: "Приглашать",
  view_audit_log: "Смотреть журнал действий",
  mute_members: "Глушить для всех",
  move_members: "Переносить и выгонять из комнаты",
  kick_members: "Кикать с сервера",
  ban_members: "Банить и разбанивать",
  connect: "Входить в комнаты",
  speak: "Говорить",
  stream: "Камера и показ экрана",
};

/** What the log calls each journal entry and moderation command. */
export const ACTION_LABELS: Record<string, string> = {
  kick: "кик",
  ban: "бан",
  unban: "разбан",
  mute: "мут",
  unmute: "снятие мута",
  move: "перенос",
  disconnect: "выгнал из комнаты",
  join: "вход",
  leave: "ушёл",
  member_roles: "роли участника",
  role_create: "новая роль",
  role_update: "роль изменена",
  role_delete: "роль удалена",
  role_order: "порядок ролей",
  invite_create: "приглашение",
  invite_revoke: "приглашение отозвано",
  owner_transfer: "передача владения",
  server_profile: "профиль сервера",
  server_settings: "ограничения",
  channel_create: "новая комната",
  channel_update: "комната изменена",
  channel_delete: "комната удалена",
  channel_order: "порядок комнат",
  genesis: "сервер создан",
};

/** A role's place: its index, the same scale as `rank` (0 is «@все»). */
export function roleRank(state: ServerStateView, roleId: string): number {
  return state.roles.findIndex((r) => r.id === roleId);
}

/** Roles you may change, hand out or put in overrides: strictly below your highest. */
export function canManageRole(me: MeView, rank: number): boolean {
  return me.is_owner || rank < me.rank;
}

/** A member's name, or the start of their id when they are gone from the server. */
export function nameOf(state: ServerStateView, userId: string | null): string {
  if (!userId) return "";
  const member: MemberView | undefined = state.members.find((m) => m.user_id === userId);
  return member ? member.nickname : userId.slice(0, 4);
}

const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

export const formatDate = (unix: number) => dateFormat.format(new Date(unix * 1000));
