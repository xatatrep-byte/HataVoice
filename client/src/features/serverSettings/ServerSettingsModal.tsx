import { useState } from "react";
import { hasPermission, postEntry, serverErrorText, type Body, type MeView, type Permission, type ServerStateView } from "../../server/session";
import { Modal } from "../../ui/Modal";
import { notify } from "../../ui/toasts";
import { useHostedAddress } from "../host/deleteServer";
import { AuditTab } from "./AuditTab";
import { ConnectionTab } from "./ConnectionTab";
import { ChannelsTab } from "./ChannelsTab";
import { EncryptionTab } from "./EncryptionTab";
import { InvitesTab } from "./InvitesTab";
import { LimitsTab } from "./LimitsTab";
import { MembersTab } from "./MembersTab";
import { ProfileTab } from "./ProfileTab";
import { RolesTab } from "./RolesTab";
import "./serverSettings.css";

export type Tab = "profile" | "connection" | "roles" | "members" | "channels" | "invites" | "audit" | "limits" | "encryption";

/**
 * Spec 7.1: each tab and the right it needs; «Участники» is for everyone, «Шифрование» for the owner alone,
 * «Подключение» for the owner on the PC the server runs on (it changes that PC's server, not the journal).
 */
const TABS: { id: Tab; label: string; right: Permission | "owner" | "host" | null }[] = [
  { id: "profile", label: "Профиль", right: "manage_server" },
  { id: "connection", label: "Подключение", right: "host" },
  { id: "roles", label: "Роли", right: "manage_roles" },
  { id: "members", label: "Участники", right: null },
  { id: "channels", label: "Комнаты", right: "manage_channels" },
  { id: "invites", label: "Приглашения", right: "create_invites" },
  { id: "audit", label: "Журнал", right: "view_audit_log" },
  { id: "limits", label: "Ограничения", right: "manage_server" },
  { id: "encryption", label: "Шифрование", right: "owner" },
];

export function visibleTabs(me: MeView, hostedHere = false): Tab[] {
  const allowed = (right: Permission | "owner" | "host" | null) =>
    right === null || (right === "owner" ? me.is_owner : right === "host" ? me.is_owner && hostedHere : hasPermission(me, right));
  return TABS.filter((t) => allowed(t.right)).map((t) => t.id);
}

/** What every tab gets: the server, its state and a way to write journal entries. */
export type TabProps = {
  address: string;
  state: ServerStateView;
  clockOffset: number;
  /** Writes an entry; errors are shown and rethrown so a form can stay open. */
  post: (body: Body) => Promise<void>;
};

type Props = {
  open: boolean;
  address: string;
  state: ServerStateView;
  clockOffset: number;
  onClose: () => void;
  /** Opens the person menu (moderation) from the members tab. */
  onPerson?: (userId: string) => void;
};

export function ServerSettingsModal({ open, address, state, clockOffset, onClose, onPerson }: Props) {
  const hostedHere = useHostedAddress(address) === address;
  const tabs = visibleTabs(state.me, hostedHere);
  const [wanted, setWanted] = useState<Tab>("members");
  const tab = tabs.includes(wanted) ? wanted : "members";

  async function post(body: Body) {
    try {
      await postEntry(address, body);
    } catch (e) {
      notify.error(serverErrorText(e));
      throw e;
    }
  }

  const props: TabProps = { address, state, clockOffset, post };
  return (
    <Modal open={open} onClose={onClose} title={`Настройки сервера «${state.profile.name}»`} wide>
      <div className="server-settings">
        <div className="tabs" role="tablist">
          {TABS.filter((t) => tabs.includes(t.id)).map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setWanted(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="server-settings-body">
          {tab === "profile" && <ProfileTab {...props} />}
          {tab === "connection" && <ConnectionTab name={state.profile.name} address={address} onDeleted={onClose} />}
          {tab === "roles" && <RolesTab {...props} />}
          {tab === "members" && <MembersTab {...props} onPerson={onPerson} />}
          {tab === "channels" && <ChannelsTab {...props} />}
          {tab === "invites" && <InvitesTab {...props} />}
          {tab === "audit" && <AuditTab {...props} />}
          {tab === "limits" && <LimitsTab {...props} />}
          {tab === "encryption" && <EncryptionTab {...props} />}
        </div>
      </div>
    </Modal>
  );
}
