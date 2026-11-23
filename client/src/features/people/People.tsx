import { useState } from "react";
import { Crown, Search } from "lucide-react";
import { displayName, type MemberView, type ServerStateView } from "../../server/session";
import { portraitFor } from "../../characters/members";
import { Avatar } from "../../ui/Avatar";
import "./people.css";

type Group = { key: string; title: string; members: MemberView[] };

/**
 * Owner first, then each role from the highest down (by a member's highest role), then everyone
 * else as «Участники».
 */
export function groupMembers(state: ServerStateView, members: MemberView[]): Group[] {
  const order = state.roles.map((r) => r.id);
  const topRole = (m: MemberView) =>
    m.roles.reduce<string | null>((best, id) => (best === null || order.indexOf(id) > order.indexOf(best) ? id : best), null);
  const groups: Group[] = [{ key: "owner", title: "Владелец", members: members.filter((m) => m.is_owner) }];
  for (const role of [...state.roles].reverse()) {
    if (role.id === "everyone") continue;
    groups.push({ key: role.id, title: role.name, members: members.filter((m) => !m.is_owner && topRole(m) === role.id) });
  }
  groups.push({ key: "everyone", title: "Участники", members: members.filter((m) => !m.is_owner && topRole(m) === null) });
  return groups.filter((g) => g.members.length > 0);
}

function status(state: ServerStateView, m: MemberView): string | null {
  if (m.activity) return `играет в ${m.activity}`;
  const channel = state.channels.find((c) => c.id === m.channel);
  return channel ? `в «${channel.name}»` : null;
}

/** The panel's «Люди»: everyone in the house by role, found by name; a click opens the person menu (write, mute…). */
export function People({ state, onPerson }: { state: ServerStateView; onPerson: (userId: string) => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const others = state.members.filter((m) => m.user_id !== state.me.user_id);
  const found = needle ? others.filter((m) => m.nickname.toLowerCase().includes(needle) || m.fingerprint.toLowerCase().startsWith(needle)) : others;
  return (
    <div className="people-panel" aria-label="Участники сервера">
      <label className="people-search">
        <Search size={15} aria-hidden />
        <input className="input" value={query} placeholder="Найти по нику" onChange={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <div className="drawer-scroll">
        {groupMembers(state, found).map((g) => (
          <section key={g.key} role="group" aria-label={g.title} className="drawer-section">
            <h3 className="drawer-label">
              {g.title} <span className="people-count">{g.members.length}</span>
            </h3>
            <ul className="drawer-rows">
              {g.members.map((m) => {
                const line = status(state, m);
                return (
                  <li key={m.user_id} className="drawer-row person">
                    <button type="button" className="row-open" onClick={() => onPerson(m.user_id)}>
                      <Avatar name={displayName(m)} color={m.color} size={34} frame={m.frame} picture={portraitFor(m.character, m.user_id)} />
                      <span className="row-name">
                        <span className="person-name" style={m.top_role_color ? { color: m.top_role_color } : undefined} title={displayName(m)}>
                          {m.is_owner && <Crown size={13} aria-label="Владелец" />}
                          {displayName(m)}
                        </span>
                        {line && <small className={m.activity ? "person-status playing" : "person-status"}>{line}</small>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {found.length === 0 && <p className="drawer-empty">{needle ? "Никого не нашлось" : "Кроме тебя на сервере пока никого"}</p>}
      </div>
    </div>
  );
}
