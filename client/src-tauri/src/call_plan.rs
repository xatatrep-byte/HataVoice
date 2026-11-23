//! Decisions the call engine makes on its own: what to change in the group, and how long to wait before doing it.

use hv_roster::UserId;
use std::collections::HashSet;
use std::time::Duration;

/// Gap between members in the commit queue: the next one steps in only if the one before it stays silent.
pub const STEP: Duration = Duration::from_secs(2);
/// How long a joiner waits for the keys before giving up with an error.
pub const KEYS_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub adds: Vec<(UserId, Vec<u8>)>,
    pub removes: Vec<UserId>,
}

/// Joiners the room shows (their latest KeyPackage each, in order of first request) are added; members the room
/// no longer shows are removed, in leaf order. `me` is never removed: we are the one committing, and the room
/// may not list us yet. Nor is `me` ever added: a request of ours that comes back is not one to commit.
pub fn changes(members: &[UserId], me: &UserId, present: &HashSet<UserId>, pending: &[(UserId, Vec<u8>)]) -> Changes {
    let mut adds: Vec<(UserId, Vec<u8>)> = Vec::new();
    // A newer KeyPackage means the person started over; the older one belongs to a state they no longer have.
    for (user, key_package) in pending.iter().filter(|(user, _)| user != me && present.contains(user)) {
        match adds.iter_mut().find(|(seen, _)| seen == user) {
            Some(entry) => entry.1 = key_package.clone(),
            None => adds.push((user.clone(), key_package.clone())),
        }
    }
    let removes = members.iter().filter(|member| *member != me && !present.contains(*member)).cloned().collect();
    Changes { adds, removes }
}

/// `me` is ranked among the members the room shows, by leaf; the first commits at once, the k-th after `k * STEP`.
/// `None` when `me` is not in the group or not shown: someone else has to act.
pub fn commit_delay(members_by_leaf: &[UserId], me: &UserId, present: &HashSet<UserId>) -> Option<Duration> {
    let rank = members_by_leaf.iter().filter(|member| present.contains(*member)).position(|member| member == me)?;
    Some(STEP.saturating_mul(u32::try_from(rank).unwrap_or(u32::MAX)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(name: &str) -> UserId {
        UserId(name.to_string())
    }

    fn room(names: &[&str]) -> HashSet<UserId> {
        names.iter().map(|name| user(name)).collect()
    }

    fn leaves(names: &[&str]) -> Vec<UserId> {
        names.iter().map(|name| user(name)).collect()
    }

    #[test]
    fn present_joiners_are_added() {
        let members = leaves(&["u1"]);
        let pending = vec![(user("u2"), b"kp".to_vec())];
        let plan = changes(&members, &user("u1"), &room(&["u1", "u2"]), &pending);
        assert_eq!(plan, Changes { adds: vec![(user("u2"), b"kp".to_vec())], removes: vec![] });
    }

    #[test]
    fn joiners_not_yet_seen_in_the_room_wait() {
        let members = leaves(&["u1"]);
        let pending = vec![(user("u2"), b"kp".to_vec())];
        let plan = changes(&members, &user("u1"), &room(&["u1"]), &pending);
        assert_eq!(plan, Changes::default());
    }

    #[test]
    fn the_latest_key_package_wins() {
        let members = leaves(&["u1"]);
        let pending = vec![
            (user("u2"), b"a".to_vec()),
            (user("u3"), b"c".to_vec()),
            (user("u2"), b"b".to_vec()),
        ];
        let plan = changes(&members, &user("u1"), &room(&["u1", "u2", "u3"]), &pending);
        assert_eq!(
            plan.adds,
            vec![(user("u2"), b"b".to_vec()), (user("u3"), b"c".to_vec())],
            "one entry per person, in the order they first asked"
        );
    }

    #[test]
    fn me_is_never_added_from_pending() {
        let members = leaves(&["u1"]);
        let pending = vec![(user("u1"), b"echo".to_vec()), (user("u2"), b"kp".to_vec())];
        let plan = changes(&members, &user("u1"), &room(&["u1", "u2"]), &pending);
        assert_eq!(plan.adds, vec![(user("u2"), b"kp".to_vec())], "our own join, echoed back, is never committed");
    }

    #[test]
    fn members_who_left_the_room_are_removed() {
        let members = leaves(&["u1", "u2", "u3"]);
        let plan = changes(&members, &user("u1"), &room(&["u1", "u3"]), &[]);
        assert_eq!(plan, Changes { adds: vec![], removes: vec![user("u2")] });

        let plan = changes(&members, &user("u1"), &room(&["u3"]), &[]);
        assert_eq!(plan.removes, vec![user("u2")], "me is not removed even if the room does not list me yet");

        let plan = changes(&members, &user("u3"), &room(&[]), &[]);
        assert_eq!(plan.removes, vec![user("u1"), user("u2")], "removals follow leaf order");
    }

    #[test]
    fn commit_delay_ranks_present_members_by_leaf() {
        let members = leaves(&["u1", "u2", "u3"]);
        let everyone = room(&["u1", "u2", "u3"]);
        let delay = |me: &str, present: &HashSet<UserId>| commit_delay(&members, &user(me), present);
        assert_eq!(delay("u1", &everyone), Some(Duration::ZERO));
        assert_eq!(delay("u2", &everyone), Some(Duration::from_secs(2)));
        assert_eq!(delay("u3", &everyone), Some(Duration::from_secs(4)));

        let without_first = room(&["u2", "u3"]);
        assert_eq!(delay("u2", &without_first), Some(Duration::ZERO));
        assert_eq!(delay("u3", &without_first), Some(Duration::from_secs(2)));
    }

    #[test]
    fn non_members_never_commit() {
        let members = leaves(&["u1", "u2"]);
        let delay = commit_delay(&members, &user("u9"), &room(&["u1", "u2", "u9"]));
        assert_eq!(delay, None);
    }

    #[test]
    fn a_member_the_room_does_not_show_waits_for_it() {
        let members = leaves(&["u1", "u2"]);
        assert_eq!(commit_delay(&members, &user("u2"), &room(&["u1"])), None);
    }
}
