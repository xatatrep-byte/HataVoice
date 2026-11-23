//! End-to-end encryption of calls and of the server's chat: a temporary group per call and one lasting group per
//! server, members vouched for by their identity keys.

use std::fmt;

use hv_roster::UserId;

pub mod code;
pub mod credential;
pub mod group;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// The credential is malformed or does not belong to this call, leaf key or identity.
    BadCredential(String),
    /// A leaf's credential is valid, but its owner is not allowed to be in this call.
    NotAdmitted(UserId),
    /// The MLS library refused an operation.
    Mls(String),
    /// The call group has no such member.
    NotMember,
}

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CallError::BadCredential(why) => write!(f, "bad call credential: {why}"),
            CallError::NotAdmitted(user) => write!(f, "{user} is not admitted to this call"),
            CallError::Mls(why) => write!(f, "mls: {why}"),
            CallError::NotMember => f.write_str("not a member of the call group"),
        }
    }
}

impl std::error::Error for CallError {}
