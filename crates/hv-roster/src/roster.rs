//! The member list as an append-only chain of signed entries.
//!
//! Every change is signed by whoever is allowed to make it, and a join additionally by the
//! invite's own key, whose secret exists only in the invite link. So the server that stores the
//! chain can't add members, change roles or hide a ban without the clients noticing.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::keys::{Digest, Identity, PublicKey, Signature, UserId, sha256};
use crate::perms::{ChannelAccess, ChannelDef, Permission, Permissions, RoleDef, RoleId, channel_access, default_roles};

const DOMAIN: &str = "hatavoice-roster-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Body {
    Genesis { server_name: String, owner: PublicKey, server_key: PublicKey },
    RoleCreate(RoleDef),
    RoleUpdate(RoleDef),
    RoleDelete { id: RoleId },
    /// Every role bottom to top, `everyone` first.
    RoleOrder { ids: Vec<RoleId> },
    /// The member's roles besides the implicit `everyone`.
    MemberRoles { user: UserId, roles: Vec<RoleId> },
    InviteCreate { invite: PublicKey, roles: Vec<RoleId>, max_uses: Option<u32>, expires_at: Option<u64> },
    InviteRevoke { invite: PublicKey },
    Join { user: PublicKey, invite: PublicKey },
    Leave,
    Kick { user: UserId, reason: String, media: Option<MediaRef> },
    /// `until` in Unix seconds; `None` is for ever.
    Ban { user: UserId, until: Option<u64>, reason: String, media: Option<MediaRef> },
    Unban { user: UserId },
    OwnerTransfer { to: UserId },
    ServerProfile(ServerProfile),
    ServerSettings(ServerSettings),
    ChannelCreate(ChannelDef),
    ChannelUpdate(ChannelDef),
    ChannelDelete { id: String },
    /// Every channel id once, top to bottom as listed.
    ChannelOrder { ids: Vec<String> },
}

/// A file uploaded to the server (a moderation GIF, the server icon), pinned by its hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaRef {
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
    pub mime: String,
    pub size: u64,
}

pub const MEDIA_TYPES: [&str; 6] = ["image/gif", "video/mp4", "video/webm", "image/png", "image/jpeg", "image/webp"];
pub const MAX_MEDIA_BYTES: u64 = 8 * 1024 * 1024;

impl MediaRef {
    pub fn validate(&self) -> Result<(), String> {
        let hex = self.sha256.len() == 64 && self.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !hex {
            return Err("Испорчена ссылка на файл".into());
        }
        if !MEDIA_TYPES.contains(&self.mime.as_str()) {
            return Err("Такой тип файла не поддерживается".into());
        }
        if self.size == 0 || self.size > MAX_MEDIA_BYTES {
            return Err("Файл пустой или больше 8 МБ".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BanInfo {
    pub by: UserId,
    pub at: u64,
    pub until: Option<u64>,
    pub reason: String,
    pub media: Option<MediaRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ServerProfile {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Shown to a newcomer joining by invite.
    #[serde(default)]
    pub welcome: String,
    #[serde(default)]
    pub icon: Option<MediaRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerSettings {
    #[serde(default)]
    pub afk_channel: Option<String>,
    /// Minutes of inactivity before moving to the AFK channel; 0 turns it off.
    #[serde(default)]
    pub afk_minutes: u32,
    /// How many days of the chat a newcomer is given; 0 gives none.
    #[serde(default = "default_history_days")]
    pub history_days: u32,
}

fn default_history_days() -> u32 {
    30
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self { afk_channel: None, afk_minutes: 0, history_days: default_history_days() }
    }
}

const MAX_CHANNELS: usize = 50;
const MAX_CHANNEL_ID_LEN: usize = 64;
const MAX_CHANNEL_NAME_CHARS: usize = 32;
const MAX_USER_LIMIT: u32 = 99;

/// The channel as stored: name trimmed.
fn clean_channel(channel: &ChannelDef) -> ChannelDef {
    ChannelDef { name: channel.name.trim().to_string(), ..channel.clone() }
}

const MAX_REASON_CHARS: usize = 200;
const MAX_TEXT_CHARS: usize = 500;
const AFK_MINUTES: [u32; 5] = [0, 5, 15, 30, 60];
pub const HISTORY_DAYS: [u32; 4] = [0, 7, 30, 90];

fn check_media(media: &Option<MediaRef>) -> Result<(), RosterError> {
    media.as_ref().map_or(Ok(()), |m| m.validate().map_err(RosterError))
}

fn trimmed_reason(reason: &str) -> Result<String, RosterError> {
    let reason = reason.trim();
    if reason.chars().count() > MAX_REASON_CHARS {
        return reject("Причина — не длиннее 200 символов");
    }
    Ok(reason.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub seq: u64,
    pub prev: Digest,
    /// Unix seconds, set by the author; the server rejects clocks far off its own.
    pub at: u64,
    pub author: PublicKey,
    pub body: Body,
    pub signature: Signature,
    /// Only for `Join`: signature by the invite key over the same bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite_signature: Option<Signature>,
    /// Only for `Genesis`: signature by the server key it names, over the same bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_signature: Option<Signature>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Member {
    pub key: PublicKey,
    /// Besides the implicit `everyone`; the owner has none and all rights.
    pub roles: Vec<RoleId>,
    pub joined_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    pub roles: Vec<RoleId>,
    pub max_uses: Option<u32>,
    pub uses: u32,
    pub expires_at: Option<u64>,
    pub revoked: bool,
    /// Who already came in with it: a kicked or departed member needs a new invite.
    pub used_by: Vec<UserId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterError(pub String);

impl fmt::Display for RosterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RosterError {}

#[derive(Debug, Clone, Default)]
pub struct Roster {
    entries: Vec<Entry>,
    head: Digest,
    profile: ServerProfile,
    settings: ServerSettings,
    owner: Option<PublicKey>,
    server_key: Option<PublicKey>,
    /// Bottom to top; `everyone` is always first.
    roles: Vec<RoleDef>,
    channels: Vec<ChannelDef>,
    members: HashMap<UserId, Member>,
    /// Kept after a timed ban ends, until an unban; `is_banned_at` decides.
    bans: HashMap<UserId, BanInfo>,
    invites: HashMap<PublicKey, Invite>,
}

const MAX_SERVER_NAME_CHARS: usize = 64;
const MAX_INVITE_USES: u32 = 1000;

/// The exact bytes that get signed.
fn signable(seq: u64, prev: &Digest, at: u64, author: &PublicKey, body: &Body) -> Vec<u8> {
    #[derive(Serialize)]
    struct Signable<'a> {
        domain: &'static str,
        seq: u64,
        prev: &'a Digest,
        at: u64,
        author: &'a PublicKey,
        body: &'a Body,
    }
    serde_json::to_vec(&Signable { domain: DOMAIN, seq, prev, at, author, body })
        .expect("serializing a roster entry cannot fail")
}

impl Entry {
    /// The bytes every signature on this entry covers.
    pub fn signed_bytes(&self) -> Vec<u8> {
        signable(self.seq, &self.prev, self.at, &self.author, &self.body)
    }

    /// Hash over the signed bytes and the signatures; the next entry's `prev`.
    pub fn hash(&self) -> Digest {
        let mut bytes = self.signed_bytes();
        bytes.extend_from_slice(&self.signature.0);
        for extra in [&self.invite_signature, &self.server_signature].into_iter().flatten() {
            bytes.extend_from_slice(&extra.0);
        }
        Digest(sha256(&bytes))
    }
}

/// Signs `body` as the next entry of `roster`.
pub fn sign_entry(roster: &Roster, author: &Identity, at: u64, body: Body) -> Entry {
    let (seq, prev, key) = (roster.len(), roster.head(), author.public());
    let signature = author.sign(&signable(seq, &prev, at, &key, &body));
    Entry { seq, prev, at, author: key, body, signature, invite_signature: None, server_signature: None }
}

/// A join, signed by the new member and by the invite key from the link.
pub fn sign_join(roster: &Roster, user: &Identity, invite: &Identity, at: u64) -> Entry {
    sign_join_after(roster.len(), roster.head(), user, invite, at)
}

/// A join for a journal known only by its length and head (a newcomer can't read it yet).
pub fn sign_join_after(seq: u64, prev: Digest, user: &Identity, invite: &Identity, at: u64) -> Entry {
    let body = Body::Join { user: user.public(), invite: invite.public() };
    let key = user.public();
    let signature = user.sign(&signable(seq, &prev, at, &key, &body));
    let mut entry = Entry { seq, prev, at, author: key, body, signature, invite_signature: None, server_signature: None };
    entry.invite_signature = Some(invite.sign(&entry.signed_bytes()));
    entry
}

/// The first entry of a server: signed by its owner and by the server's own key.
pub fn sign_genesis(owner: &Identity, server: &Identity, name: &str, at: u64) -> Entry {
    let body = Body::Genesis { server_name: name.into(), owner: owner.public(), server_key: server.public() };
    let mut entry = sign_entry(&Roster::new(), owner, at, body);
    entry.server_signature = Some(server.sign(&entry.signed_bytes()));
    entry
}

fn reject<T>(message: &str) -> Result<T, RosterError> {
    Err(RosterError(message.into()))
}

fn server_name_checked(name: &str) -> Result<String, RosterError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_SERVER_NAME_CHARS {
        return reject("Название сервера: от 1 до 64 символов");
    }
    Ok(name.to_string())
}

impl Roster {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replays a whole chain, checking every entry.
    pub fn from_entries(entries: Vec<Entry>) -> Result<Self, RosterError> {
        let mut roster = Self::new();
        for entry in entries {
            roster.apply(entry)?;
        }
        Ok(roster)
    }

    /// Checks and appends one entry. A rejected entry leaves the roster unchanged.
    pub fn apply(&mut self, entry: Entry) -> Result<(), RosterError> {
        if entry.seq != self.len() {
            return reject("Нарушен порядок записей");
        }
        if entry.prev != self.head {
            return reject("Запись не продолжает цепочку");
        }
        let bytes = entry.signed_bytes();
        if !entry.author.verify(&bytes, &entry.signature) {
            return reject("Неверная подпись записи");
        }
        if entry.invite_signature.is_some() && !matches!(entry.body, Body::Join { .. }) {
            return reject("Лишняя подпись приглашения");
        }
        if entry.server_signature.is_some() && !matches!(entry.body, Body::Genesis { .. }) {
            return reject("Лишняя подпись сервера");
        }

        // Every check runs on a copy, so a rejected entry changes nothing.
        let mut next = self.clone();
        next.apply_body(&entry, &bytes)?;
        next.head = entry.hash();
        next.entries.push(entry);
        *self = next;
        Ok(())
    }

    fn apply_body(&mut self, entry: &Entry, bytes: &[u8]) -> Result<(), RosterError> {
        match &entry.body {
            Body::Genesis { server_name, owner, server_key } => {
                if !self.is_empty() {
                    return reject("Сервер уже создан");
                }
                if entry.author != *owner {
                    return reject("Создание сервера подписывает сам владелец");
                }
                let Some(server_signature) = &entry.server_signature else {
                    return reject("Нет подписи ключа сервера");
                };
                if !server_key.verify(bytes, server_signature) {
                    return reject("Неверная подпись ключа сервера");
                }
                self.profile = ServerProfile { name: server_name_checked(server_name)?, ..ServerProfile::default() };
                self.owner = Some(*owner);
                self.server_key = Some(*server_key);
                self.roles = default_roles();
                let member = Member { key: *owner, roles: Vec::new(), joined_at: entry.at };
                self.members.insert(owner.user_id(), member);
                Ok(())
            }
            _ if self.is_empty() => reject("Цепочка должна начинаться с создания сервера"),
            Body::Join { user, invite } => self.apply_join(entry, bytes, user, invite),
            body => {
                let author = entry.author.user_id();
                if !self.members.contains_key(&author) {
                    return reject("Автор записи не участник сервера");
                }
                self.apply_member_action(&author, entry.at, body)
            }
        }
    }

    fn apply_join(&mut self, entry: &Entry, bytes: &[u8], user: &PublicKey, invite: &PublicKey) -> Result<(), RosterError> {
        if entry.author != *user {
            return reject("Вход подписывает сам участник");
        }
        let Some(invite_signature) = &entry.invite_signature else {
            return reject("Нет подписи приглашения");
        };
        if !invite.verify(bytes, invite_signature) {
            return reject("Неверная подпись приглашения");
        }
        let id = user.user_id();
        if self.is_banned_at(&id, entry.at) {
            return reject("Этот пользователь забанен");
        }
        if self.members.contains_key(&id) {
            return reject("Уже участник сервера");
        }
        let Some(state) = self.invites.get_mut(invite) else {
            return reject("Приглашение не найдено");
        };
        if state.revoked {
            return reject("Приглашение отозвано");
        }
        if state.expires_at.is_some_and(|expires| entry.at >= expires) {
            return reject("Приглашение истекло");
        }
        if state.max_uses.is_some_and(|max| state.uses >= max) {
            return reject("Приглашение уже использовано");
        }
        if state.used_by.contains(&id) {
            return reject("Это приглашение ты уже использовал — попроси новое");
        }
        state.uses += 1;
        state.used_by.push(id.clone());
        let roles = state.roles.clone();
        self.members.insert(id, Member { key: *user, roles, joined_at: entry.at });
        Ok(())
    }

    fn apply_member_action(&mut self, author: &UserId, at: u64, body: &Body) -> Result<(), RosterError> {
        let need = |right: Permission, message: &str| -> Result<(), RosterError> {
            if self.permissions_of(author).has(right) { Ok(()) } else { reject(message) }
        };
        match body {
            Body::RoleCreate(role) => {
                need(Permission::ManageRoles, "Нет права управлять ролями")?;
                role.validate().map_err(RosterError)?;
                if role.id.is_everyone() || self.role_index(&role.id).is_some() {
                    return reject("Роль с таким id уже есть");
                }
                self.check_grantable(author, &role.permissions)?;
                // New roles start just above @все, below everyone who can create them.
                self.roles.insert(1, role.clone());
            }
            Body::RoleUpdate(role) => {
                need(Permission::ManageRoles, "Нет права управлять ролями")?;
                role.validate().map_err(RosterError)?;
                let Some(index) = self.role_index(&role.id) else {
                    return reject("Такой роли нет");
                };
                self.check_below_author(author, index)?;
                self.check_grantable(author, &role.permissions)?;
                if role.id.is_everyone() && role.name != self.roles[0].name {
                    return reject("Название «@все» не меняется");
                }
                self.roles[index] = role.clone();
            }
            Body::RoleDelete { id } => {
                need(Permission::ManageRoles, "Нет права управлять ролями")?;
                if id.is_everyone() {
                    return reject("«@все» удалить нельзя");
                }
                let Some(index) = self.role_index(id) else {
                    return reject("Такой роли нет");
                };
                self.check_below_author(author, index)?;
                self.roles.remove(index);
                for channel in &mut self.channels {
                    channel.overrides.retain(|o| &o.role != id);
                }
                for member in self.members.values_mut() {
                    member.roles.retain(|r| r != id);
                }
                for invite in self.invites.values_mut() {
                    invite.roles.retain(|r| r != id);
                }
            }
            Body::RoleOrder { ids } => {
                need(Permission::ManageRoles, "Нет права управлять ролями")?;
                let current: Vec<&RoleId> = self.roles.iter().map(|r| &r.id).collect();
                let mut sorted_new: Vec<&RoleId> = ids.iter().collect();
                let mut sorted_old = current.clone();
                sorted_new.sort();
                sorted_old.sort();
                if sorted_new != sorted_old || ids.first().is_none_or(|first| !first.is_everyone()) {
                    return reject("Порядок должен перечислять все роли по разу, «@все» первой");
                }
                // Your own top role and everything above it stay where they are.
                let rank = self.rank_of(author) as usize;
                let fixed_from = if self.is_owner(author) { current.len() } else { rank.min(current.len()) };
                if (fixed_from..current.len()).any(|i| ids[i] != *current[i]) {
                    return reject("Нельзя двигать свою роль и роли выше неё");
                }
                let mut reordered = Vec::with_capacity(self.roles.len());
                for id in ids {
                    reordered.push(self.roles[self.role_index(id).expect("checked above")].clone());
                }
                self.roles = reordered;
            }
            Body::MemberRoles { user, roles } => {
                need(Permission::ManageRoles, "Нет права управлять ролями")?;
                let Some(target) = self.members.get(user) else {
                    return reject("Такого участника нет");
                };
                if self.is_owner(user) {
                    return reject("Роли владельца не меняются");
                }
                if user != author && !self.outranks(author, user) {
                    return reject("Его роль не ниже твоей");
                }
                let mut wanted: Vec<RoleId> = Vec::new();
                for role in roles {
                    if role.is_everyone() || self.role_index(role).is_none() {
                        return reject("Такой роли нет");
                    }
                    if !wanted.contains(role) {
                        wanted.push(role.clone());
                    }
                }
                let added = wanted.iter().filter(|r| !target.roles.contains(r));
                // Dropping your own roles is always allowed; anything else only below your rank.
                let removed = target.roles.iter().filter(|r| !wanted.contains(r) && user != author);
                for role in added.chain(removed) {
                    let index = self.role_index(role).expect("existing role");
                    self.check_below_author(author, index)?;
                }
                self.members.get_mut(user).expect("checked above").roles = wanted;
            }
            Body::InviteCreate { invite, roles, max_uses, expires_at } => {
                need(Permission::CreateInvites, "Нет права приглашать")?;
                for role in roles {
                    let Some(index) = self.role_index(role).filter(|_| !role.is_everyone()) else {
                        return reject("Такой роли нет");
                    };
                    self.check_below_author(author, index)?;
                }
                if max_uses.is_some_and(|max| max == 0 || max > MAX_INVITE_USES) {
                    return reject("Число использований приглашения: от 1 до 1000");
                }
                if expires_at.is_some_and(|expires| expires <= at) {
                    return reject("Срок приглашения уже прошёл");
                }
                if self.invites.contains_key(invite) {
                    return reject("Такое приглашение уже есть");
                }
                let state = Invite { roles: roles.clone(), max_uses: *max_uses, uses: 0, expires_at: *expires_at, revoked: false, used_by: Vec::new() };
                self.invites.insert(*invite, state);
            }
            Body::InviteRevoke { invite } => {
                need(Permission::CreateInvites, "Нет права приглашать")?;
                let Some(state) = self.invites.get_mut(invite) else {
                    return reject("Приглашение не найдено");
                };
                state.revoked = true;
            }
            Body::Leave => {
                if self.is_owner(author) {
                    return reject("Владелец не может покинуть сервер — сначала передай владение");
                }
                self.members.remove(author);
            }
            Body::Kick { user, reason, media } => {
                need(Permission::KickMembers, "Нет права кикать")?;
                if !self.members.contains_key(user) {
                    return reject("Такого участника нет");
                }
                if !self.outranks(author, user) {
                    return reject("Его роль не ниже твоей");
                }
                trimmed_reason(reason)?;
                check_media(media)?;
                self.members.remove(user);
            }
            Body::Ban { user, until, reason, media } => {
                need(Permission::BanMembers, "Нет права банить")?;
                if user == author {
                    return reject("Себя забанить нельзя");
                }
                // Someone who never joined can be banned in advance; members only from below.
                if self.members.contains_key(user) && !self.outranks(author, user) {
                    return reject("Его роль не ниже твоей");
                }
                if until.is_some_and(|until| until <= at) {
                    return reject("Срок бана уже прошёл");
                }
                let reason = trimmed_reason(reason)?;
                check_media(media)?;
                self.members.remove(user);
                let info = BanInfo { by: author.clone(), at, until: *until, reason, media: media.clone() };
                self.bans.insert(user.clone(), info);
            }
            Body::Unban { user } => {
                need(Permission::BanMembers, "Нет права разбанивать")?;
                if self.bans.remove(user).is_none() {
                    return reject("Этот пользователь не забанен");
                }
            }
            Body::OwnerTransfer { to } => {
                if !self.is_owner(author) {
                    return reject("Передать владение может только владелец");
                }
                if to == author {
                    return reject("Ты и так владелец");
                }
                let Some(new_owner) = self.members.get_mut(to) else {
                    return reject("Такого участника нет");
                };
                new_owner.roles.clear();
                self.owner = Some(new_owner.key);
                let admin = RoleId("admin".into());
                let keeps = if self.role_index(&admin).is_some() { vec![admin] } else { Vec::new() };
                self.members.get_mut(author).expect("the owner is a member").roles = keeps;
            }
            Body::ServerProfile(profile) => {
                need(Permission::ManageServer, "Нет права управлять сервером")?;
                let name = server_name_checked(&profile.name)?;
                let long = |text: &str| text.chars().count() > MAX_TEXT_CHARS;
                if long(&profile.description) || long(&profile.welcome) {
                    return reject("Описание и приветствие — не длиннее 500 символов");
                }
                check_media(&profile.icon)?;
                self.profile = ServerProfile { name, ..profile.clone() };
            }
            Body::ServerSettings(settings) => {
                need(Permission::ManageServer, "Нет права управлять сервером")?;
                if !AFK_MINUTES.contains(&settings.afk_minutes) {
                    return reject("Время до АФК: выключено, 5, 15, 30 или 60 минут");
                }
                if !HISTORY_DAYS.contains(&settings.history_days) {
                    return reject("История для новичков: не передавать, 7, 30 или 90 дней");
                }
                if settings.afk_channel.as_ref().is_some_and(|id| self.channel_index(id).is_none()) {
                    return reject("Такого АФК-канала нет");
                }
                self.settings = settings.clone();
            }
            Body::ChannelCreate(channel) => {
                need(Permission::ManageChannels, "Нет права управлять каналами")?;
                self.check_channel(author, channel, None)?;
                if self.channel_index(&channel.id).is_some() {
                    return reject("Канал с таким id уже есть");
                }
                if self.channels.len() >= MAX_CHANNELS {
                    return reject("Каналов не больше 50");
                }
                self.channels.push(clean_channel(channel));
            }
            Body::ChannelUpdate(channel) => {
                need(Permission::ManageChannels, "Нет права управлять каналами")?;
                let Some(index) = self.channel_index(&channel.id) else {
                    return reject("Такого канала нет");
                };
                self.check_channel(author, channel, Some(&self.channels[index]))?;
                self.channels[index] = clean_channel(channel);
            }
            Body::ChannelDelete { id } => {
                need(Permission::ManageChannels, "Нет права управлять каналами")?;
                let Some(index) = self.channel_index(id) else {
                    return reject("Такого канала нет");
                };
                self.channels.remove(index);
                if self.settings.afk_channel.as_ref() == Some(id) {
                    self.settings.afk_channel = None;
                }
            }
            Body::ChannelOrder { ids } => {
                need(Permission::ManageChannels, "Нет права управлять каналами")?;
                let mut wanted: Vec<&String> = ids.iter().collect();
                let mut current: Vec<&String> = self.channels.iter().map(|c| &c.id).collect();
                wanted.sort();
                current.sort();
                if wanted != current {
                    return reject("Порядок должен перечислять все каналы по разу");
                }
                let mut reordered = Vec::with_capacity(self.channels.len());
                for id in ids {
                    reordered.push(self.channels[self.channel_index(id).expect("checked above")].clone());
                }
                self.channels = reordered;
            }
            Body::Genesis { .. } | Body::Join { .. } => unreachable!("handled by apply_body"),
        }
        Ok(())
    }

    fn role_index(&self, id: &RoleId) -> Option<usize> {
        self.roles.iter().position(|r| &r.id == id)
    }

    fn channel_index(&self, id: &str) -> Option<usize> {
        self.channels.iter().position(|c| c.id == id)
    }

    /// Valid id, name and limit; overrides only for existing roles, each once, and only
    /// changed for roles below the author (so nobody locks out those above them).
    fn check_channel(&self, author: &UserId, channel: &ChannelDef, before: Option<&ChannelDef>) -> Result<(), RosterError> {
        let id_ok = !channel.id.is_empty()
            && channel.id.len() <= MAX_CHANNEL_ID_LEN
            && channel.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !id_ok {
            return reject("id канала: латиница, цифры и «-», до 64 символов");
        }
        let name = channel.name.trim();
        if name.is_empty() || name.chars().count() > MAX_CHANNEL_NAME_CHARS {
            return reject("Название канала: от 1 до 32 символов");
        }
        if channel.user_limit > MAX_USER_LIMIT {
            return reject("Лимит людей в канале — до 99");
        }
        let mut seen: Vec<&RoleId> = Vec::new();
        for o in &channel.overrides {
            let Some(index) = self.role_index(&o.role) else {
                return reject("В правах канала указана несуществующая роль");
            };
            if seen.contains(&&o.role) {
                return reject("Права одной роли в канале указаны дважды");
            }
            seen.push(&o.role);
            let unchanged = before.is_some_and(|b| b.overrides.iter().any(|old| old == o));
            if !unchanged {
                self.check_below_author(author, index)?;
            }
        }
        if let Some(before) = before {
            for old in &before.overrides {
                let removed = !channel.overrides.iter().any(|o| o.role == old.role);
                if let Some(index) = self.role_index(&old.role).filter(|_| removed) {
                    self.check_below_author(author, index)?;
                }
            }
        }
        Ok(())
    }

    fn is_owner(&self, user: &UserId) -> bool {
        self.owner.is_some_and(|owner| owner.user_id() == *user)
    }

    /// The role at `index` must be strictly below the author's highest role.
    fn check_below_author(&self, author: &UserId, index: usize) -> Result<(), RosterError> {
        if self.is_owner(author) || (index as u32) < self.rank_of(author) {
            Ok(())
        } else {
            reject("Эта роль не ниже твоей")
        }
    }

    /// Nobody hands out rights they don't have themselves.
    fn check_grantable(&self, author: &UserId, permissions: &Permissions) -> Result<(), RosterError> {
        if permissions.is_subset(&self.permissions_of(author)) {
            Ok(())
        } else {
            reject("Нельзя выдать право, которого нет у тебя")
        }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn len(&self) -> u64 {
        self.entries.len() as u64
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn head(&self) -> Digest {
        self.head
    }

    pub fn server_name(&self) -> &str {
        &self.profile.name
    }

    pub fn profile(&self) -> &ServerProfile {
        &self.profile
    }

    pub fn settings(&self) -> &ServerSettings {
        &self.settings
    }

    pub fn owner(&self) -> Option<PublicKey> {
        self.owner
    }

    pub fn server_key(&self) -> Option<PublicKey> {
        self.server_key
    }

    /// Bottom to top, `everyone` first.
    pub fn roles(&self) -> &[RoleDef] {
        &self.roles
    }

    /// In the order the host arranged them.
    pub fn channels(&self) -> &[ChannelDef] {
        &self.channels
    }

    /// What `user` may do in channel `channel_id`; `None` for strangers or a missing channel.
    pub fn access(&self, user: &UserId, channel_id: &str) -> Option<ChannelAccess> {
        let member = self.members.get(user)?;
        let channel = &self.channels[self.channel_index(channel_id)?];
        Some(channel_access(self.is_owner(user), &self.permissions_of(user), &member.roles, channel))
    }

    pub fn member(&self, user: &UserId) -> Option<&Member> {
        self.members.get(user)
    }

    pub fn members(&self) -> impl Iterator<Item = (&UserId, &Member)> {
        self.members.iter()
    }

    /// All rights for the owner, the union of their roles (with `everyone`) for members, none otherwise.
    pub fn permissions_of(&self, user: &UserId) -> Permissions {
        if self.is_owner(user) {
            return Permissions::all();
        }
        let Some(member) = self.members.get(user) else {
            return Permissions::default();
        };
        self.roles
            .iter()
            .filter(|r| r.id.is_everyone() || member.roles.contains(&r.id))
            .fold(Permissions::default(), |acc, r| acc.union(&r.permissions))
    }

    /// Position of the member's highest role (`everyone` = 0); the owner is above everybody.
    pub fn rank_of(&self, user: &UserId) -> u32 {
        if self.is_owner(user) {
            return u32::MAX;
        }
        let Some(member) = self.members.get(user) else {
            return 0;
        };
        member.roles.iter().filter_map(|r| self.role_index(r)).max().unwrap_or(0) as u32
    }

    /// Whether `actor` may act on `target`: strictly higher rank, not yourself, never the owner.
    pub fn outranks(&self, actor: &UserId, target: &UserId) -> bool {
        actor != target
            && !self.is_owner(target)
            && self.members.contains_key(actor)
            && self.rank_of(actor) > self.rank_of(target)
    }

    pub fn ban(&self, user: &UserId) -> Option<&BanInfo> {
        self.bans.get(user)
    }

    pub fn bans(&self) -> impl Iterator<Item = (&UserId, &BanInfo)> {
        self.bans.iter()
    }

    /// A ban counts until its `until`; one without `until` is for ever.
    pub fn is_banned_at(&self, user: &UserId, now: u64) -> bool {
        self.bans.get(user).is_some_and(|ban| ban.until.is_none_or(|until| now < until))
    }

    pub fn invite(&self, key: &PublicKey) -> Option<&Invite> {
        self.invites.get(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perms::{Permission as P, Permissions, RoleDef, RoleId};

    const T0: u64 = 1_800_000_000;

    struct World {
        roster: Roster,
        owner: Identity,
    }

    fn id(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn server() -> Identity {
        id(100)
    }

    fn role(id: &str) -> RoleId {
        RoleId::parse(id).unwrap()
    }

    fn roles(ids: &[&str]) -> Vec<RoleId> {
        ids.iter().map(|r| role(r)).collect()
    }

    fn def(id: &str, name: &str, perms: &[P]) -> RoleDef {
        RoleDef { id: role(id), name: name.into(), color: None, permissions: Permissions::of(perms) }
    }

    fn world() -> World {
        let owner = id(1);
        let mut roster = Roster::new();
        roster.apply(sign_genesis(&owner, &server(), "Хата", T0)).unwrap();
        World { roster, owner }
    }

    fn uid(identity: &Identity) -> UserId {
        identity.public().user_id()
    }

    impl World {
        fn owner(&self) -> Identity {
            Identity::from_seed(self.owner.seed())
        }

        fn invite_with(&mut self, by: &Identity, roles: Vec<RoleId>, max_uses: Option<u32>, expires_at: Option<u64>) -> Identity {
            let invite = Identity::generate().unwrap();
            let body = Body::InviteCreate { invite: invite.public(), roles, max_uses, expires_at };
            let entry = sign_entry(&self.roster, by, T0 + 10, body);
            self.roster.apply(entry).unwrap();
            invite
        }

        fn invite(&mut self, by: &Identity, roles: Vec<RoleId>) -> Identity {
            self.invite_with(by, roles, Some(1), Some(T0 + 3600))
        }

        fn join_at(&mut self, user: &Identity, invite: &Identity, at: u64) -> Result<(), RosterError> {
            let entry = sign_join(&self.roster, user, invite, at);
            self.roster.apply(entry)
        }

        fn join(&mut self, user: &Identity, invite: &Identity) -> Result<(), RosterError> {
            self.join_at(user, invite, T0 + 20)
        }

        fn act(&mut self, by: &Identity, body: Body) -> Result<(), RosterError> {
            let entry = sign_entry(&self.roster, by, T0 + 30, body);
            self.roster.apply(entry)
        }

        fn add_member(&mut self, n: u8, with: &[&str]) -> Identity {
            let owner = self.owner();
            let invite = self.invite(&owner, roles(with));
            let user = id(n);
            self.join(&user, &invite).unwrap();
            user
        }

        fn role(&self, id: &str) -> RoleDef {
            self.roster.roles().iter().find(|r| r.id.0 == id).unwrap().clone()
        }
    }

    #[test]
    fn genesis_creates_owner_and_default_roles() {
        let w = world();
        assert_eq!(w.roster.server_name(), "Хата");
        assert_eq!(w.roster.owner(), Some(w.owner.public()));
        assert_eq!(w.roster.server_key(), Some(server().public()));
        let ids: Vec<&str> = w.roster.roles().iter().map(|r| r.id.0.as_str()).collect();
        assert_eq!(ids, ["everyone", "moderator", "admin"]);
        assert_eq!(w.role("everyone").permissions, Permissions::of(&[P::Connect, P::Speak, P::Stream]));
        let moderator = w.role("moderator").permissions;
        assert!(w.role("everyone").permissions.is_subset(&moderator));
        assert!(moderator.has(P::MuteMembers) && moderator.has(P::MoveMembers));
        assert!(!moderator.has(P::KickMembers));
        assert_eq!(w.role("admin").permissions, Permissions::all());
        assert_eq!(w.roster.permissions_of(&uid(&w.owner)), Permissions::all());
        assert_eq!(w.roster.member(&uid(&w.owner)).unwrap().roles, Vec::<RoleId>::new());
        assert_eq!(w.roster.len(), 1);
    }

    #[test]
    fn genesis_needs_both_owner_and_server_signatures() {
        let owner = id(1);
        let body = Body::Genesis { server_name: "Хата".into(), owner: owner.public(), server_key: server().public() };

        let mut empty = Roster::new();
        let unsigned_by_server = sign_entry(&empty, &owner, T0, body.clone());
        assert!(empty.apply(unsigned_by_server).is_err(), "no server signature");

        let mut wrong_server = sign_genesis(&owner, &server(), "Хата", T0);
        wrong_server.server_signature = sign_genesis(&owner, &id(101), "Хата", T0).server_signature;
        assert!(empty.apply(wrong_server).is_err(), "signed by another server key");

        let mut impostor = sign_genesis(&id(2), &server(), "Хата", T0);
        impostor.body = body;
        assert!(empty.apply(impostor).is_err(), "author is not the owner it names");

        let mut w = world();
        let owner = w.owner();
        assert!(w.roster.apply(sign_genesis(&owner, &server(), "Ещё", T0)).is_err(), "second genesis");
    }

    #[test]
    fn non_genesis_first_entry_is_rejected() {
        let mut empty = Roster::new();
        let entry = sign_entry(&empty, &id(1), T0, Body::InviteRevoke { invite: id(9).public() });
        assert!(empty.apply(entry).is_err());
    }

    #[test]
    fn server_signature_only_on_genesis() {
        let mut w = world();
        let owner = w.owner();
        let mut entry = sign_entry(&w.roster, &owner, T0, Body::RoleDelete { id: role("moderator") });
        entry.server_signature = Some(server().sign(b"x"));
        assert!(w.roster.apply(entry).is_err());
    }

    #[test]
    fn rank_follows_the_highest_role() {
        let mut w = world();
        let member = w.add_member(2, &[]);
        let moderator = w.add_member(3, &["moderator"]);
        let admin = w.add_member(4, &["admin"]);
        let both = w.add_member(5, &["moderator", "admin"]);
        let r = &w.roster;
        assert_eq!(r.rank_of(&uid(&member)), 0);
        assert_eq!(r.rank_of(&uid(&moderator)), 1);
        assert_eq!(r.rank_of(&uid(&admin)), 2);
        assert_eq!(r.rank_of(&uid(&both)), 2);
        assert_eq!(r.rank_of(&uid(&w.owner)), u32::MAX);
        assert!(r.outranks(&uid(&admin), &uid(&moderator)));
        assert!(!r.outranks(&uid(&moderator), &uid(&admin)));
        assert!(!r.outranks(&uid(&admin), &uid(&both)), "equal rank");
        assert!(!r.outranks(&uid(&admin), &uid(&w.owner)));
        assert!(!r.outranks(&uid(&w.owner), &uid(&w.owner)), "not yourself");
        assert!(r.outranks(&uid(&w.owner), &uid(&admin)));
        assert_eq!(r.permissions_of(&uid(&member)), Permissions::of(&[P::Connect, P::Speak, P::Stream]));
        assert!(r.permissions_of(&uid(&both)).has(P::BanMembers));
        assert_eq!(r.permissions_of(&uid(&id(77))), Permissions::default(), "not a member");
    }

    #[test]
    fn roles_are_managed_only_below_your_own() {
        let mut w = world();
        let admin = w.add_member(2, &["admin"]);
        let moderator = w.add_member(3, &["moderator"]);
        let mut with_roles = w.role("moderator");
        with_roles.permissions.0.insert(P::ManageRoles);
        w.act(&admin, Body::RoleUpdate(with_roles)).unwrap();

        let mut admin_role = w.role("admin");
        admin_role.name = "Главный".into();
        assert!(w.act(&moderator, Body::RoleUpdate(admin_role)).is_err(), "role above");
        let mut own = w.role("moderator");
        own.name = "Мод".into();
        assert!(w.act(&moderator, Body::RoleUpdate(own)).is_err(), "own top role");
        let banner = def("banner", "Банщик", &[P::BanMembers]);
        assert!(w.act(&moderator, Body::RoleCreate(banner)).is_err(), "a right they lack");

        w.act(&moderator, Body::RoleCreate(def("dj", "Диджей", &[P::Connect, P::Speak]))).unwrap();
        let ids: Vec<&str> = w.roster.roles().iter().map(|r| r.id.0.as_str()).collect();
        assert_eq!(ids, ["everyone", "dj", "moderator", "admin"], "new roles start just above @все");
        assert!(w.act(&moderator, Body::RoleCreate(def("dj", "Ещё", &[]))).is_err(), "duplicate id");

        let raise = Body::RoleOrder { ids: roles(&["everyone", "moderator", "dj", "admin"]) };
        assert!(w.act(&moderator, raise).is_err(), "moving a role to your own level");
        w.act(&moderator, Body::RoleUpdate(def("dj", "DJ", &[P::Connect]))).unwrap();
        assert_eq!(w.role("dj").name, "DJ");
    }

    #[test]
    fn everyone_cannot_be_deleted_or_moved_or_renamed() {
        let mut w = world();
        let owner = w.owner();
        assert!(w.act(&owner, Body::RoleDelete { id: role("everyone") }).is_err());
        assert!(w.act(&owner, Body::RoleOrder { ids: roles(&["moderator", "admin"]) }).is_err());
        assert!(w.act(&owner, Body::RoleOrder { ids: roles(&["moderator", "everyone", "admin"]) }).is_err());
        assert!(w.act(&owner, Body::RoleOrder { ids: roles(&["everyone", "admin"]) }).is_err(), "a role missing");
        w.act(&owner, Body::RoleOrder { ids: roles(&["everyone", "admin", "moderator"]) }).unwrap();
        assert_eq!(w.roster.roles()[2].id.0, "moderator");

        let mut renamed = w.role("everyone");
        renamed.name = "Все-все".into();
        assert!(w.act(&owner, Body::RoleUpdate(renamed)).is_err());
        let mut quieter = w.role("everyone");
        quieter.permissions = Permissions::of(&[P::Connect]);
        w.act(&owner, Body::RoleUpdate(quieter)).unwrap();
        assert_eq!(w.role("everyone").permissions, Permissions::of(&[P::Connect]));
    }

    #[test]
    fn member_roles_respect_hierarchy() {
        let mut w = world();
        let owner = w.owner();
        let admin = w.add_member(2, &["admin"]);
        let moderator = w.add_member(3, &["moderator"]);
        let member = w.add_member(4, &[]);
        let give = |user: &Identity, with: &[&str]| Body::MemberRoles { user: uid(user), roles: roles(with) };

        assert!(w.act(&moderator, give(&member, &[])).is_err(), "no manage_roles");
        let mut with_roles = w.role("moderator");
        with_roles.permissions.0.insert(P::ManageRoles);
        w.act(&admin, Body::RoleUpdate(with_roles)).unwrap();

        assert!(w.act(&moderator, give(&member, &["moderator"])).is_err(), "a role not below yours");
        assert!(w.act(&moderator, give(&admin, &[])).is_err(), "someone above you");
        assert!(w.act(&admin, give(&owner, &["admin"])).is_err(), "the owner");
        assert!(w.act(&admin, give(&member, &["everyone"])).is_err(), "@все is implicit");
        assert!(w.act(&admin, give(&member, &["nope"])).is_err(), "unknown role");
        w.act(&admin, give(&member, &["moderator"])).unwrap();
        assert_eq!(w.roster.member(&uid(&member)).unwrap().roles, roles(&["moderator"]));
        w.act(&moderator, give(&moderator, &[])).unwrap();
        assert_eq!(w.roster.rank_of(&uid(&moderator)), 0, "you may drop your own roles");
    }

    #[test]
    fn deleting_a_role_removes_it_from_members_and_invites() {
        let mut w = world();
        let owner = w.owner();
        w.act(&owner, Body::RoleCreate(def("dj", "Диджей", &[P::Speak]))).unwrap();
        let member = w.add_member(2, &["dj"]);
        let invite = w.invite(&owner, roles(&["dj"]));
        w.act(&owner, Body::RoleDelete { id: role("dj") }).unwrap();
        assert_eq!(w.roster.member(&uid(&member)).unwrap().roles, Vec::<RoleId>::new());
        assert_eq!(w.roster.invite(&invite.public()).unwrap().roles, Vec::<RoleId>::new());
        assert!(w.roster.roles().iter().all(|r| r.id.0 != "dj"));
    }

    #[test]
    fn invites_grant_only_roles_below_the_creator() {
        let mut w = world();
        let admin = w.add_member(2, &["admin"]);
        let moderator = w.add_member(3, &["moderator"]);
        let invite = |with: &[&str]| Body::InviteCreate {
            invite: Identity::generate().unwrap().public(),
            roles: roles(with),
            max_uses: Some(1),
            expires_at: Some(T0 + 60),
        };
        assert!(w.act(&admin, invite(&["admin"])).is_err(), "own top role");
        assert!(w.act(&admin, invite(&["everyone"])).is_err());
        assert!(w.act(&admin, invite(&["ghost"])).is_err());
        assert!(w.act(&moderator, invite(&[])).is_err(), "moderators do not invite by default");
        w.act(&admin, invite(&["moderator"])).unwrap();
        let bad_uses = Body::InviteCreate { invite: id(40).public(), roles: vec![], max_uses: Some(0), expires_at: None };
        assert!(w.act(&admin, bad_uses).is_err());
        let past = Body::InviteCreate { invite: id(41).public(), roles: vec![], max_uses: None, expires_at: Some(T0) };
        assert!(w.act(&admin, past).is_err());
    }

    #[test]
    fn joined_members_get_the_invites_roles() {
        let mut w = world();
        let member = w.add_member(2, &["moderator"]);
        assert_eq!(w.roster.member(&uid(&member)).unwrap().roles, roles(&["moderator"]));
        assert_eq!(w.roster.member(&uid(&member)).unwrap().key, member.public());
    }

    #[test]
    fn unlimited_and_never_expiring_invites() {
        let mut w = world();
        let owner = w.owner();
        let open = w.invite_with(&owner, vec![], None, None);
        for n in 10..40 {
            w.join(&id(n), &open).unwrap();
        }
        w.join_at(&id(50), &open, T0 + 365 * 86_400).unwrap();
        assert_eq!(w.roster.invite(&open.public()).unwrap().uses, 31);
    }

    #[test]
    fn strangers_cannot_act() {
        let mut w = world();
        let body = Body::InviteCreate { invite: id(50).public(), roles: vec![], max_uses: Some(1), expires_at: None };
        assert!(w.act(&id(77), body).is_err());
    }

    #[test]
    fn tampered_entries_are_rejected() {
        let mut w = world();
        let owner = w.owner();
        let invite = Identity::generate().unwrap();
        let body = |max_uses| Body::InviteCreate { invite: invite.public(), roles: vec![], max_uses: Some(max_uses), expires_at: None };
        let mut entry = sign_entry(&w.roster, &owner, T0, body(1));
        entry.body = body(999);
        assert!(w.roster.apply(entry).is_err());
        assert_eq!(w.roster.len(), 1, "a rejected entry must not change the roster");
    }

    #[test]
    fn wrong_sequence_or_previous_hash_is_rejected() {
        let mut w = world();
        let owner = w.owner();
        let revoke = Body::InviteRevoke { invite: id(9).public() };
        let mut entry = sign_entry(&w.roster, &owner, T0, revoke.clone());
        entry.seq = 5;
        assert!(w.roster.apply(entry).is_err());

        let mut forked = sign_entry(&w.roster, &owner, T0, revoke);
        forked.prev = Digest([9; 32]);
        assert!(w.roster.apply(forked).is_err());
    }

    #[test]
    fn join_without_the_invite_key_is_rejected_so_the_server_cannot_add_ghosts() {
        let mut w = world();
        let owner = w.owner();
        let invite = w.invite_with(&owner, vec![], Some(5), None);
        let ghost = id(3);

        let mut entry = sign_join(&w.roster, &ghost, &id(4), T0 + 20);
        entry.body = Body::Join { user: ghost.public(), invite: invite.public() };
        assert!(w.roster.apply(entry).is_err(), "signed by a key that is not the invite");

        let mut entry = sign_join(&w.roster, &ghost, &invite, T0 + 20);
        entry.invite_signature = None;
        assert!(w.roster.apply(entry).is_err(), "no invite signature");

        let mut entry = sign_join(&w.roster, &ghost, &invite, T0 + 20);
        entry.body = Body::Join { user: id(5).public(), invite: invite.public() };
        assert!(w.roster.apply(entry).is_err(), "not signed by the user it adds");
    }

    #[test]
    fn invites_respect_use_limit_expiry_and_revocation() {
        let mut w = world();
        let owner = w.owner();
        let once = w.invite(&owner, vec![]);
        w.join(&id(2), &once).unwrap();
        assert!(w.join(&id(3), &once).is_err(), "single-use invite used twice");

        let expiring = w.invite_with(&owner, vec![], Some(5), Some(T0 + 3600));
        assert!(w.join_at(&id(4), &expiring, T0 + 3600).is_err(), "joined at expiry time");

        let revoked = w.invite_with(&owner, vec![], Some(5), None);
        w.act(&owner, Body::InviteRevoke { invite: revoked.public() }).unwrap();
        assert!(w.join(&id(5), &revoked).is_err());

        assert!(w.join(&id(6), &Identity::generate().unwrap()).is_err(), "unknown invite");
    }

    #[test]
    fn members_cannot_join_twice() {
        let mut w = world();
        let owner = w.owner();
        let invite = w.invite_with(&owner, vec![], Some(5), None);
        w.join(&id(2), &invite).unwrap();
        assert!(w.join(&id(2), &invite).is_err());
    }

    #[test]
    fn replaying_the_chain_gives_the_same_state_and_detects_tampering() {
        let mut w = world();
        let member = w.add_member(2, &[]);
        let owner = w.owner();
        w.act(&owner, Body::MemberRoles { user: uid(&member), roles: roles(&["admin"]) }).unwrap();

        let replayed = Roster::from_entries(w.roster.entries().to_vec()).unwrap();
        assert_eq!(replayed.head(), w.roster.head());
        assert_eq!(replayed.member(&uid(&member)).unwrap().roles, roles(&["admin"]));

        let mut entries = w.roster.entries().to_vec();
        entries[1].at += 1;
        assert!(Roster::from_entries(entries).is_err());

        let mut entries = w.roster.entries().to_vec();
        entries.remove(1);
        assert!(Roster::from_entries(entries).is_err(), "a dropped entry breaks the chain");
    }

    #[test]
    fn entries_survive_json() {
        let mut w = world();
        let owner = w.owner();
        w.act(&owner, Body::RoleCreate(def("dj", "Диджей", &[P::Speak]))).unwrap();
        let json = serde_json::to_string(w.roster.entries()).unwrap();
        let back: Vec<Entry> = serde_json::from_str(&json).unwrap();
        assert_eq!(Roster::from_entries(back).unwrap().head(), w.roster.head());
    }

    fn gif() -> MediaRef {
        MediaRef { sha256: "ab".repeat(32), mime: "image/gif".into(), size: 1024 }
    }

    fn kick(user: &Identity, reason: &str) -> Body {
        Body::Kick { user: uid(user), reason: reason.into(), media: Some(gif()) }
    }

    fn ban(user: &Identity, until: Option<u64>) -> Body {
        Body::Ban { user: uid(user), until, reason: "Спам".into(), media: None }
    }

    #[test]
    fn kick_needs_the_right_and_a_higher_rank() {
        let mut w = world();
        let owner = w.owner();
        let admin = w.add_member(2, &["admin"]);
        let other_admin = w.add_member(3, &["admin"]);
        let moderator = w.add_member(4, &["moderator"]);
        let member = w.add_member(5, &[]);

        assert!(w.act(&moderator, kick(&member, "")).is_err(), "moderators can't kick by default");
        assert!(w.act(&admin, kick(&owner, "")).is_err(), "the owner is untouchable");
        assert!(w.act(&admin, kick(&other_admin, "")).is_err(), "equal rank");
        assert!(w.act(&admin, kick(&id(60), "")).is_err(), "not a member");
        w.act(&admin, kick(&member, "Шумел")).unwrap();
        assert!(w.roster.member(&uid(&member)).is_none());
        w.act(&owner, kick(&other_admin, "")).unwrap();
    }

    #[test]
    fn kicked_users_come_back_only_with_a_new_invite() {
        let mut w = world();
        let owner = w.owner();
        let invite = w.invite_with(&owner, vec![], Some(5), None);
        let member = id(2);
        w.join(&member, &invite).unwrap();
        w.act(&owner, kick(&member, "")).unwrap();
        assert!(w.roster.member(&uid(&member)).is_none());
        let again = w.join(&member, &invite).unwrap_err();
        assert_eq!(again.0, "Это приглашение ты уже использовал — попроси новое");
        assert!(w.roster.member(&uid(&member)).is_none(), "the shared link does not undo the kick");

        let fresh = w.invite_with(&owner, vec![], Some(1), None);
        w.join(&member, &fresh).unwrap();
        assert!(w.roster.member(&uid(&member)).is_some());
        w.join(&id(3), &invite).unwrap();
        assert!(w.roster.member(&uid(&id(3))).is_some(), "others still use the old link");
    }

    #[test]
    fn ban_until_a_date_expires_on_its_own() {
        let mut w = world();
        let owner = w.owner();
        let member = w.add_member(2, &[]);
        w.act(&owner, ban(&member, Some(T0 + 86_400))).unwrap();
        assert!(w.roster.member(&uid(&member)).is_none());
        assert!(w.roster.is_banned_at(&uid(&member), T0 + 100));
        assert!(!w.roster.is_banned_at(&uid(&member), T0 + 86_401));

        let invite = w.invite_with(&owner, vec![], Some(5), None);
        assert!(w.join_at(&member, &invite, T0 + 100).is_err(), "still banned");
        w.join_at(&member, &invite, T0 + 86_401).unwrap();
    }

    #[test]
    fn a_ban_for_ever_blocks_every_invite_until_unbanned() {
        let mut w = world();
        let owner = w.owner();
        let member = w.add_member(2, &[]);
        w.act(&owner, ban(&member, None)).unwrap();
        let invite = w.invite_with(&owner, vec![], Some(5), None);
        assert!(w.join_at(&member, &invite, T0 + 10 * 365 * 86_400).is_err());
        w.act(&owner, Body::Unban { user: uid(&member) }).unwrap();
        w.join(&member, &invite).unwrap();
        assert!(w.act(&owner, ban(&member, Some(T0))).is_err(), "a ban ending in the past");
    }

    #[test]
    fn ban_keeps_reason_media_and_author() {
        let mut w = world();
        let admin = w.add_member(2, &["admin"]);
        let member = w.add_member(3, &[]);
        let body = Body::Ban { user: uid(&member), until: None, reason: "  Читы  ".into(), media: Some(gif()) };
        w.act(&admin, body).unwrap();
        let info = w.roster.ban(&uid(&member)).unwrap();
        assert_eq!(info.by, uid(&admin));
        assert_eq!(info.reason, "Читы");
        assert_eq!(info.media, Some(gif()));
        assert_eq!(info.at, T0 + 30);
        assert_eq!(w.roster.bans().count(), 1);
        // Someone who never joined can be banned in advance.
        w.act(&admin, ban(&id(60), None)).unwrap();
        assert!(w.act(&admin, ban(&admin, None)).is_err(), "not yourself");
    }

    #[test]
    fn unban_needs_ban_members() {
        let mut w = world();
        let owner = w.owner();
        let moderator = w.add_member(2, &["moderator"]);
        let member = w.add_member(3, &[]);
        w.act(&owner, ban(&member, None)).unwrap();
        assert!(w.act(&moderator, Body::Unban { user: uid(&member) }).is_err());
        assert!(w.act(&owner, Body::Unban { user: uid(&id(70)) }).is_err(), "not banned");
        w.act(&owner, Body::Unban { user: uid(&member) }).unwrap();
        assert!(w.roster.ban(&uid(&member)).is_none());
    }

    #[test]
    fn reasons_are_limited_to_200_chars_and_media_must_look_valid() {
        let mut w = world();
        let owner = w.owner();
        let member = w.add_member(2, &[]);
        assert!(w.act(&owner, kick(&member, &"я".repeat(201))).is_err());
        let with = |media: MediaRef| Body::Kick { user: uid(&member), reason: String::new(), media: Some(media) };
        assert!(w.act(&owner, with(MediaRef { sha256: "xyz".into(), ..gif() })).is_err(), "not a hash");
        assert!(w.act(&owner, with(MediaRef { size: 0, ..gif() })).is_err(), "empty file");
        assert!(w.act(&owner, with(MediaRef { size: 9 * 1024 * 1024, ..gif() })).is_err(), "over 8 MB");
        assert!(w.act(&owner, with(MediaRef { mime: "application/x-msdownload".into(), ..gif() })).is_err());
        w.act(&owner, kick(&member, &"я".repeat(200))).unwrap();
    }

    #[test]
    fn leave_removes_yourself_but_the_owner_cannot_leave() {
        let mut w = world();
        let owner = w.owner();
        let member = w.add_member(2, &[]);
        w.act(&member, Body::Leave).unwrap();
        assert!(w.roster.member(&uid(&member)).is_none());
        assert!(w.act(&owner, Body::Leave).is_err());
        assert!(w.act(&member, Body::Leave).is_err(), "no longer a member");
    }

    #[test]
    fn owner_transfer_moves_all_rights() {
        let mut w = world();
        let owner = w.owner();
        let admin = w.add_member(2, &["admin"]);
        assert!(w.act(&admin, Body::OwnerTransfer { to: uid(&admin) }).is_err(), "only the owner");
        assert!(w.act(&owner, Body::OwnerTransfer { to: uid(&id(60)) }).is_err(), "not a member");
        assert!(w.act(&owner, Body::OwnerTransfer { to: uid(&owner) }).is_err(), "already the owner");
        w.act(&owner, Body::OwnerTransfer { to: uid(&admin) }).unwrap();
        assert_eq!(w.roster.owner(), Some(admin.public()));
        assert_eq!(w.roster.rank_of(&uid(&admin)), u32::MAX);
        assert_eq!(w.roster.member(&uid(&owner)).unwrap().roles, roles(&["admin"]));
        assert!(w.roster.outranks(&uid(&admin), &uid(&owner)));
        assert!(w.act(&owner, Body::Leave).is_ok(), "the old owner may leave now");
    }

    #[test]
    fn history_days_takes_only_the_four_values() {
        let mut w = world();
        let owner = w.owner();
        assert_eq!(w.roster.settings().history_days, 30, "a month by default");
        let old: ServerSettings = serde_json::from_str(r#"{"afk_channel":null,"afk_minutes":15}"#).unwrap();
        assert_eq!(old.history_days, 30, "an entry from before the field");
        let days = |history_days| Body::ServerSettings(ServerSettings { history_days, ..ServerSettings::default() });
        assert_eq!(w.act(&owner, days(14)).unwrap_err(), RosterError("История для новичков: не передавать, 7, 30 или 90 дней".into()));
        for good in HISTORY_DAYS {
            w.act(&owner, days(good)).unwrap();
            assert_eq!(w.roster.settings().history_days, good);
        }
    }

    #[test]
    fn server_profile_and_settings_need_manage_server() {
        let mut w = world();
        let owner = w.owner();
        let moderator = w.add_member(2, &["moderator"]);
        let profile = |name: &str, description: &str| {
            Body::ServerProfile(ServerProfile {
                name: name.into(),
                description: description.into(),
                welcome: "Привет!".into(),
                icon: None,
            })
        };
        assert!(w.act(&moderator, profile("Новая хата", "")).is_err());
        assert!(w.act(&owner, profile("", "")).is_err());
        assert!(w.act(&owner, profile(&"я".repeat(65), "")).is_err());
        assert!(w.act(&owner, profile("Хата", &"я".repeat(501))).is_err());
        w.act(&owner, profile("Новая хата", "Для своих")).unwrap();
        assert_eq!(w.roster.server_name(), "Новая хата");
        assert_eq!(w.roster.profile().welcome, "Привет!");

        let settings = |afk_minutes| Body::ServerSettings(ServerSettings { afk_channel: None, afk_minutes, ..ServerSettings::default() });
        assert!(w.act(&moderator, settings(15)).is_err());
        assert!(w.act(&owner, settings(7)).is_err(), "only 0, 5, 15, 30 or 60");
        w.act(&owner, settings(15)).unwrap();
        assert_eq!(w.roster.settings().afk_minutes, 15);
    }

    use crate::perms::{ChannelDef, ChannelOverride, Tri};

    fn channel(id: &str, name: &str) -> ChannelDef {
        ChannelDef { id: id.into(), name: name.into(), user_limit: 0, overrides: Vec::new(), kind: Default::default() }
    }

    fn deny_view(role_id: &str) -> ChannelOverride {
        ChannelOverride { role: role(role_id), view: Tri::Deny, connect: Tri::Inherit, speak: Tri::Inherit }
    }

    #[test]
    fn channels_need_manage_channels() {
        let mut w = world();
        let owner = w.owner();
        let moderator = w.add_member(2, &["moderator"]);
        assert!(w.act(&moderator, Body::ChannelCreate(channel("general", "Общий"))).is_err());
        w.act(&owner, Body::ChannelCreate(channel("general", "Общий"))).unwrap();
        w.act(&owner, Body::ChannelCreate(channel("games", "Игры"))).unwrap();
        let ids: Vec<&str> = w.roster.channels().iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["general", "games"]);
        assert!(w.act(&owner, Body::ChannelCreate(channel("games", "Ещё"))).is_err(), "duplicate id");

        let mut renamed = channel("games", "Игрушки");
        renamed.user_limit = 8;
        w.act(&owner, Body::ChannelUpdate(renamed)).unwrap();
        assert_eq!(w.roster.channels()[1].name, "Игрушки");
        assert_eq!(w.roster.channels()[1].user_limit, 8);
        assert!(w.act(&owner, Body::ChannelUpdate(channel("nope", "Нет"))).is_err());

        w.act(&owner, Body::ChannelDelete { id: "general".into() }).unwrap();
        assert_eq!(w.roster.channels().len(), 1);
        assert!(w.act(&owner, Body::ChannelDelete { id: "general".into() }).is_err());
    }

    #[test]
    fn a_text_channel_is_kept_as_one() {
        let mut w = world();
        let owner = w.owner();
        let mut chat = channel("chat", "Болталка");
        chat.kind = crate::perms::ChannelKind::Text;
        w.act(&owner, Body::ChannelCreate(chat)).unwrap();
        w.act(&owner, Body::ChannelCreate(channel("general", "Общий"))).unwrap();
        let kinds: Vec<_> = w.roster.channels().iter().map(|c| (c.id.as_str(), c.kind)).collect();
        assert_eq!(kinds, [("chat", crate::perms::ChannelKind::Text), ("general", crate::perms::ChannelKind::Voice)]);
    }

    #[test]
    fn channel_ids_and_names_are_validated() {
        let mut w = world();
        let owner = w.owner();
        let create = |id: &str, name: &str, limit: u32| {
            Body::ChannelCreate(ChannelDef { id: id.into(), name: name.into(), user_limit: limit, overrides: vec![], kind: Default::default() })
        };
        assert!(w.act(&owner, create("", "Общий", 0)).is_err());
        assert!(w.act(&owner, create("Общий", "Общий", 0)).is_err(), "latin id only");
        assert!(w.act(&owner, create(&"x".repeat(65), "Общий", 0)).is_err());
        assert!(w.act(&owner, create("general", "  ", 0)).is_err());
        assert!(w.act(&owner, create("general", &"я".repeat(33), 0)).is_err());
        assert!(w.act(&owner, create("general", "Общий", 100)).is_err(), "limit up to 99");
        let mut bad_override = channel("general", "Общий");
        bad_override.overrides = vec![deny_view("ghost")];
        assert!(w.act(&owner, Body::ChannelCreate(bad_override)).is_err(), "unknown role");
        w.act(&owner, create(&"x".repeat(64), "Общий", 99)).unwrap();
    }

    #[test]
    fn channel_overrides_touch_only_roles_below_yours() {
        let mut w = world();
        let owner = w.owner();
        let moderator = w.add_member(2, &["moderator"]);
        let mut with_channels = w.role("moderator");
        with_channels.permissions.0.insert(P::ManageChannels);
        w.act(&owner, Body::RoleUpdate(with_channels)).unwrap();

        let mut locked = channel("staff", "Админская");
        locked.overrides = vec![deny_view("admin")];
        assert!(w.act(&moderator, Body::ChannelCreate(locked)).is_err(), "would lock out admins");
        let mut hidden = channel("staff", "Админская");
        hidden.overrides = vec![deny_view("everyone")];
        w.act(&moderator, Body::ChannelCreate(hidden)).unwrap();
    }

    #[test]
    fn access_uses_the_members_roles_and_the_channel() {
        let mut w = world();
        let owner = w.owner();
        let mut hidden = channel("staff", "Админская");
        hidden.overrides = vec![deny_view("everyone"), ChannelOverride { role: role("admin"), view: Tri::Allow, connect: Tri::Inherit, speak: Tri::Inherit }];
        w.act(&owner, Body::ChannelCreate(hidden)).unwrap();
        let member = w.add_member(2, &[]);
        let admin = w.add_member(3, &["admin"]);
        assert!(!w.roster.access(&uid(&member), "staff").unwrap().view);
        assert!(w.roster.access(&uid(&admin), "staff").unwrap().connect);
        assert!(w.roster.access(&uid(&owner), "staff").unwrap().speak);
        assert!(w.roster.access(&uid(&member), "nope").is_none(), "no such channel");
        assert!(w.roster.access(&uid(&id(70)), "staff").is_none(), "not a member");
    }

    #[test]
    fn deleting_a_role_drops_its_channel_overrides() {
        let mut w = world();
        let owner = w.owner();
        w.act(&owner, Body::RoleCreate(def("dj", "Диджей", &[P::Speak]))).unwrap();
        let mut stage = channel("stage", "Трибуна");
        stage.overrides = vec![deny_view("dj")];
        w.act(&owner, Body::ChannelCreate(stage)).unwrap();
        w.act(&owner, Body::RoleDelete { id: role("dj") }).unwrap();
        assert!(w.roster.channels()[0].overrides.is_empty());
    }

    #[test]
    fn afk_channel_must_exist_and_goes_away_with_it() {
        let mut w = world();
        let owner = w.owner();
        let afk = |id: &str| Body::ServerSettings(ServerSettings { afk_channel: Some(id.into()), afk_minutes: 15, ..ServerSettings::default() });
        assert!(w.act(&owner, afk("away")).is_err());
        w.act(&owner, Body::ChannelCreate(channel("away", "Отошёл"))).unwrap();
        w.act(&owner, afk("away")).unwrap();
        w.act(&owner, Body::ChannelDelete { id: "away".into() }).unwrap();
        assert_eq!(w.roster.settings().afk_channel, None);
    }

    #[test]
    fn channel_order_must_list_every_channel_once() {
        let mut w = world();
        let owner = w.owner();
        for (id, name) in [("a", "А"), ("b", "Б"), ("c", "В")] {
            w.act(&owner, Body::ChannelCreate(channel(id, name))).unwrap();
        }
        let order = |ids: &[&str]| Body::ChannelOrder { ids: ids.iter().map(|s| s.to_string()).collect() };
        assert!(w.act(&owner, order(&["a", "b"])).is_err(), "missing one");
        assert!(w.act(&owner, order(&["a", "a", "b"])).is_err(), "twice");
        assert!(w.act(&owner, order(&["a", "b", "x"])).is_err(), "unknown");
        w.act(&owner, order(&["c", "a", "b"])).unwrap();
        let ids: Vec<&str> = w.roster.channels().iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["c", "a", "b"]);
    }
}
