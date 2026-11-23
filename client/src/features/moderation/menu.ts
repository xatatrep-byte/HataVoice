import type { MeView, MemberView, Permission } from "../../server/session";
import { hasPermission } from "../../server/session";

export type MenuAction = "mute" | "unmute" | "move" | "disconnect" | "kick" | "ban";
export type MenuItem = { id: MenuAction; label: string; disabled: boolean; hint?: string };

const LABELS: Record<MenuAction, string> = {
  mute: "Заглушить для всех",
  unmute: "Снять мут",
  move: "Перенести в комнату…",
  disconnect: "Выгнать из комнаты",
  kick: "Кикнуть с сервера",
  ban: "Забанить",
};

const RIGHTS: Record<MenuAction, Permission> = {
  mute: "mute_members",
  unmute: "mute_members",
  move: "move_members",
  disconnect: "move_members",
  kick: "kick_members",
  ban: "ban_members",
};

export const RANK_HINT = "Его роль не ниже твоей";

/** The owner outranks everyone; anyone else only people whose highest role is lower. */
export function outranks(me: MeView, target: MemberView): boolean {
  if (target.is_owner) return false;
  return me.is_owner || me.rank > target.rank;
}

/**
 * What `me` may do to `target`: only actions their rights allow, greyed out with a reason when
 * the hierarchy forbids them. Nothing for yourself.
 */
export function menuItems(me: MeView, target: MemberView): MenuItem[] {
  if (me.user_id === target.user_id) return [];
  const wanted: MenuAction[] = [target.muted ? "unmute" : "mute"];
  if (target.channel) wanted.push("move", "disconnect");
  wanted.push("kick", "ban");
  const allowed = outranks(me, target);
  return wanted
    .filter((id) => hasPermission(me, RIGHTS[id]))
    .map((id) => (allowed ? { id, label: LABELS[id], disabled: false } : { id, label: LABELS[id], disabled: true, hint: RANK_HINT }));
}
