//! The temporary group of one call: MLS (RFC 9420) with a post-quantum X-Wing ciphersuite.
//!
//! The group lives in memory only and is gone with the call. From each epoch every member derives, with the
//! group's exporter, a frame key per sender, and a short code the members can read out to each other.
//!
//! The server only relays opaque messages between members, so it must never be able to slip a listener in.
//! Everyone therefore checks, for every leaf that enters the group, that its credential is a [`CallCredential`]
//! of this call and channel signed by a person's identity key, and asks the caller whether that person may be in
//! the call at all. A leaf that fails is refused and the group is left as it was.
//!
//! Commits are made in two steps, because the server decides the order of commits: [`CallGroup::commit`] stages
//! one, then [`CallGroup::confirm`] applies it once the server accepted it, or [`CallGroup::discard`] drops it.
//! Others apply it with [`CallGroup::process`]. A commit that `process` refuses can't be processed again: the
//! group's key ratchet has already moved on, and the member has to join the call anew.

use std::fmt;

use hv_roster::keys::sha256;
use hv_roster::{Identity, UserId};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::{
    BasicCredential, Ciphersuite, CommitMessageBundle, Credential, CredentialWithKey, GroupId, KeyPackage,
    KeyPackageIn, LeafNode, LeafNodeIndex, Lifetime, MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig,
    MlsMessageBodyIn, MlsMessageIn, OpenMlsProvider, PURE_CIPHERTEXT_WIRE_FORMAT_POLICY, ProcessedMessageContent,
    Proposal, ProtocolVersion, Sender, SignatureScheme, StagedCommit, StagedWelcome,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_libcrux_crypto::Provider;

use crate::CallError;
use crate::code::{KEYRING, MEDIA_LABEL, call_code, media_context};
use crate::credential::CallCredential;

pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519;

/// The context of the server's own group (its chat), in place of a channel id. Channel ids are `[a-z0-9-]` only,
/// so no call's leaf can be taken for a leaf of the server group, nor the other way round.
pub const SERVER_CONTEXT: &str = "@server";

/// Decides whether a person may be in this call (a member of the roster, not banned, allowed to connect).
pub type Admit<'a> = &'a dyn Fn(&UserId) -> bool;

/// The frame key of one sender in the current epoch.
#[derive(Clone, PartialEq, Eq)]
pub struct MediaKey {
    pub user: UserId,
    /// The slot in the media key ring: `epoch % KEYRING`.
    pub index: u8,
    pub key: [u8; 32],
}

// The key must not end up in a log by accident.
impl fmt::Debug for MediaKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaKey").field("user", &self.user).field("index", &self.index).finish_non_exhaustive()
    }
}

/// A staged commit, ready to go to the server.
#[derive(Debug, Clone)]
pub struct Outgoing {
    /// The epoch the commit starts from; the group is in the next one once it is confirmed.
    pub epoch: u64,
    pub commit: Vec<u8>,
    /// For the people added by this commit.
    pub welcome: Option<Vec<u8>>,
    pub welcome_to: Vec<UserId>,
    /// Who is in the group after the commit, by leaf.
    pub members: Vec<UserId>,
}

/// The call group of one member.
pub struct CallGroup {
    group: MlsGroup,
    provider: Provider,
    signer: SignatureKeyPair,
    id: [u8; 16],
    channel: String,
    me: UserId,
}

/// Someone who asked to join a call and waits for the welcome.
pub struct Joiner {
    provider: Provider,
    signer: SignatureKeyPair,
    /// The reference of the KeyPackage we sent: a welcome made for it names it.
    key_ref: Vec<u8>,
    id: [u8; 16],
    channel: String,
    me: UserId,
}

impl fmt::Debug for CallGroup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallGroup")
            .field("channel", &self.channel)
            .field("epoch", &self.epoch())
            .field("me", &self.me)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for Joiner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Joiner").field("channel", &self.channel).field("me", &self.me).finish_non_exhaustive()
    }
}

fn mls(error: impl fmt::Display) -> CallError {
    CallError::Mls(error.to_string())
}

fn bad(why: &str) -> CallError {
    CallError::BadCredential(why.into())
}

/// The exporter label of [`CallGroup::signal_key`].
const SIGNAL_LABEL: &str = "HataVoice signal v1";

/// The start of every group snapshot.
const SNAPSHOT_MAGIC: &[u8] = b"HVGS1";

fn broken() -> CallError {
    mls("broken group snapshot")
}

/// Reads a snapshot field by field: running short is an error, never a panic.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], CallError> {
        if self.bytes.len() < n {
            return Err(broken());
        }
        let (head, rest) = self.bytes.split_at(n);
        self.bytes = rest;
        Ok(head)
    }

    fn u64(&mut self) -> Result<u64, CallError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().map_err(|_| broken())?))
    }

    fn len(&mut self) -> Result<usize, CallError> {
        usize::try_from(self.u64()?).map_err(|_| broken())
    }

    /// One length byte, then UTF-8.
    fn text(&mut self) -> Result<String, CallError> {
        let len = usize::from(self.take(1)?[0]);
        String::from_utf8(self.take(len)?.to_vec()).map_err(|_| broken())
    }
}

/// Leaves never expire: the lifetime in a KeyPackage is checked against the local clock, and a friend's clock
/// may be years off. A KeyPackage is made for one join, and the call group is gone with the call.
fn forever() -> Lifetime {
    Lifetime::init(0, u64::MAX)
}

fn create_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .lifetime(forever())
        .build()
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .build()
}

/// What a leaf needs to be in a call: a provider to keep its keys in, a signature key made for this call alone,
/// and the credential that ties that key to the person.
struct Leaf {
    provider: Provider,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
}

fn new_leaf(id: &Identity, group: [u8; 16], channel: &str) -> Result<Leaf, CallError> {
    if !(1..=64).contains(&channel.len()) {
        return Err(bad("channel id must be 1-64 bytes"));
    }
    let provider = Provider::new().map_err(mls)?;
    let signer = SignatureKeyPair::new(SignatureScheme::ED25519).map_err(mls)?;
    signer.store(provider.storage()).map_err(mls)?;
    let sig: [u8; 32] = signer.public().try_into().map_err(|_| mls("unexpected signature key size"))?;
    let credential = CallCredential::sign(id, group, channel, sig);
    let credential = CredentialWithKey {
        credential: BasicCredential::new(credential.to_bytes()).into(),
        signature_key: signer.public().into(),
    };
    Ok(Leaf { provider, signer, credential })
}

/// Starts the group of a call, with us as the only member.
pub fn create(id: &Identity, group: [u8; 16], channel: &str) -> Result<CallGroup, CallError> {
    let leaf = new_leaf(id, group, channel)?;
    let mls_group = MlsGroup::new_with_group_id(
        &leaf.provider,
        &leaf.signer,
        &create_config(),
        GroupId::from_slice(&group),
        leaf.credential,
    )
    .map_err(mls)?;
    Ok(CallGroup {
        group: mls_group,
        provider: leaf.provider,
        signer: leaf.signer,
        id: group,
        channel: channel.to_string(),
        me: id.public().user_id(),
    })
}

/// Asks to join the group of a call: the KeyPackage bytes go to a member, the [`Joiner`] waits for the welcome.
pub fn prepare_join(id: &Identity, group: [u8; 16], channel: &str) -> Result<(Joiner, Vec<u8>), CallError> {
    let leaf = new_leaf(id, group, channel)?;
    let bundle = KeyPackage::builder()
        .key_package_lifetime(forever())
        .build(CIPHERSUITE, &leaf.provider, &leaf.signer, leaf.credential)
        .map_err(mls)?;
    let key_package = bundle.key_package().tls_serialize_detached().map_err(mls)?;
    let key_ref = bundle.key_package().hash_ref(leaf.provider.crypto()).map_err(mls)?.as_slice().to_vec();
    let joiner = Joiner {
        provider: leaf.provider,
        signer: leaf.signer,
        key_ref,
        id: group,
        channel: channel.to_string(),
        me: id.public().user_id(),
    };
    Ok((joiner, key_package))
}

/// The call credential in a leaf's credential. It is only read here, not checked.
fn call_credential(credential: &Credential) -> Result<CallCredential, CallError> {
    let basic = BasicCredential::try_from(credential.clone()).map_err(|_| bad("not a basic credential"))?;
    CallCredential::from_bytes(basic.identity())
}

/// The person a leaf belongs to.
fn user_of(credential: &Credential) -> Result<UserId, CallError> {
    Ok(call_credential(credential)?.ik.user_id())
}

/// A leaf that is about to enter the group: its credential must be one of this call's, for the leaf's own
/// signature key, and the person must be allowed in.
fn admit_leaf(
    id: &[u8; 16],
    channel: &str,
    credential: &Credential,
    signature_key: &[u8],
    admit: Admit,
) -> Result<UserId, CallError> {
    let user = call_credential(credential)?.check(id, channel, signature_key)?;
    if admit(&user) { Ok(user) } else { Err(CallError::NotAdmitted(user)) }
}

/// The people in these leaves, in order. Nobody may be in a call twice: their frame keys would be ambiguous.
fn users_of<'a>(leaves: impl Iterator<Item = &'a LeafNode>) -> Result<Vec<UserId>, CallError> {
    let mut users: Vec<UserId> = Vec::new();
    for leaf in leaves {
        let user = user_of(leaf.credential())?;
        if users.contains(&user) {
            return Err(mls(format!("{user} has two leaves in the group")));
        }
        users.push(user);
    }
    Ok(users)
}

impl Joiner {
    /// Whether `message` is a welcome made for our KeyPackage. One made for a KeyPackage we sent before would use the
    /// joiner up for nothing: [`welcome`](Self::welcome) consumes it, whatever the outcome.
    pub fn fits(&self, message: &[u8]) -> bool {
        let Ok(message) = MlsMessageIn::tls_deserialize_exact(message) else { return false };
        let MlsMessageBodyIn::Welcome(welcome) = message.extract() else { return false };
        welcome.secrets().iter().any(|secret| secret.new_member().as_slice() == self.key_ref.as_slice())
    }

    /// Joins by the welcome a member made when it added us. Everyone in the group must be someone `admit` lets in.
    pub fn welcome(self, message: &[u8], admit: Admit) -> Result<CallGroup, CallError> {
        let MlsMessageBodyIn::Welcome(welcome) = MlsMessageIn::tls_deserialize_exact(message).map_err(mls)?.extract()
        else {
            return Err(mls("not a welcome"));
        };
        let staged = StagedWelcome::new_from_welcome(&self.provider, &join_config(), welcome, None).map_err(mls)?;
        if staged.group_context().group_id().as_slice() != self.id {
            return Err(bad("another call"));
        }
        if staged.group_context().ciphersuite() != CIPHERSUITE {
            return Err(mls("another ciphersuite"));
        }
        let mut users: Vec<UserId> = Vec::new();
        for member in staged.members() {
            let user = admit_leaf(&self.id, &self.channel, &member.credential, &member.signature_key, admit)?;
            if users.contains(&user) {
                return Err(mls(format!("{user} has two leaves in the group")));
            }
            users.push(user);
        }
        let group = staged.into_group(&self.provider).map_err(mls)?;
        Ok(CallGroup {
            group,
            provider: self.provider,
            signer: self.signer,
            id: self.id,
            channel: self.channel,
            me: self.me,
        })
    }
}

impl CallGroup {
    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    pub fn group_id(&self) -> [u8; 16] {
        self.id
    }

    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn me(&self) -> UserId {
        self.me.clone()
    }

    /// Who is in the group, by ascending leaf. Nobody once we have been removed.
    pub fn members(&self) -> Vec<UserId> {
        self.roster().into_iter().map(|(_, user)| user).collect()
    }

    /// False once a commit has removed us from the group.
    pub fn is_member(&self) -> bool {
        self.group.is_active()
    }

    /// Whether the leaf of this KeyPackage is in the group now, that is, someone added it. A person who has a leaf
    /// may still have asked to join anew with another KeyPackage: that one is not held.
    pub fn holds(&self, key_package: &[u8]) -> bool {
        let Ok(package) = KeyPackageIn::tls_deserialize_exact(key_package) else { return false };
        let Ok(package) = package.validate(self.provider.crypto(), ProtocolVersion::Mls10) else { return false };
        let key = package.leaf_node().signature_key().as_slice();
        self.group.is_active() && self.group.members().any(|member| member.signature_key == key)
    }

    fn roster(&self) -> Vec<(LeafNodeIndex, UserId)> {
        if !self.group.is_active() {
            return Vec::new();
        }
        self.group.members().filter_map(|member| Some((member.index, user_of(&member.credential).ok()?))).collect()
    }

    /// One commit: adds the people whose KeyPackages are given (someone who already has a leaf gets a new one in
    /// place of the old) and removes the people named. Everything is checked before anything is staged.
    ///
    /// The group stays in its epoch until [`confirm`](Self::confirm); [`discard`](Self::discard) drops the commit.
    /// Only one commit can wait at a time: until it is confirmed or discarded, this refuses.
    pub fn commit(&mut self, adds: &[Vec<u8>], removes: &[UserId], admit: Admit) -> Result<Outgoing, CallError> {
        if !self.group.is_active() {
            return Err(CallError::NotMember);
        }
        // Staging another commit would silently replace this one, which the server may already have accepted.
        if self.group.pending_commit().is_some() {
            return Err(mls("a commit is already waiting for the server"));
        }
        let roster = self.roster();

        let mut packages = Vec::with_capacity(adds.len());
        let mut added: Vec<UserId> = Vec::with_capacity(adds.len());
        for bytes in adds {
            let package = KeyPackageIn::tls_deserialize_exact(bytes)
                .map_err(mls)?
                .validate(self.provider.crypto(), ProtocolVersion::Mls10)
                .map_err(mls)?;
            if package.ciphersuite() != CIPHERSUITE {
                return Err(mls("key package of another ciphersuite"));
            }
            let leaf = package.leaf_node();
            let user = admit_leaf(&self.id, &self.channel, leaf.credential(), leaf.signature_key().as_slice(), admit)?;
            if user == self.me {
                return Err(mls("a member can't replace its own leaf"));
            }
            if added.contains(&user) {
                return Err(mls(format!("two key packages for {user}")));
            }
            added.push(user);
            packages.push(package);
        }

        // Those named, and those who come back with a new leaf.
        let mut leaving: Vec<LeafNodeIndex> = Vec::new();
        for user in removes {
            if *user == self.me {
                return Err(mls("a member can't remove itself"));
            }
            if !roster.iter().any(|(_, member)| member == user) {
                return Err(CallError::NotMember);
            }
        }
        for (index, member) in &roster {
            if (removes.contains(member) || added.contains(member)) && !leaving.contains(index) {
                leaving.push(*index);
            }
        }

        let epoch = self.epoch();
        let bundle = self
            .group
            .commit_builder()
            .consume_proposal_store(false)
            .propose_adds(packages)
            .propose_removals(leaving)
            .load_psks(self.provider.storage())
            .map_err(mls)?
            .build(self.provider.rand(), self.provider.crypto(), &self.signer, |_| true)
            .map_err(mls)?
            .stage_commit(&self.provider)
            .map_err(mls)?;

        let outgoing = self.outgoing(epoch, &bundle, added);
        if outgoing.is_err() {
            // Don't leave a commit nobody will ever see waiting in the group.
            let _ = self.discard();
        }
        outgoing
    }

    fn outgoing(
        &self,
        epoch: u64,
        bundle: &CommitMessageBundle,
        welcome_to: Vec<UserId>,
    ) -> Result<Outgoing, CallError> {
        let commit = bundle.commit().tls_serialize_detached().map_err(mls)?;
        let welcome = match bundle.to_welcome_msg() {
            Some(message) => Some(message.tls_serialize_detached().map_err(mls)?),
            None => None,
        };
        let staged = self.group.pending_commit().ok_or_else(|| mls("no commit was staged"))?;
        let tree = staged
            .export_ratchet_tree(self.provider.crypto(), self.group.export_ratchet_tree())
            .map_err(mls)?
            .ok_or_else(|| mls("the staged commit has no tree"))?;
        let members = users_of(tree.leaves())?;
        Ok(Outgoing { epoch, commit, welcome, welcome_to, members })
    }

    /// The server accepted our commit: the group moves to the next epoch.
    pub fn confirm(&mut self) -> Result<(), CallError> {
        if self.group.pending_commit().is_none() {
            return Err(mls("no commit to confirm"));
        }
        self.group.merge_pending_commit(&self.provider).map_err(mls)
    }

    /// The server refused our commit: the group stays as it was. Does nothing when no commit is staged.
    pub fn discard(&mut self) -> Result<(), CallError> {
        self.group.clear_pending_commit(self.provider.storage()).map_err(mls)
    }

    /// Applies a commit another member made. Every leaf it adds must be one of this call's and one `admit` lets in.
    /// After a refusal the group is in the epoch it was in, but the commit can't be tried again.
    pub fn process(&mut self, commit: &[u8], admit: Admit) -> Result<(), CallError> {
        if !self.group.is_active() {
            return Err(CallError::NotMember);
        }
        let message =
            MlsMessageIn::tls_deserialize_exact(commit).map_err(mls)?.try_into_protocol_message().map_err(mls)?;
        let processed = self.group.process_message(&self.provider, message).map_err(mls)?;
        let sender = processed.sender().clone();
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            return Err(mls("not a commit by another member"));
        };
        self.vet_commit(&sender, &staged, admit)?;
        self.group.merge_staged_commit(&self.provider, *staged).map_err(mls)
    }

    /// What a commit may do: add and remove members, with leaves that are fine, leaving nobody in twice.
    fn vet_commit(&self, sender: &Sender, staged: &StagedCommit, admit: Admit) -> Result<(), CallError> {
        let Sender::Member(committer) = sender else {
            return Err(mls("a commit from outside the group"));
        };
        if staged.queued_proposals().any(|queued| !matches!(queued.proposal(), Proposal::Add(_) | Proposal::Remove(_)))
        {
            return Err(mls("a call commit may only add and remove members"));
        }
        for add in staged.add_proposals() {
            let leaf = add.add_proposal().key_package().leaf_node();
            admit_leaf(&self.id, &self.channel, leaf.credential(), leaf.signature_key().as_slice(), admit)?;
        }
        // The committer's new leaf: still the same person, with a credential for its own signature key.
        if let Some(leaf) = staged.update_path_leaf_node() {
            let user =
                call_credential(leaf.credential())?.check(&self.id, &self.channel, leaf.signature_key().as_slice())?;
            let current = self.group.member(*committer).ok_or_else(|| mls("the committer has no leaf"))?;
            if user != user_of(current)? {
                return Err(bad("the committer changed who it is"));
            }
        }
        // A commit that removes us leaves no tree for us to look at.
        if let Some(tree) =
            staged.export_ratchet_tree(self.provider.crypto(), self.group.export_ratchet_tree()).map_err(mls)?
        {
            users_of(tree.leaves())?;
        }
        Ok(())
    }

    /// A key every member has in the current epoch, for signals the server passes on without keeping («печатает…»):
    /// they spend nothing of the group's message ratchets. It changes with every epoch.
    pub fn signal_key(&self) -> Result<[u8; 32], CallError> {
        let key = self.group.export_secret(self.provider.crypto(), SIGNAL_LABEL, &self.epoch().to_be_bytes(), 32).map_err(mls)?;
        key.try_into().map_err(|_| mls("unexpected signal key size"))
    }

    /// The frame key of every member in the current epoch, ours included. Empty once we have been removed.
    pub fn media_keys(&self) -> Vec<MediaKey> {
        let epoch = self.epoch();
        // Always below 16.
        let index = (epoch % KEYRING) as u8;
        self.roster()
            .into_iter()
            .filter_map(|(leaf, user)| {
                let key = self
                    .group
                    .export_secret(self.provider.crypto(), MEDIA_LABEL, &media_context(leaf.u32(), epoch), 32)
                    .ok()?;
                Some(MediaKey { user, index, key: key.try_into().ok()? })
            })
            .collect()
    }

    /// Everything needed to go on with this group after a restart: its id, context, our user id, our leaf's
    /// signature key and the whole key store, sorted so one state always gives the same bytes, after the SHA-256 of
    /// all that. It holds every secret of the group: whoever stores it must keep it encrypted. Refused while one of
    /// our commits waits for the server.
    pub fn snapshot(&self) -> Result<Vec<u8>, CallError> {
        if self.group.pending_commit().is_some() {
            return Err(mls("a commit is waiting for the server"));
        }
        let mut out = Vec::new();
        out.extend_from_slice(&self.id);
        for text in [self.channel.as_str(), self.me.0.as_str()] {
            out.push(u8::try_from(text.len()).map_err(|_| mls("context or user id too long"))?);
            out.extend_from_slice(text.as_bytes());
        }
        let key: [u8; 32] = self.signer.public().try_into().map_err(|_| mls("unexpected signature key size"))?;
        out.extend_from_slice(&key);
        let values = self.provider.storage().values.read().map_err(|_| mls("the key store is poisoned"))?;
        let mut entries: Vec<_> = values.iter().collect();
        entries.sort();
        out.extend_from_slice(&(entries.len() as u64).to_be_bytes());
        for (key, value) in entries {
            out.extend_from_slice(&(key.len() as u64).to_be_bytes());
            out.extend_from_slice(&(value.len() as u64).to_be_bytes());
            out.extend_from_slice(key);
            out.extend_from_slice(value);
        }
        let mut snapshot = SNAPSHOT_MAGIC.to_vec();
        snapshot.extend_from_slice(&sha256(&out));
        snapshot.extend_from_slice(&out);
        Ok(snapshot)
    }

    /// The group as [`snapshot`](Self::snapshot) left it. Anything short, long, out of shape or changed is refused:
    /// OpenMLS's key store panics on a stored value it cannot read, so only the exact bytes once written get to it.
    pub fn restore(bytes: &[u8]) -> Result<CallGroup, CallError> {
        let mut reader = Reader { bytes };
        if reader.take(SNAPSHOT_MAGIC.len())? != SNAPSHOT_MAGIC {
            return Err(broken());
        }
        let digest = reader.take(32)?;
        if sha256(reader.bytes).as_slice() != digest {
            return Err(broken());
        }
        let id: [u8; 16] = reader.take(16)?.try_into().map_err(|_| broken())?;
        let channel = reader.text()?;
        let me = UserId(reader.text()?);
        let key = reader.take(32)?.to_vec();
        let count = reader.u64()?;
        let provider = Provider::new().map_err(mls)?;
        {
            let mut values = provider.storage().values.write().map_err(|_| mls("the key store is poisoned"))?;
            for _ in 0..count {
                let (key_len, value_len) = (reader.len()?, reader.len()?);
                let (key, value) = (reader.take(key_len)?.to_vec(), reader.take(value_len)?.to_vec());
                values.insert(key, value);
            }
        }
        if !reader.bytes.is_empty() {
            return Err(broken());
        }
        let signer = SignatureKeyPair::read(provider.storage(), &key, SignatureScheme::ED25519).ok_or_else(broken)?;
        let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(&id)).map_err(mls)?.ok_or_else(broken)?;
        Ok(CallGroup { group, provider, signer, id, channel, me })
    }

    /// `plaintext` as a message only the group can read, in the current epoch.
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, CallError> {
        if !self.group.is_active() {
            return Err(CallError::NotMember);
        }
        let message = self.group.create_message(&self.provider, &self.signer, plaintext).map_err(mls)?;
        message.tls_serialize_detached().map_err(mls)
    }

    /// Reads another member's message: who sent it (by their leaf) and what it says. Only a message of the current
    /// epoch is read; a commit, or a message of another epoch, is refused.
    pub fn decrypt(&mut self, message: &[u8]) -> Result<(UserId, Vec<u8>), CallError> {
        if !self.group.is_active() {
            return Err(CallError::NotMember);
        }
        let message =
            MlsMessageIn::tls_deserialize_exact(message).map_err(mls)?.try_into_protocol_message().map_err(mls)?;
        let processed = self.group.process_message(&self.provider, message).map_err(mls)?;
        let Sender::Member(index) = processed.sender().clone() else {
            return Err(mls("a message from outside the group"));
        };
        let ProcessedMessageContent::ApplicationMessage(content) = processed.into_content() else {
            return Err(mls("not a message"));
        };
        let sender = self.group.member(index).ok_or_else(|| mls("the sender has no leaf"))?;
        Ok((user_of(sender)?, content.into_bytes()))
    }

    /// The code members read out to each other. Empty once we have been removed.
    pub fn code(&self) -> String {
        if !self.group.is_active() {
            return String::new();
        }
        call_code(self.group.epoch_authenticator().as_slice())
    }
}

#[cfg(test)]
mod tests {
    use hv_roster::{Identity, UserId};
    use openmls::prelude::{
        BasicCredential, CommitBuilder, CredentialWithKey, Initial, KeyPackage, KeyPackageIn, MlsMessageBodyIn,
        MlsMessageIn, NewSignerBundle, OpenMlsProvider, ProtocolVersion, SignatureScheme,
    };
    use openmls_basic_credential::SignatureKeyPair;
    use openmls_libcrux_crypto::Provider;

    use super::*;
    use crate::CallError;
    use crate::credential::CallCredential;

    const GROUP: [u8; 16] = [7; 16];
    const CHANNEL: &str = "general";

    fn admit_all(_: &UserId) -> bool {
        true
    }

    fn person(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn user(n: u8) -> UserId {
        person(n).public().user_id()
    }

    fn creator(n: u8) -> CallGroup {
        create(&person(n), GROUP, CHANNEL).unwrap()
    }

    /// Person `n` joins the call: the inviter commits, confirms, and the newcomer joins by the welcome.
    fn invite(inviter: &mut CallGroup, n: u8) -> (CallGroup, Outgoing) {
        let (joiner, key_package) = prepare_join(&person(n), GROUP, CHANNEL).unwrap();
        let out = inviter.commit(&[key_package], &[], &admit_all).unwrap();
        inviter.confirm().unwrap();
        let joined = joiner.welcome(out.welcome.as_ref().expect("a welcome for the newcomer"), &admit_all).unwrap();
        (joined, out)
    }

    /// A KeyPackage anyone could make, whose credential bytes the test chooses (given the leaf's signature key).
    fn key_package_with(identity: impl FnOnce(&[u8]) -> Vec<u8>) -> Vec<u8> {
        let provider = Provider::new().unwrap();
        let signer = SignatureKeyPair::new(SignatureScheme::ED25519).unwrap();
        signer.store(provider.storage()).unwrap();
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity(signer.public())).into(),
            signature_key: signer.public().into(),
        };
        KeyPackage::builder()
            .key_package_lifetime(forever())
            .build(CIPHERSUITE, &provider, &signer, credential)
            .unwrap()
            .key_package()
            .tls_serialize_detached()
            .unwrap()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|window| window == needle)
    }

    #[test]
    fn a_key_package_is_held_once_its_leaf_is_in_the_group() {
        let mut a = creator(1);
        let (joiner, first) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        assert!(!a.holds(&first), "asked, not added");
        a.commit(std::slice::from_ref(&first), &[], &admit_all).unwrap();
        assert!(!a.holds(&first), "staged, not yet accepted");
        a.confirm().unwrap();
        assert!(a.holds(&first));
        drop(joiner);

        // The same person asks again (restarted): its new KeyPackage is not the leaf in the group.
        let (_, again) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        assert!(!a.holds(&again));
        assert!(!a.holds(b"not a key package"));
        a.commit(std::slice::from_ref(&again), &[], &admit_all).unwrap();
        a.confirm().unwrap();
        assert!(a.holds(&again) && !a.holds(&first), "the new leaf took the old one's place");
    }

    #[test]
    fn members_share_a_signal_key_that_changes_with_the_epoch() {
        let mut a = creator(1);
        let (b, _) = invite(&mut a, 2);
        let key = a.signal_key().unwrap();
        assert_eq!(b.signal_key().unwrap(), key);
        assert!(!a.media_keys().iter().any(|k| k.key == key), "not a frame key");
        let (c, _) = invite(&mut a, 3);
        assert_ne!(a.signal_key().unwrap(), key, "a new epoch, a new key");
        assert_eq!(c.signal_key().unwrap(), a.signal_key().unwrap());
    }

    #[test]
    fn a_joiner_tells_its_own_welcome_from_another() {
        let mut a = creator(1);
        let (first, first_package) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        // Asked again (gave up on the first): the welcome left for the first must not use up the second.
        let (second, _) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        let out = a.commit(&[first_package], &[], &admit_all).unwrap();
        a.confirm().unwrap();
        let welcome = out.welcome.expect("a welcome for the newcomer");
        assert!(first.fits(&welcome));
        assert!(!second.fits(&welcome));
        assert!(!second.fits(b"not a welcome"));
        assert!(!second.fits(&out.commit), "a commit is no welcome");
        assert!(first.welcome(&welcome, &admit_all).is_ok());
    }

    #[test]
    fn joiner_gets_the_same_keys_and_code() {
        let mut a = creator(1);
        assert_eq!(a.epoch(), 0);
        let (b, out) = invite(&mut a, 2);

        assert_eq!(a.epoch(), 1);
        assert_eq!(b.epoch(), 1);
        assert_eq!(a.code(), b.code());
        assert_eq!(a.code().len(), 35);
        assert_eq!(a.media_keys(), b.media_keys());

        let keys = a.media_keys();
        assert_eq!(keys.len(), 2);
        assert_eq!((keys[0].user.clone(), keys[1].user.clone()), (user(1), user(2)));
        assert!(keys.iter().all(|key| key.index == 1));
        assert_ne!(keys[0].key, keys[1].key);

        assert_eq!(out.epoch, 0);
        assert_eq!(out.welcome_to, vec![user(2)]);
        assert_eq!(out.members, vec![user(1), user(2)]);
        assert_eq!(a.members(), vec![user(1), user(2)]);
        assert_eq!(b.members(), vec![user(1), user(2)]);
        assert_eq!((a.me(), b.me()), (user(1), user(2)));
        assert_eq!((a.group_id(), b.group_id()), (GROUP, GROUP));
        assert_eq!((a.channel(), b.channel()), (CHANNEL, CHANNEL));
        assert!(a.is_member() && b.is_member());
    }

    #[test]
    fn keys_and_code_change_every_epoch() {
        let mut a = creator(1);
        let (mut b, _) = invite(&mut a, 2);
        let (code, keys) = (a.code(), a.media_keys());

        let (_c, out) = invite(&mut a, 3);
        b.process(&out.commit, &admit_all).unwrap();

        assert_eq!(a.epoch(), 2);
        assert_ne!(a.code(), code);
        let next = a.media_keys();
        assert_eq!(next.len(), 3);
        assert!(next.iter().all(|key| key.index == 2));
        for key in &next {
            assert!(keys.iter().all(|old| old.key != key.key), "{:?} kept its key", key.user);
        }
    }

    #[test]
    fn key_index_wraps_around_the_keyring() {
        let mut a = creator(1);
        for epoch in 1..=17u64 {
            a.commit(&[], &[], &admit_all).unwrap();
            a.confirm().unwrap();
            assert_eq!(a.epoch(), epoch);
            assert_eq!(u64::from(a.media_keys()[0].index), epoch % 16);
        }
        assert_eq!(a.media_keys()[0].index, 1);
    }

    #[test]
    fn third_member_follows_by_processing_the_commit() {
        let mut a = creator(1);
        let (mut b, _) = invite(&mut a, 2);
        let (c, out) = invite(&mut a, 3);

        b.process(&out.commit, &admit_all).unwrap();

        assert_eq!(b.epoch(), 2);
        assert_eq!(b.members(), vec![user(1), user(2), user(3)]);
        assert_eq!(b.code(), a.code());
        assert_eq!(c.code(), a.code());
        assert_eq!(b.media_keys(), a.media_keys());
        assert_eq!(c.media_keys(), a.media_keys());
    }

    #[test]
    fn removed_member_cannot_compute_the_next_keys() {
        let mut a = creator(1);
        let (mut b, _) = invite(&mut a, 2);
        let before = b.media_keys();

        let out = a.commit(&[], &[user(2)], &admit_all).unwrap();
        a.confirm().unwrap();
        assert!(out.welcome.is_none());
        assert!(out.welcome_to.is_empty());
        assert_eq!(out.members, vec![user(1)]);

        b.process(&out.commit, &admit_all).unwrap();

        assert!(!b.is_member());
        assert!(a.is_member());
        assert_eq!(a.members(), vec![user(1)]);
        let next = a.media_keys();
        assert_eq!(next.len(), 1);
        for key in &next {
            assert!(before.iter().all(|old| old.key != key.key), "the old keys are still good");
            assert!(b.media_keys().iter().all(|theirs| theirs.key != key.key));
        }
        assert!(b.media_keys().is_empty());
        assert_eq!(b.code(), "");
        assert_ne!(b.code(), a.code());
        assert_eq!(b.commit(&[], &[], &admit_all).unwrap_err(), CallError::NotMember);
    }

    #[test]
    fn commit_is_refused_for_strangers_and_forged_credentials() {
        let mut a = creator(1);
        let other_group = prepare_join(&person(2), [8; 16], CHANNEL).unwrap().1;
        let other_channel = prepare_join(&person(2), GROUP, "afk").unwrap().1;
        // Person 3's genuine credential, lifted into a leaf that signs with some other key.
        let lifted = key_package_with(|_| CallCredential::sign(&person(3), GROUP, CHANNEL, [9; 32]).to_bytes());
        let bad_proof = key_package_with(|sig| {
            let mut credential = CallCredential::sign(&person(3), GROUP, CHANNEL, sig.try_into().unwrap());
            credential.proof.0[0] ^= 1;
            credential.to_bytes()
        });
        let garbage = key_package_with(|_| vec![1, 2, 3]);
        let (joiner, good) = prepare_join(&person(4), GROUP, CHANNEL).unwrap();

        for forged in [other_group, other_channel, lifted, bad_proof, garbage] {
            let result = a.commit(&[good.clone(), forged], &[], &admit_all);
            assert!(matches!(result, Err(CallError::BadCredential(_))), "{result:?}");
            assert_eq!(a.epoch(), 0);
            assert_eq!(a.members(), vec![user(1)]);
        }

        // A genuine credential of someone the call doesn't admit.
        let refuse = |who: &UserId| *who != user(4);
        assert_eq!(a.commit(std::slice::from_ref(&good), &[], &refuse).unwrap_err(), CallError::NotAdmitted(user(4)));
        assert_eq!(a.epoch(), 0);
        assert_eq!(a.members(), vec![user(1)]);

        // Nothing was left half done: the same newcomer is let in once admitted.
        let out = a.commit(&[good], &[], &admit_all).unwrap();
        a.confirm().unwrap();
        let b = joiner.welcome(out.welcome.as_ref().unwrap(), &admit_all).unwrap();
        assert_eq!(a.epoch(), 1);
        assert_eq!(b.code(), a.code());
    }

    #[test]
    fn processing_a_commit_with_an_unadmitted_member_fails() {
        let mut a = creator(1);
        let (mut b, _) = invite(&mut a, 2);
        let (_c, out) = invite(&mut a, 3);

        let refuse = |who: &UserId| *who != user(3);
        assert_eq!(b.process(&out.commit, &refuse).unwrap_err(), CallError::NotAdmitted(user(3)));

        assert_eq!(b.epoch(), 1);
        assert_eq!(b.members(), vec![user(1), user(2)]);
        assert!(b.is_member());
    }

    #[test]
    fn welcome_with_an_unadmitted_member_is_refused() {
        let mut a = creator(1);
        let (joiner, key_package) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        let out = a.commit(&[key_package], &[], &admit_all).unwrap();

        let refuse = |who: &UserId| *who != user(1);
        let result = joiner.welcome(out.welcome.as_ref().unwrap(), &refuse);
        assert_eq!(result.unwrap_err(), CallError::NotAdmitted(user(1)));
    }

    #[test]
    fn rejoining_replaces_the_old_leaf() {
        let mut a = creator(1);
        let (mut old_b, _) = invite(&mut a, 2);
        let (mut c, out) = invite(&mut a, 3);
        old_b.process(&out.commit, &admit_all).unwrap();

        let (joiner, key_package) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        let out = a.commit(&[key_package], &[], &admit_all).unwrap();
        a.confirm().unwrap();
        let new_b = joiner.welcome(out.welcome.as_ref().unwrap(), &admit_all).unwrap();
        c.process(&out.commit, &admit_all).unwrap();
        old_b.process(&out.commit, &admit_all).unwrap();

        assert_eq!(out.welcome_to, vec![user(2)]);
        assert_eq!(out.members, vec![user(1), user(2), user(3)]);
        for member in [&a, &new_b, &c] {
            assert_eq!(member.members(), vec![user(1), user(2), user(3)]);
            assert_eq!(member.code(), a.code());
            assert_eq!(member.media_keys(), a.media_keys());
        }
        assert_eq!(a.media_keys().iter().filter(|key| key.user == user(2)).count(), 1);
        // The session being replaced is out of the call.
        assert!(!old_b.is_member());
    }

    #[test]
    fn second_commit_waits_for_the_first() {
        let mut a = creator(1);
        let (first, first_package) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        let (_second, second_package) = prepare_join(&person(3), GROUP, CHANNEL).unwrap();
        let out = a.commit(&[first_package], &[], &admit_all).unwrap();

        // The first commit may already have been accepted by the server: it must not be replaced.
        let result = a.commit(&[second_package], &[], &admit_all);
        assert!(matches!(&result, Err(CallError::Mls(why)) if why.contains("already waiting")), "{result:?}");
        assert_eq!(a.epoch(), 0);

        a.confirm().unwrap();
        assert_eq!(a.epoch(), 1);
        assert_eq!(a.members(), vec![user(1), user(2)]);
        let b = first.welcome(out.welcome.as_ref().unwrap(), &admit_all).unwrap();
        assert_eq!(b.members(), vec![user(1), user(2)]);
        assert_eq!(b.code(), a.code());
        assert_eq!(b.media_keys(), a.media_keys());
    }

    #[test]
    fn discarded_commit_leaves_the_group_as_it_was() {
        let mut a = creator(1);
        let (joiner, key_package) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        let (code, keys) = (a.code(), a.media_keys());

        a.commit(std::slice::from_ref(&key_package), &[], &admit_all).unwrap();
        a.discard().unwrap();

        assert_eq!(a.epoch(), 0);
        assert_eq!(a.members(), vec![user(1)]);
        assert_eq!((a.code(), a.media_keys()), (code, keys));
        assert!(a.confirm().is_err(), "there is nothing left to confirm");

        let out = a.commit(&[key_package], &[], &admit_all).unwrap();
        a.confirm().unwrap();
        let b = joiner.welcome(out.welcome.as_ref().unwrap(), &admit_all).unwrap();
        assert_eq!(a.epoch(), 1);
        assert_eq!(b.code(), a.code());
    }

    #[test]
    fn messages_are_private_on_the_wire() {
        let mut a = creator(1);
        let (_joiner, key_package) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        let out = a.commit(std::slice::from_ref(&key_package), &[], &admit_all).unwrap();

        let commit = MlsMessageIn::tls_deserialize_exact(&out.commit).unwrap();
        assert!(matches!(commit.extract(), MlsMessageBodyIn::PrivateMessage(_)));
        let welcome = MlsMessageIn::tls_deserialize_exact(out.welcome.as_ref().unwrap()).unwrap();
        assert!(matches!(welcome.extract(), MlsMessageBodyIn::Welcome(_)));

        // The key package carries the newcomer's identity key in the clear; the commit that adds it must not.
        let ik = person(2).public().0;
        assert!(contains(&key_package, &ik));
        assert!(!contains(&out.commit, &ik));
        assert!(!contains(&out.commit, &person(1).public().0));
    }

    #[test]
    fn removing_strangers_or_ourselves_is_refused() {
        let mut a = creator(1);
        let (_b, _) = invite(&mut a, 2);

        assert_eq!(a.commit(&[], &[user(9)], &admit_all).unwrap_err(), CallError::NotMember);
        assert!(matches!(a.commit(&[], &[user(1)], &admit_all), Err(CallError::Mls(_))));
        // A key package for ourselves would replace our own leaf.
        let own = prepare_join(&person(1), GROUP, CHANNEL).unwrap().1;
        assert!(matches!(a.commit(&[own], &[], &admit_all), Err(CallError::Mls(_))));
        // Two key packages for one person would leave two leaves of them.
        let first = prepare_join(&person(3), GROUP, CHANNEL).unwrap().1;
        let second = prepare_join(&person(3), GROUP, CHANNEL).unwrap().1;
        assert!(matches!(a.commit(&[first, second], &[], &admit_all), Err(CallError::Mls(_))));

        assert_eq!(a.epoch(), 1);
        assert_eq!(a.members(), vec![user(1), user(2)]);
    }

    #[test]
    fn garbage_messages_are_errors() {
        let mut a = creator(1);
        let (joiner, _) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        let (other, key_package) = prepare_join(&person(3), GROUP, CHANNEL).unwrap();

        assert!(matches!(a.commit(&[vec![1, 2, 3]], &[], &admit_all), Err(CallError::Mls(_))));
        assert!(matches!(a.process(&[1, 2, 3], &admit_all), Err(CallError::Mls(_))));
        assert!(matches!(joiner.welcome(&[1, 2, 3], &admit_all), Err(CallError::Mls(_))));
        // A key package is not a commit, and a commit is not a welcome.
        assert!(matches!(a.process(&key_package, &admit_all), Err(CallError::Mls(_))));
        let out = a.commit(&[key_package], &[], &admit_all).unwrap();
        assert!(matches!(other.welcome(&out.commit, &admit_all), Err(CallError::Mls(_))));
        assert_eq!(a.epoch(), 0);
    }

    #[test]
    fn key_packages_do_not_depend_on_the_clock() {
        let (_joiner, bytes) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        let provider = Provider::new().unwrap();
        let key_package = KeyPackageIn::tls_deserialize_exact(&bytes)
            .unwrap()
            .validate(provider.crypto(), ProtocolVersion::Mls10)
            .unwrap();
        assert_eq!(key_package.life_time(), &forever());
        // The creator's own leaf has no lifetime accessor; look for the lifetime in its encoding.
        let leaf = creator(1).group.own_leaf_node().unwrap().tls_serialize_detached().unwrap();
        assert!(contains(&leaf, &forever().tls_serialize_detached().unwrap()));
    }

    /// A commit a member with a modified client could make: `build` adds what the commit should carry.
    fn forged_commit(
        member: &mut CallGroup,
        build: impl for<'a> FnOnce(CommitBuilder<'a, Initial>) -> CommitBuilder<'a, Initial>,
    ) -> Vec<u8> {
        let builder = build(member.group.commit_builder().consume_proposal_store(false));
        let bundle = builder
            .load_psks(member.provider.storage())
            .unwrap()
            .build(member.provider.rand(), member.provider.crypto(), &member.signer, |_| true)
            .unwrap()
            .stage_commit(&member.provider)
            .unwrap();
        bundle.commit().tls_serialize_detached().unwrap()
    }

    #[test]
    fn a_commit_cannot_leave_one_person_in_twice() {
        let mut a = creator(1);
        let (mut b, _) = invite(&mut a, 2);
        // A genuine key package of person 1, added without removing the leaf person 1 already has.
        let bytes = prepare_join(&person(1), GROUP, CHANNEL).unwrap().1;
        let package = KeyPackageIn::tls_deserialize_exact(&bytes)
            .unwrap()
            .validate(b.provider.crypto(), ProtocolVersion::Mls10)
            .unwrap();
        let commit = forged_commit(&mut b, |builder| builder.propose_adds([package]));

        let result = a.process(&commit, &admit_all);
        assert!(matches!(&result, Err(CallError::Mls(why)) if why.contains("two leaves")), "{result:?}");
        assert_eq!((a.epoch(), a.members()), (1, vec![user(1), user(2)]));
    }

    #[test]
    fn a_commit_may_only_add_and_remove() {
        let mut a = creator(1);
        let (mut b, _) = invite(&mut a, 2);
        let extensions = b.group.extensions().clone();
        let commit = forged_commit(&mut b, |builder| builder.propose_group_context_extensions(extensions).unwrap());

        let result = a.process(&commit, &admit_all);
        assert!(matches!(&result, Err(CallError::Mls(why)) if why.contains("only add and remove")), "{result:?}");
        assert_eq!(a.epoch(), 1);
    }

    #[test]
    fn a_commit_cannot_change_who_the_committer_is() {
        let mut a = creator(1);
        let (mut b, _) = invite(&mut a, 2);
        // Person 2 rotates its leaf onto a genuine credential of person 9.
        let other = new_leaf(&person(9), GROUP, CHANNEL).unwrap();
        let bundle = b
            .group
            .commit_builder()
            .consume_proposal_store(false)
            .load_psks(b.provider.storage())
            .unwrap()
            .build_with_new_signer(
                b.provider.rand(),
                b.provider.crypto(),
                &b.signer,
                NewSignerBundle { signer: &other.signer, credential_with_key: other.credential.clone() },
                |_| true,
            )
            .unwrap()
            .stage_commit(&b.provider)
            .unwrap();
        let commit = bundle.commit().tls_serialize_detached().unwrap();

        let result = a.process(&commit, &admit_all);
        assert!(matches!(&result, Err(CallError::BadCredential(why)) if why.contains("who it is")), "{result:?}");
        assert_eq!((a.epoch(), a.members()), (1, vec![user(1), user(2)]));
    }

    /// The server group of person 1 with person 2 in it.
    fn server_pair() -> (CallGroup, CallGroup) {
        let mut a = create(&person(1), GROUP, SERVER_CONTEXT).unwrap();
        let (joiner, key_package) = prepare_join(&person(2), GROUP, SERVER_CONTEXT).unwrap();
        let out = a.commit(&[key_package], &[], &admit_all).unwrap();
        a.confirm().unwrap();
        let b = joiner.welcome(out.welcome.as_ref().unwrap(), &admit_all).unwrap();
        (a, b)
    }

    #[test]
    fn members_read_each_others_messages() {
        let (mut a, mut b) = server_pair();
        let from_b = b.encrypt(b"hello").unwrap();
        assert!(!contains(&from_b, b"hello"), "the server sees no plain text");
        assert_eq!(a.decrypt(&from_b).unwrap(), (user(2), b"hello".to_vec()));
        let from_a = a.encrypt("привет".as_bytes()).unwrap();
        assert_eq!(b.decrypt(&from_a).unwrap(), (user(1), "привет".as_bytes().to_vec()));
    }

    #[test]
    fn a_message_of_an_earlier_epoch_is_refused() {
        let (mut a, mut b) = server_pair();
        let late = b.encrypt(b"sent in epoch 1").unwrap();
        let (joiner, key_package) = prepare_join(&person(3), GROUP, SERVER_CONTEXT).unwrap();
        a.commit(&[key_package], &[], &admit_all).unwrap();
        a.confirm().unwrap();
        drop(joiner);
        assert_eq!(a.epoch(), 2);
        assert!(a.decrypt(&late).is_err());
    }

    #[test]
    fn an_outsider_cannot_read() {
        let (_, mut b) = server_pair();
        let message = b.encrypt(b"members only").unwrap();
        let mut stranger = create(&person(3), GROUP, SERVER_CONTEXT).unwrap();
        assert!(stranger.decrypt(&message).is_err());
    }

    #[test]
    fn a_server_leaf_is_not_a_call_leaf() {
        let mut call = creator(1);
        let (_, server_leaf) = prepare_join(&person(2), GROUP, SERVER_CONTEXT).unwrap();
        let result = call.commit(&[server_leaf], &[], &admit_all);
        assert!(matches!(result, Err(CallError::BadCredential(_))), "{result:?}");
        let mut server = create(&person(1), GROUP, SERVER_CONTEXT).unwrap();
        let (_, call_leaf) = prepare_join(&person(2), GROUP, CHANNEL).unwrap();
        assert!(matches!(server.commit(&[call_leaf], &[], &admit_all), Err(CallError::BadCredential(_))));
    }

    #[test]
    fn a_restored_group_goes_on() {
        let (a, mut b) = server_pair();
        let mut a = CallGroup::restore(&a.snapshot().unwrap()).unwrap();

        // B adds C; the restored A follows.
        let (_c, key_package) = prepare_join(&person(3), GROUP, SERVER_CONTEXT).unwrap();
        let out = b.commit(&[key_package], &[], &admit_all).unwrap();
        b.confirm().unwrap();
        a.process(&out.commit, &admit_all).unwrap();
        assert_eq!(a.members(), vec![user(1), user(2), user(3)]);

        // Messages both ways, then a commit of its own.
        let from_a = a.encrypt(b"back again").unwrap();
        assert_eq!(b.decrypt(&from_a).unwrap(), (user(1), b"back again".to_vec()));
        let from_b = b.encrypt(b"welcome back").unwrap();
        assert_eq!(a.decrypt(&from_b).unwrap(), (user(2), b"welcome back".to_vec()));
        let (_d, key_package) = prepare_join(&person(4), GROUP, SERVER_CONTEXT).unwrap();
        let out = a.commit(&[key_package], &[], &admit_all).unwrap();
        a.confirm().unwrap();
        b.process(&out.commit, &admit_all).unwrap();
        assert_eq!(a.code(), b.code());
    }

    #[test]
    fn a_snapshot_keeps_the_epoch_and_members() {
        let (a, _) = server_pair();
        let restored = CallGroup::restore(&a.snapshot().unwrap()).unwrap();
        assert_eq!((restored.epoch(), restored.members(), restored.code()), (a.epoch(), a.members(), a.code()));
        assert_eq!((restored.group_id(), restored.channel(), restored.me()), (GROUP, SERVER_CONTEXT, user(1)));
    }

    #[test]
    fn a_broken_snapshot_is_refused() {
        let (a, _) = server_pair();
        let good = a.snapshot().unwrap();
        for cut in [0, 3, 5, 20, good.len() / 2, good.len() - 1] {
            assert!(CallGroup::restore(&good[..cut]).is_err(), "cut at {cut}");
        }
        let mut magic = good.clone();
        magic[0] ^= 1;
        assert!(CallGroup::restore(&magic).is_err());
        let mut longer = good.clone();
        longer.push(0);
        assert!(CallGroup::restore(&longer).is_err(), "nothing may follow the last record");
        // OpenMLS's key store panics on a value it can't read, so a changed byte anywhere must be caught first.
        for at in [10, good.len() / 3, good.len() / 2, good.len() - 1] {
            let mut flipped = good.clone();
            flipped[at] ^= 0x40;
            assert!(CallGroup::restore(&flipped).is_err(), "flipped at {at}");
        }
    }

    #[test]
    fn no_snapshot_while_a_commit_waits() {
        let (mut a, _) = server_pair();
        let (_, key_package) = prepare_join(&person(3), GROUP, SERVER_CONTEXT).unwrap();
        a.commit(&[key_package], &[], &admit_all).unwrap();
        assert!(a.snapshot().is_err());
        a.discard().unwrap();
        assert!(a.snapshot().is_ok());
    }

    #[test]
    fn decrypt_refuses_a_commit() {
        let (mut a, mut b) = server_pair();
        let (_, key_package) = prepare_join(&person(3), GROUP, SERVER_CONTEXT).unwrap();
        let out = a.commit(&[key_package], &[], &admit_all).unwrap();
        assert!(b.decrypt(&out.commit).is_err());
        assert!(b.decrypt(b"not a message").is_err());
    }
}
