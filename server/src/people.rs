//! Who is who is not the server's business: nicknames, colors and «Играет в …» travel inside the server group.
//! A server of an earlier version kept them in `profiles.json`; it is removed at start.

use std::path::Path;

pub const PROFILES_FILE: &str = "profiles.json";

/// Removes the nicknames an earlier version kept in the data folder.
pub fn forget_profiles(dir: Option<&Path>) {
    if let Some(dir) = dir {
        let _ = std::fs::remove_file(dir.join(PROFILES_FILE));
    }
}
