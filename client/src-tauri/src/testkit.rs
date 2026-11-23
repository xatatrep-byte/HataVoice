//! For tests: a server in the process with people on it, and their event streams.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use hv_roster::{Identity, InviteLink, PublicKey, UserId};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::events::run_events;
use crate::session::{Session, unix_now};
use crate::tls::test_server;

pub const CHANNEL: &str = "general";

pub fn id(n: u8) -> Identity {
    Identity::from_seed([n; 32])
}

pub fn user(n: u8) -> UserId {
    id(n).public().user_id()
}

/// An empty folder of person `n` for the test `test` (what is left from an earlier run is removed).
pub fn folder(test: &str, n: u8) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hv-{test}-{n}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// A server with people `1..=count` (1 owns it, the rest joined by an invite), all of them in the LiveKit room of
/// [`CHANNEL`], each with a session whose journal is read.
pub async fn serve(count: u8) -> HashMap<u8, Session> {
    let store = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
    let people = (1..=count).map(|n| user(n).0).collect();
    let (livekit, _) = hatavoice_server::testing::fake_livekit(vec![(CHANNEL, people)]).await;
    let channels = Arc::new(hatavoice_server::channels::ChannelStore::open(None).unwrap());
    let app = hatavoice_server::host_app(livekit, None, channels, store.clone());
    let address = test_server::serve_app(app, store.server_identity()).await.to_string();
    let mut owner = Session::claim(&address, &id(1), "Хата", &[(CHANNEL.into(), "Общий".into())]).await.unwrap();
    let link = InviteLink::parse(&owner.create_invite(&id(1), &address, vec![], None, None).await.unwrap()).unwrap();
    let mut sessions = HashMap::from([(1, owner)]);
    for n in 2..=count {
        sessions.insert(n, Session::join(&link, &id(n), unix_now()).await.unwrap());
    }
    for (n, session) in sessions.iter_mut() {
        session.sync(&id(*n)).await.unwrap();
    }
    sessions
}

/// Person `n`'s events, as the app gets them, and the stream's task (abort it to go offline). By the time this
/// returns the server counts them as online.
pub async fn stream(address: &str, server_key: PublicKey, n: u8) -> (mpsc::UnboundedReceiver<Value>, JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let on_event = move |event: Value| {
        let _ = tx.send(event);
        async {}
    };
    let task = tokio::spawn(run_events(address.to_string(), server_key, id(n).seed(), on_event, || async {}));
    // The server subscribes the stream before it says who sits where.
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("the stream opens").unwrap();
        if event["type"] == "occupancy" {
            return (rx, task);
        }
    }
}
