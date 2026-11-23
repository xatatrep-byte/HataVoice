//! Rights: what roles allow on a server.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    ManageServer,
    ManageRoles,
    ManageChannels,
    CreateInvites,
    ViewAuditLog,
    MuteMembers,
    MoveMembers,
    KickMembers,
    BanMembers,
    Connect,
    Speak,
    Stream,
}

impl Permission {
    pub const ALL: [Permission; 12] = [
        Permission::ManageServer,
        Permission::ManageRoles,
        Permission::ManageChannels,
        Permission::CreateInvites,
        Permission::ViewAuditLog,
        Permission::MuteMembers,
        Permission::MoveMembers,
        Permission::KickMembers,
        Permission::BanMembers,
        Permission::Connect,
        Permission::Speak,
        Permission::Stream,
    ];
}

/// A set of rights; serialized as a list of their snake_case names.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Permissions(pub BTreeSet<Permission>);

impl Permissions {
    pub fn all() -> Self {
        Self(Permission::ALL.into_iter().collect())
    }

    pub fn of(list: &[Permission]) -> Self {
        Self(list.iter().copied().collect())
    }

    pub fn has(&self, permission: Permission) -> bool {
        self.0.contains(&permission)
    }

    pub fn union(&self, other: &Self) -> Self {
        Self(self.0.union(&other.0).copied().collect())
    }

    pub fn is_subset(&self, other: &Self) -> bool {
        self.0.is_subset(&other.0)
    }
}

/// The built-in role every member has; always the lowest.
pub const EVERYONE: &str = "everyone";
const MAX_ROLE_ID_LEN: usize = 32;
const MAX_ROLE_NAME_CHARS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RoleId(pub String);

impl RoleId {
    pub fn everyone() -> Self {
        Self(EVERYONE.into())
    }

    /// 1–32 characters of `[a-z0-9-]`.
    pub fn parse(text: &str) -> Result<Self, String> {
        let ok = !text.is_empty()
            && text.len() <= MAX_ROLE_ID_LEN
            && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if ok { Ok(Self(text.into())) } else { Err(format!("Неверный id роли: {text:?}")) }
    }

    pub fn is_everyone(&self) -> bool {
        self.0 == EVERYONE
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleDef {
    pub id: RoleId,
    pub name: String,
    /// `#rrggbb`; members' nicknames take the color of their highest colored role.
    #[serde(default)]
    pub color: Option<String>,
    pub permissions: Permissions,
}

impl RoleDef {
    pub fn validate(&self) -> Result<(), String> {
        RoleId::parse(&self.id.0)?;
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > MAX_ROLE_NAME_CHARS {
            return Err("Название роли: от 1 до 32 символов".into());
        }
        if let Some(color) = &self.color {
            let hex = color.strip_prefix('#').unwrap_or("");
            if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Цвет роли — в виде #rrggbb".into());
            }
        }
        Ok(())
    }
}

/// A channel's override of one right for one role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tri {
    #[default]
    Inherit,
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelOverride {
    pub role: RoleId,
    #[serde(default)]
    pub view: Tri,
    #[serde(default)]
    pub connect: Tri,
    #[serde(default)]
    pub speak: Tri,
}

/// What a channel is for. Every channel has a chat; a voice one also has a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    #[default]
    Voice,
    Text,
}

impl ChannelKind {
    pub fn is_voice(&self) -> bool {
        *self == ChannelKind::Voice
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelDef {
    pub id: String,
    pub name: String,
    /// 0 means no limit.
    #[serde(default)]
    pub user_limit: u32,
    #[serde(default)]
    pub overrides: Vec<ChannelOverride>,
    /// Left out of a voice channel's JSON, so entries signed before text channels existed keep their bytes.
    #[serde(default, skip_serializing_if = "ChannelKind::is_voice")]
    pub kind: ChannelKind,
}

impl ChannelDef {
    /// Some role may not see the channel: everyone on the server shares one chat group, so such a channel can't
    /// have a chat yet.
    pub fn is_closed(&self) -> bool {
        self.overrides.iter().any(|o| o.view == Tri::Deny)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelAccess {
    pub view: bool,
    pub connect: bool,
    pub speak: bool,
}

/// What a member may do in a channel: the owner everything; otherwise their roles' rights,
/// then `@все`'s override, then their other roles' overrides (any deny, then any allow wins).
pub fn channel_access(is_owner: bool, member_perms: &Permissions, member_roles: &[RoleId], channel: &ChannelDef) -> ChannelAccess {
    if is_owner {
        return ChannelAccess { view: true, connect: true, speak: true };
    }
    let mut access = [true, member_perms.has(Permission::Connect), member_perms.has(Permission::Speak)];
    let fields = |o: &ChannelOverride| [o.view, o.connect, o.speak];
    if let Some(everyone) = channel.overrides.iter().find(|o| o.role.is_everyone()) {
        for (value, tri) in access.iter_mut().zip(fields(everyone)) {
            match tri {
                Tri::Allow => *value = true,
                Tri::Deny => *value = false,
                Tri::Inherit => {}
            }
        }
    }
    let own: Vec<[Tri; 3]> = channel
        .overrides
        .iter()
        .filter(|o| !o.role.is_everyone() && member_roles.contains(&o.role))
        .map(fields)
        .collect();
    for (i, value) in access.iter_mut().enumerate() {
        if own.iter().any(|f| f[i] == Tri::Deny) {
            *value = false;
        }
        if own.iter().any(|f| f[i] == Tri::Allow) {
            *value = true;
        }
    }
    let [view, connect, speak] = access;
    let connect = view && connect;
    ChannelAccess { view, connect, speak: connect && speak }
}

/// The roles every new server starts with, bottom to top.
pub fn default_roles() -> Vec<RoleDef> {
    use Permission::*;
    let everyone = Permissions::of(&[Connect, Speak, Stream]);
    let moderator = everyone.union(&Permissions::of(&[MuteMembers, MoveMembers]));
    let role = |id: &str, name: &str, permissions| RoleDef { id: RoleId(id.into()), name: name.into(), color: None, permissions };
    vec![
        role(EVERYONE, "@все", everyone),
        role("moderator", "Модератор", moderator),
        role("admin", "Админ", Permissions::all()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_channel_entries_serialize_as_before() {
        // A channel written before text channels existed: signed entries must keep their exact bytes.
        let old = r#"{"id":"general","name":"Общий","user_limit":0,"overrides":[]}"#;
        let channel: ChannelDef = serde_json::from_str(old).unwrap();
        assert_eq!(channel.kind, ChannelKind::Voice);
        assert_eq!(serde_json::to_string(&channel).unwrap(), old);
    }

    #[test]
    fn text_channel_round_trips() {
        let text = r#"{"id":"chat","name":"Болталка","user_limit":0,"overrides":[],"kind":"text"}"#;
        let channel: ChannelDef = serde_json::from_str(text).unwrap();
        assert_eq!(channel.kind, ChannelKind::Text);
        assert_eq!(serde_json::to_string(&channel).unwrap(), text);
        assert!(serde_json::from_str::<ChannelDef>(&text.replace("text", "video")).is_err());
    }

    #[test]
    fn closed_when_some_role_cannot_view() {
        let role = |view| ChannelOverride { role: RoleId::everyone(), view, connect: Tri::Inherit, speak: Tri::Inherit };
        let channel = |overrides| ChannelDef { id: "c".into(), name: "c".into(), user_limit: 0, overrides, kind: ChannelKind::Text };
        assert!(channel(vec![role(Tri::Deny)]).is_closed());
        assert!(!channel(vec![role(Tri::Allow)]).is_closed());
        assert!(!channel(vec![role(Tri::Inherit)]).is_closed());
        assert!(!channel(vec![]).is_closed());
    }

    #[test]
    fn permissions_serialize_as_snake_case_names() {
        let perms = Permissions::of(&[Permission::Connect, Permission::Speak, Permission::ManageRoles]);
        let json = serde_json::to_value(&perms).unwrap();
        assert_eq!(json, serde_json::json!(["manage_roles", "connect", "speak"]));
        let back: Permissions = serde_json::from_value(serde_json::json!(["speak", "connect", "manage_roles"])).unwrap();
        assert_eq!(back, perms);
        assert!(serde_json::from_value::<Permissions>(serde_json::json!(["fly"])).is_err());
    }

    #[test]
    fn all_permissions_are_twelve_and_subsets_work() {
        let all = Permissions::all();
        assert_eq!(all.0.len(), 12);
        let some = Permissions::of(&[Permission::Speak]);
        assert!(some.is_subset(&all));
        assert!(!all.is_subset(&some));
        assert!(some.union(&Permissions::of(&[Permission::Stream])).has(Permission::Stream));
    }

    #[test]
    fn role_id_rules() {
        assert!(RoleId::parse("everyone").is_ok());
        assert!(RoleId::parse("a-1").is_ok());
        assert!(RoleId::parse(&"x".repeat(32)).is_ok());
        assert!(RoleId::parse("").is_err());
        assert!(RoleId::parse("A").is_err());
        assert!(RoleId::parse("dj team").is_err());
        assert!(RoleId::parse(&"x".repeat(33)).is_err());
    }

    fn channel(overrides: &[(&str, Tri, Tri, Tri)]) -> ChannelDef {
        ChannelDef {
            id: "general".into(),
            name: "Общий".into(),
            user_limit: 0,
            overrides: overrides
                .iter()
                .map(|&(role, view, connect, speak)| ChannelOverride { role: RoleId(role.into()), view, connect, speak })
                .collect(),
            kind: ChannelKind::Voice,
        }
    }

    #[test]
    fn channel_access_follows_the_spec_rules() {
        use Permission::{Connect, Speak};
        use Tri::{Allow as A, Deny as D, Inherit as I};
        let ids = |list: &[&str]| list.iter().map(|r| RoleId((*r).into())).collect::<Vec<_>>();
        let talk = Permissions::of(&[Connect, Speak]);
        let listen = Permissions::of(&[Connect]);
        let access = |owner, perms: &Permissions, roles: &[&str], overrides: &[(&str, Tri, Tri, Tri)]| {
            let a = channel_access(owner, perms, &ids(roles), &channel(overrides));
            (a.view, a.connect, a.speak)
        };

        assert_eq!(access(true, &Permissions::default(), &[], &[(EVERYONE, D, D, D)]), (true, true, true), "owner");
        assert_eq!(access(false, &talk, &[], &[]), (true, true, true), "base from role rights");
        assert_eq!(access(false, &listen, &[], &[]), (true, true, false), "no speak right");
        assert_eq!(access(false, &talk, &[], &[(EVERYONE, D, I, I)]), (false, false, false), "hidden channel");
        assert_eq!(
            access(false, &talk, &["speaker"], &[(EVERYONE, I, I, D), ("speaker", I, I, A)]),
            (true, true, true),
            "stage: speakers may talk"
        );
        assert_eq!(access(false, &talk, &[], &[(EVERYONE, I, I, D), ("speaker", I, I, A)]), (true, true, false));
        assert_eq!(
            access(false, &talk, &["a", "b"], &[("a", I, D, I), ("b", I, A, I)]),
            (true, true, true),
            "allow beats deny among roles"
        );
        assert_eq!(access(false, &talk, &["a"], &[("a", I, D, I)]), (true, false, false), "no connect, no speak");
        assert_eq!(access(false, &listen, &[], &[(EVERYONE, I, I, A)]), (true, true, true), "@все allow");
        assert_eq!(access(false, &talk, &["a"], &[("other", D, D, D)]), (true, true, true), "overrides of other roles");
    }

    #[test]
    fn tri_defaults_to_inherit_in_json() {
        let parsed: ChannelOverride = serde_json::from_value(serde_json::json!({ "role": "dj", "speak": "allow" })).unwrap();
        assert_eq!((parsed.view, parsed.connect, parsed.speak), (Tri::Inherit, Tri::Inherit, Tri::Allow));
    }

    #[test]
    fn role_names_and_colors_are_checked() {
        let role = |name: &str, color: Option<&str>| RoleDef {
            id: RoleId::parse("dj").unwrap(),
            name: name.into(),
            color: color.map(String::from),
            permissions: Permissions::default(),
        };
        assert!(role("Диджей", Some("#ff8800")).validate().is_ok());
        assert!(role("Диджей", None).validate().is_ok());
        assert!(role("   ", None).validate().is_err());
        assert!(role(&"я".repeat(33), None).validate().is_err());
        assert!(role("Диджей", Some("orange")).validate().is_err());
        assert!(role("Диджей", Some("#ff88")).validate().is_err());
    }
}
