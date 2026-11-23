//! Rooms: groups of the chat besides the server's own. A closed channel has one (`ch.<id>`), whose keys only those
//! who may see the channel hold; two people have one for their direct messages (`dm.<a>.<b>`). Each keeps its log,
//! requests and welcomes like the server's group, in `group/rooms/<name>/`. Who may enter is the signed journal's
//! word, asked again at every request.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hv_roster::{Roster, UserId};

use crate::group::{GROUP_DIR, GroupStore};

const ROOMS_DIR: &str = "rooms";

/// A group of the server's chat.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Room {
    /// The server's own group, everyone's.
    Server,
    /// A closed channel's: those who may see it.
    Channel(String),
    /// Two people's direct messages, the smaller id first.
    Dm(UserId, UserId),
}

fn channel_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A user id as the journal writes them: base32, small letters.
fn user_id(id: &str) -> bool {
    (16..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

impl Room {
    /// A room by its name; none (or `srv`) is the server's group. `None` for a name that is no room.
    pub fn parse(name: Option<&str>) -> Option<Room> {
        let name = match name {
            None | Some("") | Some("srv") => return Some(Room::Server),
            Some(name) => name,
        };
        if let Some(id) = name.strip_prefix("ch.") {
            return channel_id(id).then(|| Room::Channel(id.to_string()));
        }
        let (a, b) = name.strip_prefix("dm.")?.split_once('.')?;
        (user_id(a) && user_id(b) && a < b).then(|| Room::Dm(UserId(a.into()), UserId(b.into())))
    }

    /// The room of two people's direct messages, whichever comes first.
    pub fn dm(one: &UserId, other: &UserId) -> Room {
        if one <= other { Room::Dm(one.clone(), other.clone()) } else { Room::Dm(other.clone(), one.clone()) }
    }

    pub fn name(&self) -> String {
        match self {
            Room::Server => "srv".into(),
            Room::Channel(id) => format!("ch.{id}"),
            Room::Dm(a, b) => format!("dm.{}.{}", a.0, b.0),
        }
    }

    /// `None` for the server's group, as events of it have always been.
    pub fn tag(&self) -> Option<String> {
        (*self != Room::Server).then(|| self.name())
    }

    /// The journal lets `user` into this room now: a member, not banned; for a closed channel, one who may see it;
    /// for direct messages, one of the two, both members.
    pub fn may_enter(&self, roster: &Roster, user: &UserId, now: u64) -> bool {
        let member = |u: &UserId| roster.member(u).is_some() && !roster.is_banned_at(u, now);
        if !member(user) {
            return false;
        }
        match self {
            Room::Server => true,
            Room::Channel(id) => {
                roster.channels().iter().any(|c| c.id == *id && c.is_closed()) && roster.access(user, id).is_some_and(|access| access.view)
            }
            Room::Dm(a, b) => a != b && (user == a || user == b) && member(a) && member(b),
        }
    }

    /// The other one of direct messages.
    pub fn peer(&self, me: &UserId) -> Option<&UserId> {
        match self {
            Room::Dm(a, b) if a == me => Some(b),
            Room::Dm(a, b) if b == me => Some(a),
            _ => None,
        }
    }
}

/// Every room's store: the server's own, and the others as they are first used (or found on disk).
pub struct Rooms {
    dir: Option<PathBuf>,
    server: Arc<GroupStore>,
    others: Mutex<HashMap<Room, Arc<GroupStore>>>,
}

impl Rooms {
    /// The rooms under the data folder `data` (none: in memory), with the server's group as it was.
    pub fn open(data: Option<&Path>, server: Arc<GroupStore>) -> Rooms {
        let dir = data.map(|d| d.join(GROUP_DIR).join(ROOMS_DIR));
        let mut others = HashMap::new();
        if let Some(dir) = &dir
            && let Ok(entries) = std::fs::read_dir(dir)
        {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(room) = Room::parse(Some(&name)).filter(|r| *r != Room::Server) {
                    others.insert(room, Arc::new(GroupStore::open_at(Some(entry.path()))));
                }
            }
        }
        Rooms { dir, server, others: Mutex::new(others) }
    }

    pub fn store(&self, room: &Room) -> Arc<GroupStore> {
        if *room == Room::Server {
            return self.server.clone();
        }
        let mut others = self.others.lock().unwrap_or_else(|e| e.into_inner());
        others
            .entry(room.clone())
            .or_insert_with(|| Arc::new(GroupStore::open_at(self.dir.as_ref().map(|d| d.join(room.name())))))
            .clone()
    }

    /// The direct-message rooms `user` is in that have a group.
    pub fn dms_of(&self, user: &UserId) -> Vec<Room> {
        let others = self.others.lock().unwrap_or_else(|e| e.into_inner());
        let mut rooms: Vec<Room> = others.iter().filter(|(room, store)| room.peer(user).is_some() && store.exists()).map(|(room, _)| room.clone()).collect();
        rooms.sort_by_key(Room::name);
        rooms
    }

    pub fn prune(&self, now: u64) {
        self.server.prune(now);
        let others: Vec<Arc<GroupStore>> = self.others.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        for store in others {
            store.prune(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hv_roster::perms::{ChannelDef, ChannelKind, ChannelOverride, Tri};
    use hv_roster::{Body, Identity, RoleId, sign_entry, sign_genesis, sign_join};

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn rooms_are_named_and_parsed_strictly() {
        assert_eq!(Room::parse(None), Some(Room::Server));
        assert_eq!(Room::parse(Some("srv")), Some(Room::Server));
        assert_eq!(Room::parse(Some("ch.staff")), Some(Room::Channel("staff".into())));
        assert_eq!(Room::parse(Some(&format!("dm.{A}.{B}"))), Some(Room::Dm(UserId(A.into()), UserId(B.into()))));
        for bad in ["ch.", "ch.Staff", "ch.../x", &format!("dm.{B}.{A}"), &format!("dm.{A}.{A}"), "dm.a.b", "group", "ch.staff/../x"] {
            assert_eq!(Room::parse(Some(bad)), None, "{bad}");
        }
        let dm = Room::dm(&UserId(B.into()), &UserId(A.into()));
        assert_eq!(dm.name(), format!("dm.{A}.{B}"));
        assert_eq!(Room::parse(Some(&dm.name())), Some(dm.clone()));
        assert_eq!(dm.peer(&UserId(A.into())), Some(&UserId(B.into())));
        assert_eq!(Room::Server.tag(), None);
    }

    /// Owner 1, member 2 with the role «admin», member 3 without; «staff» is closed to everyone but admins.
    fn roster() -> (Roster, [UserId; 4]) {
        let id = |n: u8| Identity::from_seed([n; 32]);
        let mut r = Roster::new();
        r.apply(sign_genesis(&id(1), &id(100), "Хата", 1)).unwrap();
        let act = |r: &mut Roster, body| {
            let entry = sign_entry(r, &id(1), 1, body);
            r.apply(entry).unwrap();
        };
        let admin = RoleId::parse("admin").unwrap();
        let overrides = vec![
            ChannelOverride { role: RoleId::everyone(), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit },
            ChannelOverride { role: admin.clone(), view: Tri::Allow, connect: Tri::Inherit, speak: Tri::Inherit },
        ];
        act(&mut r, Body::ChannelCreate(ChannelDef { id: "staff".into(), name: "staff".into(), user_limit: 0, overrides, kind: ChannelKind::Text }));
        act(&mut r, Body::ChannelCreate(ChannelDef { id: "general".into(), name: "general".into(), user_limit: 0, overrides: vec![], kind: ChannelKind::Text }));
        for (n, roles) in [(2u8, vec![admin.clone()]), (3, vec![])] {
            let invite = Identity::from_seed([50 + n; 32]);
            act(&mut r, Body::InviteCreate { invite: invite.public(), roles, max_uses: None, expires_at: None });
            let join = sign_join(&r, &id(n), &invite, 1);
            r.apply(join).unwrap();
        }
        let users = [1u8, 2, 3, 9].map(|n| id(n).public().user_id());
        (r, users)
    }

    #[test]
    fn the_journal_says_who_may_enter() {
        let (r, [owner, staff, plain, stranger]) = roster();
        let channel = Room::Channel("staff".into());
        assert!(channel.may_enter(&r, &owner, 10));
        assert!(channel.may_enter(&r, &staff, 10));
        assert!(!channel.may_enter(&r, &plain, 10), "no view on the closed channel");
        assert!(!Room::Channel("general".into()).may_enter(&r, &owner, 10), "an open or unknown channel has no room");
        let dm = Room::dm(&staff, &plain);
        assert!(dm.may_enter(&r, &staff, 10) && dm.may_enter(&r, &plain, 10));
        assert!(!dm.may_enter(&r, &owner, 10), "not one of the two");
        assert!(!Room::dm(&staff, &stranger).may_enter(&r, &staff, 10), "the other one is not a member");
        assert!(!Room::Server.may_enter(&r, &stranger, 10));
    }

    #[test]
    fn each_room_has_its_own_store_and_dms_are_found_again() {
        let dir = std::env::temp_dir().join(format!("hv-rooms-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (a, b) = (UserId(A.into()), UserId(B.into()));
        {
            let rooms = Rooms::open(Some(&dir), Arc::new(GroupStore::open(Some(&dir))));
            let dm = Room::dm(&a, &b);
            rooms.store(&dm).create("AAAAAAAAAAAAAAAAAAAAAA".into(), a.clone()).unwrap();
            assert!(rooms.store(&Room::Channel("staff".into())).since(&a, 0, 10, 0).is_none(), "another room, no group yet");
            assert_eq!(rooms.dms_of(&b), vec![dm]);
        }
        let again = Rooms::open(Some(&dir), Arc::new(GroupStore::open(Some(&dir))));
        assert_eq!(again.dms_of(&a).len(), 1, "found on disk after a restart");
        assert!(again.dms_of(&UserId("cccccccccccccccccccccccccc".into())).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
