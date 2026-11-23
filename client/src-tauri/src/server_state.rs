//! What the UI shows about a server, built from the journal we checked ourselves plus the
//! server's live state (signed profiles verified here, presence, who sits where, mutes).

use std::collections::HashMap;

use hv_roster::perms::{ChannelAccess, ChannelOverride};
use hv_roster::request::SignedProfile;
use hv_roster::{Body, MediaRef, Permission, Permissions, PublicKey, RoleDef, RoleId, Roster, ServerProfile, ServerSettings, UserId};
use serde::{Deserialize, Serialize};

use crate::chat::People;
use crate::identity::fingerprint;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MuteView {
    pub by: String,
    pub at: u64,
    pub until: Option<u64>,
    pub reason: String,
}

/// `/api/state` as the server sends it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RemoteState {
    #[serde(default)]
    pub occupancy: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub mutes: HashMap<String, MuteView>,
    #[serde(default)]
    pub server_time: u64,
    /// The server's address in the P2P tunnel.
    #[serde(default)]
    pub tunnel: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberView {
    pub user_id: String,
    pub nickname: String,
    pub color: String,
    /// The frame around their avatar, as their profile says.
    pub frame: Option<String>,
    /// Their 3D character's code, as their profile says.
    pub character: Option<String>,
    pub fingerprint: String,
    /// Another member uses the same nickname: the UI shows the fingerprint.
    pub name_clash: bool,
    pub roles: Vec<RoleId>,
    pub rank: u32,
    pub is_owner: bool,
    pub top_role_color: Option<String>,
    pub activity: Option<String>,
    pub muted: Option<MuteView>,
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelView {
    pub id: String,
    pub name: String,
    pub user_limit: u32,
    pub people: Vec<String>,
    pub access: ChannelAccess,
    /// Per-role overrides, kept so editing the channel does not drop them.
    pub overrides: Vec<ChannelOverride>,
    pub kind: hv_roster::ChannelKind,
    /// Some role may not see it: no chat in it yet (its own group comes later).
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeView {
    pub user_id: String,
    pub is_owner: bool,
    pub permissions: Permissions,
    pub rank: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BanView {
    pub user_id: String,
    pub nickname: Option<String>,
    pub by: String,
    pub at: u64,
    pub until: Option<u64>,
    pub reason: String,
    pub media: Option<MediaRef>,
}

/// A live (not revoked) invite; its secret is never kept, only its public key.
#[derive(Debug, Clone, Serialize)]
pub struct InviteView {
    pub key: String,
    pub roles: Vec<RoleId>,
    pub max_uses: Option<u32>,
    pub uses: u32,
    pub expires_at: Option<u64>,
    pub by: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStateView {
    pub address: String,
    pub server_key: String,
    pub profile: ServerProfile,
    pub settings: ServerSettings,
    pub roles: Vec<RoleDef>,
    pub members: Vec<MemberView>,
    pub channels: Vec<ChannelView>,
    pub me: MeView,
    pub bans: Vec<BanView>,
    pub invites: Vec<InviteView>,
    pub server_time: u64,
    pub tunnel: Option<String>,
}

const NO_NICKNAME: &str = "Без ника";

/// Nicknames that look alike count as the same: case, spaces, invisible characters and Latin
/// letters that look Cyrillic (Пeтя with a Latin e) are ignored, so a lookalike still shows the
/// fingerprint.
fn comparable(nickname: &str) -> String {
    nickname.to_lowercase().chars().filter(|c| !invisible(*c)).map(skeleton).collect()
}

fn invisible(c: char) -> bool {
    c.is_whitespace()
        || matches!(c, '\u{00ad}' | '\u{034f}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{feff}')
}

/// The Cyrillic letter a Latin one (or a digit) passes for.
fn skeleton(c: char) -> char {
    match c {
        'a' => 'а',
        'b' => 'в',
        'c' => 'с',
        'e' | 'ё' => 'е',
        'h' => 'н',
        'i' => 'і',
        'k' => 'к',
        'm' => 'м',
        'o' | '0' => 'о',
        'p' => 'р',
        't' => 'т',
        'x' => 'х',
        'y' => 'у',
        other => other,
    }
}

/// The view of the server: the journal, what the server says is live, and who is who from its group (`people`).
pub fn build_view(roster: &Roster, remote: &RemoteState, me: &UserId, address: &str, server_key: &PublicKey, people: &People) -> ServerStateView {
    // Only profiles signed by the member themselves, for this server, count.
    let profiles: HashMap<UserId, &SignedProfile> = people
        .profiles
        .values()
        .filter(|p| p.verify(server_key))
        .map(|p| (p.user.user_id(), p))
        .collect();
    let owner = roster.owner().map(|o| o.user_id());
    let role_index = |id: &RoleId| roster.roles().iter().position(|r| &r.id == id);

    let mut members: Vec<MemberView> = roster
        .members()
        .map(|(user, member)| {
            let profile = profiles.get(user).filter(|p| p.user == member.key);
            let top_role_color = member
                .roles
                .iter()
                .filter_map(|r| role_index(r).map(|i| (i, &roster.roles()[i])))
                .filter(|(_, r)| r.color.is_some())
                .max_by_key(|(i, _)| *i)
                .and_then(|(_, r)| r.color.clone());
            MemberView {
                user_id: user.0.clone(),
                nickname: profile.map(|p| p.nickname.clone()).unwrap_or_else(|| NO_NICKNAME.into()),
                color: profile.map(|p| p.color.clone()).unwrap_or_else(|| "blue".into()),
                frame: profile.and_then(|p| p.frame.clone()),
                character: profile.and_then(|p| p.character.clone()),
                fingerprint: fingerprint(&member.key),
                name_clash: false,
                roles: member.roles.clone(),
                rank: roster.rank_of(user),
                is_owner: owner.as_ref() == Some(user),
                top_role_color,
                activity: people.playing.get(user).cloned(),
                muted: remote.mutes.get(&user.0).cloned(),
                channel: remote.occupancy.iter().find(|(_, people)| people.contains(&user.0)).map(|(c, _)| c.clone()),
            }
        })
        .collect();
    // Nameless members are shown with their fingerprint anyway; only real nicknames clash.
    let named = |m: &MemberView| profiles.contains_key(&UserId(m.user_id.clone()));
    let mut counts: HashMap<String, usize> = HashMap::new();
    for m in members.iter().filter(|m| named(m)) {
        *counts.entry(comparable(&m.nickname)).or_default() += 1;
    }
    for m in &mut members {
        m.name_clash = counts.get(&comparable(&m.nickname)).is_some_and(|n| *n > 1) && profiles.contains_key(&UserId(m.user_id.clone()));
    }
    members.sort_by(|a, b| b.rank.cmp(&a.rank).then_with(|| a.nickname.to_lowercase().cmp(&b.nickname.to_lowercase())));

    let manages_channels = roster.permissions_of(me).has(Permission::ManageChannels);
    let channels = roster
        .channels()
        .iter()
        .filter_map(|c| {
            // A channel manager sees channels hidden from them too, or one hidden by mistake
            // could only be fixed by the owner; who sits there stays hidden.
            let access = roster.access(me, &c.id).filter(|a| a.view || manages_channels)?;
            Some(ChannelView {
                id: c.id.clone(),
                name: c.name.clone(),
                user_limit: c.user_limit,
                people: if access.view { remote.occupancy.get(&c.id).cloned().unwrap_or_default() } else { Vec::new() },
                access,
                overrides: c.overrides.clone(),
                kind: c.kind,
                closed: c.is_closed(),
            })
        })
        .collect();

    let permissions = roster.permissions_of(me);
    let bans = if permissions.has(Permission::BanMembers) {
        roster
            .bans()
            .map(|(user, ban)| BanView {
                user_id: user.0.clone(),
                nickname: profiles.get(user).map(|p| p.nickname.clone()),
                by: ban.by.0.clone(),
                at: ban.at,
                until: ban.until,
                reason: ban.reason.clone(),
                media: ban.media.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };

    let invites = if permissions.has(Permission::CreateInvites) {
        roster
            .entries()
            .iter()
            .filter_map(|entry| match &entry.body {
                Body::InviteCreate { invite, .. } => {
                    let state = roster.invite(invite).filter(|i| !i.revoked)?;
                    Some(InviteView {
                        key: hv_roster::keys::encode_b64(&invite.0),
                        roles: state.roles.clone(),
                        max_uses: state.max_uses,
                        uses: state.uses,
                        expires_at: state.expires_at,
                        by: entry.author.user_id().0,
                        at: entry.at,
                    })
                }
                _ => None,
            })
            .collect()
    } else {
        Vec::new()
    };

    ServerStateView {
        address: address.into(),
        server_key: hv_roster::keys::encode_b64(&server_key.0),
        profile: roster.profile().clone(),
        settings: roster.settings().clone(),
        roles: roster.roles().to_vec(),
        members,
        channels,
        me: MeView { user_id: me.0.clone(), is_owner: owner.as_ref() == Some(me), permissions, rank: roster.rank_of(me) },
        bans,
        invites,
        server_time: remote.server_time,
        tunnel: remote.tunnel.clone(),
    }
}

#[cfg(test)]
mod tests {
    use hv_roster::perms::{ChannelDef, ChannelOverride, Permission, Tri};
    use hv_roster::request::sign_profile;
    use hv_roster::{Body, Identity, RoleDef, RoleId, Roster, sign_entry, sign_genesis, sign_join};

    use super::*;

    const T0: u64 = 1_800_000_000;

    fn id(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn server() -> Identity {
        id(100)
    }

    /// Owner 1, admin 2, members 3 and 4; channels general and a hidden staff.
    fn roster() -> Roster {
        let mut r = Roster::new();
        r.apply(sign_genesis(&id(1), &server(), "Хата", T0)).unwrap();
        let act = |r: &mut Roster, body| {
            let entry = sign_entry(r, &id(1), T0, body);
            r.apply(entry).unwrap();
        };
        act(&mut r, Body::ChannelCreate(ChannelDef { id: "general".into(), name: "Общий".into(), user_limit: 8, overrides: vec![], kind: Default::default() }));
        let hidden = ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit };
        act(&mut r, Body::ChannelCreate(ChannelDef { id: "staff".into(), name: "Админская".into(), user_limit: 0, overrides: vec![hidden], kind: Default::default() }));
        let dj = RoleDef { id: RoleId::parse("dj").unwrap(), name: "Диджей".into(), color: Some("#ff8800".into()), permissions: Default::default() };
        act(&mut r, Body::RoleCreate(dj));
        let mut admin = r.roles().iter().find(|x| x.id.0 == "admin").unwrap().clone();
        admin.color = Some("#e5484d".into());
        act(&mut r, Body::RoleUpdate(admin));
        for (n, roles) in [(2u8, vec!["admin", "dj"]), (3, vec!["dj"]), (4, vec![])] {
            let invite = Identity::generate().unwrap();
            let roles = roles.into_iter().map(|x| RoleId::parse(x).unwrap()).collect();
            act(&mut r, Body::InviteCreate { invite: invite.public(), roles, max_uses: None, expires_at: None });
            let join = sign_join(&r, &id(n), &invite, T0);
            r.apply(join).unwrap();
        }
        let ban = Body::Ban { user: id(9).public().user_id(), until: None, reason: "Спам".into(), media: None };
        act(&mut r, ban);
        r
    }

    fn people(nicknames: &[(u8, &str)]) -> People {
        let profiles = nicknames.iter().map(|(n, nick)| (id(*n).public().user_id(), sign_profile(&id(*n), &server().public(), nick, "pink", T0)));
        People { profiles: profiles.collect(), playing: [(id(3).public().user_id(), "CS2".to_string())].into() }
    }

    fn remote() -> RemoteState {
        RemoteState {
            occupancy: [("general".to_string(), vec![id(3).public().user_id().0]), ("staff".into(), vec![id(1).public().user_id().0])].into(),
            mutes: Default::default(),
            server_time: T0 + 5,
            tunnel: None,
        }
    }

    fn view_for(n: u8, nicknames: &[(u8, &str)]) -> ServerStateView {
        build_view(&roster(), &remote(), &id(n).public().user_id(), "1.2.3.4:7350", &server().public(), &people(nicknames))
    }

    fn member<'a>(view: &'a ServerStateView, n: u8) -> &'a MemberView {
        let user = id(n).public().user_id().0;
        view.members.iter().find(|m| m.user_id == user).unwrap()
    }

    #[test]
    fn view_hides_invisible_channels_and_bans_without_the_right() {
        let member_view = view_for(4, &[]);
        let channels: Vec<&str> = member_view.channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(channels, ["general"]);
        assert!(member_view.bans.is_empty(), "no ban_members right");
        assert!(!member_view.me.permissions.has(Permission::BanMembers));

        let owner_view = view_for(1, &[]);
        assert_eq!(owner_view.channels.len(), 2);
        assert_eq!(owner_view.channels[1].people, vec![id(1).public().user_id().0]);
        assert_eq!(owner_view.bans.len(), 1);
        assert_eq!(owner_view.bans[0].reason, "Спам");
        assert!(owner_view.me.is_owner);
        assert_eq!(owner_view.channels[0].user_limit, 8);
        assert_eq!((owner_view.channels[0].kind, owner_view.channels[0].closed), (hv_roster::ChannelKind::Voice, false));
        assert!(owner_view.channels[1].closed, "a role may not see the staff channel");
    }

    #[test]
    fn invites_with_uses_are_listed_only_for_those_who_may_invite() {
        let owner_view = view_for(1, &[]);
        assert_eq!(owner_view.invites.len(), 3);
        assert!(owner_view.invites.iter().all(|i| i.uses == 1 && i.max_uses.is_none()));
        assert_eq!(owner_view.invites[0].by, id(1).public().user_id().0);
        assert_eq!(owner_view.invites[2].roles, Vec::<RoleId>::new());
        assert!(view_for(4, &[]).invites.is_empty(), "no create_invites right");
    }

    #[test]
    fn channels_carry_their_overrides_so_an_edit_keeps_them() {
        let view = view_for(1, &[]);
        assert!(view.channels[0].overrides.is_empty());
        assert_eq!(view.channels[1].overrides[0].view, Tri::Deny);
    }

    #[test]
    fn members_carry_nickname_roles_activity_and_place() {
        let view = view_for(1, &[(3, "Петя")]);
        let petya = member(&view, 3);
        assert_eq!(petya.nickname, "Петя");
        assert_eq!(petya.color, "pink");
        assert_eq!(petya.activity.as_deref(), Some("CS2"));
        assert_eq!(petya.channel.as_deref(), Some("general"));
        assert_eq!(petya.roles, vec![RoleId::parse("dj").unwrap()]);
        let nameless = member(&view, 4);
        assert_eq!(nameless.nickname, "Без ника");
        assert!(member(&view, 1).is_owner);
        assert!(member(&view, 2).rank > member(&view, 3).rank);
    }

    #[test]
    fn same_nicknames_get_fingerprints() {
        let view = view_for(1, &[(3, "Петя"), (4, "петя ")]);
        assert!(member(&view, 3).name_clash && member(&view, 4).name_clash, "case and spaces don't hide a clash");
        assert!(!member(&view, 2).name_clash);
        assert_eq!(member(&view, 3).fingerprint.len(), 4);
    }

    #[test]
    fn lookalike_letters_and_invisible_characters_do_not_hide_a_clash() {
        // A Latin e in the second, a zero-width space in the third.
        let view = view_for(1, &[(2, "Петя"), (3, "Пeтя"), (4, "Пе\u{200b}тя")]);
        assert!([2, 3, 4].iter().all(|n| member(&view, *n).name_clash), "Пeтя with a Latin e is still Петя");
        let view = view_for(1, &[(2, "Box"), (3, "Вох")]);
        assert!(member(&view, 2).name_clash && member(&view, 3).name_clash, "Cyrillic Вох looks like Box");
    }

    #[test]
    fn channel_managers_see_channels_hidden_from_them_so_they_can_fix_them() {
        let admin_view = view_for(2, &[]);
        let staff = admin_view.channels.iter().find(|c| c.id == "staff").expect("a channel manager sees the hidden channel");
        assert!(!staff.access.view && !staff.access.connect, "still not theirs to enter");
        assert!(staff.people.is_empty(), "who sits there stays hidden");
        assert!(view_for(4, &[]).channels.iter().all(|c| c.id != "staff"));
    }

    #[test]
    fn top_role_color_is_the_highest_colored_role() {
        let view = view_for(1, &[]);
        assert_eq!(member(&view, 2).top_role_color.as_deref(), Some("#e5484d"), "admin is above dj");
        assert_eq!(member(&view, 3).top_role_color.as_deref(), Some("#ff8800"));
        assert_eq!(member(&view, 4).top_role_color, None);
    }

    #[test]
    fn profiles_signed_for_another_server_are_ignored() {
        let mut people = people(&[]);
        people.profiles.insert(id(3).public().user_id(), sign_profile(&id(3), &id(55).public(), "Самозванец", "blue", T0));
        let view = build_view(&roster(), &remote(), &id(1).public().user_id(), "a", &server().public(), &people);
        assert_eq!(member(&view, 3).nickname, "Без ника");
    }
}
