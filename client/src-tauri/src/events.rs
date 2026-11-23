//! Keeps a server's event stream open: forwards each event, reconnects with a growing pause
//! after a drop and re-reads the journal so nothing written meanwhile is missed.

use std::future::Future;
use std::time::Duration;

use futures_util::StreamExt;
use hv_roster::request::sign_request;
use hv_roster::{Identity, PublicKey};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::session::unix_now;
use crate::tls::{Pin, ws_connector};

const FIRST_PAUSE: Duration = Duration::from_secs(1);
const LONGEST_PAUSE: Duration = Duration::from_secs(30);
/// The server pings every 25 s; this long without any frame means the connection is dead
/// (a socket left half-open after sleep or a Wi-Fi drop never errors on its own).
const IDLE_LIMIT: Duration = Duration::from_secs(60);

enum Ended {
    /// Dropped or failed to connect: try again later.
    Retry,
    /// The server refused us (no longer a member, banned): stop for good.
    Refused,
}

/// One connection: `on_open` runs as soon as it is up, then events flow until it drops.
async fn stream_once<F, Fut, O, OFut>(
    address: &str,
    server_key: &PublicKey,
    id: &Identity,
    on_event: &F,
    on_open: O,
    connected: &mut bool,
    idle: Duration,
) -> Ended
where
    F: Fn(Value) -> Fut,
    Fut: Future<Output = ()>,
    O: FnOnce() -> OFut,
    OFut: Future<Output = ()>,
{
    let path = "/api/events";
    let Ok(mut url) = crate::server_check::server_url(address, path) else {
        return Ended::Refused;
    };
    if url.set_scheme("wss").is_err() {
        return Ended::Refused;
    }
    let Ok(mut request) = url.as_str().into_client_request() else {
        return Ended::Refused;
    };
    let Ok(header) = sign_request(id, server_key, "GET", path, b"", unix_now()) else {
        return Ended::Refused;
    };
    if let Ok(value) = header.parse() {
        request.headers_mut().insert("authorization", value);
    }
    // The signed request goes out only after the handshake accepted the pinned key.
    let connector = ws_connector(&Pin::to(*server_key));
    let mut stream = match tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector)).await {
        Ok((stream, _)) => stream,
        Err(WsError::Http(response)) if matches!(response.status().as_u16(), 403 | 503) => return Ended::Refused,
        Err(_) => return Ended::Retry,
    };
    *connected = true;
    on_open().await;
    while let Ok(Some(message)) = tokio::time::timeout(idle, stream.next()).await {
        match message {
            Ok(Message::Text(text)) => {
                if let Ok(event) = serde_json::from_str::<Value>(&text) {
                    on_event(event).await;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    Ended::Retry
}

/// Runs until the server refuses us. `on_event` gets each event; whenever a connection opens
/// `on_reconnect` runs (re-read the journal: entries written before or between connections are
/// not missed), and after a drop `on_event` also gets `{"type": "resync"}`.
pub async fn run_events<F, Fut, R, RFut>(address: String, server_key: PublicKey, seed: [u8; 32], on_event: F, on_reconnect: R)
where
    F: Fn(Value) -> Fut,
    Fut: Future<Output = ()>,
    R: Fn() -> RFut,
    RFut: Future<Output = ()>,
{
    run_events_with(address, server_key, seed, on_event, on_reconnect, IDLE_LIMIT).await
}

async fn run_events_with<F, Fut, R, RFut>(
    address: String,
    server_key: PublicKey,
    seed: [u8; 32],
    on_event: F,
    on_reconnect: R,
    idle: Duration,
) where
    F: Fn(Value) -> Fut,
    Fut: Future<Output = ()>,
    R: Fn() -> RFut,
    RFut: Future<Output = ()>,
{
    let id = Identity::from_seed(seed);
    let mut pause = FIRST_PAUSE;
    let mut was_connected = false;
    loop {
        let mut connected = false;
        // After a drop, catch up as soon as the next connection is up.
        let catch_up = was_connected;
        let on_open = || async {
            on_reconnect().await;
            if catch_up {
                on_event(json!({ "type": "resync" })).await;
            }
        };
        let ended = stream_once(&address, &server_key, &id, &on_event, on_open, &mut connected, idle).await;
        if connected {
            pause = FIRST_PAUSE;
            was_connected = true;
        }
        if let Ended::Refused = ended {
            on_event(json!({ "type": "stream_refused" })).await;
            return;
        }
        tokio::time::sleep(pause).await;
        pause = (pause * 2).min(LONGEST_PAUSE);
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use hv_roster::{Body, ChannelDef, Identity, sign_entry};
    use serde_json::Value;
    use tokio::task::JoinHandle;

    use super::*;
    use crate::session::{Session, unix_now};
    use crate::tls::test_server::{self, serve};

    fn owner() -> Identity {
        Identity::from_seed([1; 32])
    }

    /// An `/api/events` that accepts every WebSocket, counts it and then stays silent.
    async fn counting_stream(server_key: &Identity) -> (SocketAddr, Arc<Mutex<u32>>) {
        use axum::extract::ws::WebSocketUpgrade;
        use axum::routing::get;
        let opened = Arc::new(Mutex::new(0u32));
        let counted = opened.clone();
        let route = get(move |upgrade: WebSocketUpgrade| {
            let counted = counted.clone();
            async move {
                upgrade.on_upgrade(move |socket| async move {
                    *counted.lock().unwrap() += 1;
                    let _held_open = socket;
                    std::future::pending::<()>().await;
                })
            }
        });
        let addr = test_server::serve_app(axum::Router::new().route("/api/events", route), server_key).await;
        (addr, opened)
    }

    /// A TCP forwarder that can drop every connection at once, like a Wi-Fi outage.
    struct Proxy {
        port: u16,
        target: SocketAddr,
        tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    }

    impl Proxy {
        async fn start(port: u16, target: SocketAddr) -> Proxy {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
            let inner = tasks.clone();
            let accept = tokio::spawn(async move {
                while let Ok((mut client, _)) = listener.accept().await {
                    let pipe = tokio::spawn(async move {
                        if let Ok(mut server) = tokio::net::TcpStream::connect(target).await {
                            let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                        }
                    });
                    inner.lock().unwrap().push(pipe);
                }
            });
            tasks.lock().unwrap().push(accept);
            Proxy { port, target, tasks }
        }

        /// Drops the listener and every connection, and waits until they are really gone.
        async fn cut(&self) {
            let tasks: Vec<JoinHandle<()>> = self.tasks.lock().unwrap().drain(..).collect();
            for task in &tasks {
                task.abort();
            }
            for task in tasks {
                let _ = task.await;
            }
        }
    }

    #[tokio::test]
    async fn missed_entries_are_fetched_after_reconnect() {
        let store = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        let server = serve(store.clone()).await;
        let proxy = Proxy::start(0, server).await;
        let address = format!("127.0.0.1:{}", proxy.port);
        let session = Session::claim(&address, &owner(), "Хата", &[]).await.unwrap();
        let server_key = session.server_key;
        let session = Arc::new(tokio::sync::Mutex::new(session));
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();

        let (on_seen, on_sync) = (seen.clone(), session.clone());
        tokio::spawn(run_events(
            address.clone(),
            server_key,
            owner().seed(),
            move |event| {
                on_seen.lock().unwrap().push(event);
                async {}
            },
            move || {
                let session = on_sync.clone();
                async move {
                    let _ = session.lock().await.sync(&owner()).await;
                }
            },
        ));
        tokio::time::sleep(Duration::from_millis(400)).await;

        proxy.cut().await;
        let channel = ChannelDef { id: "games".into(), name: "Игры".into(), user_limit: 0, overrides: vec![], kind: Default::default() };
        let entry = store.read(|r| sign_entry(r, &owner(), unix_now(), Body::ChannelCreate(channel)));
        store.append(entry, unix_now()).unwrap();
        assert_eq!(session.lock().await.roster().len(), 1, "written while we were cut off");

        let _back = Proxy::start(proxy.port, proxy.target).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while session.lock().await.roster().len() < 2 {
            assert!(tokio::time::Instant::now() < deadline, "the missed entry never arrived");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(session.lock().await.roster().channels()[0].id, "games");
        assert!(seen.lock().unwrap().iter().any(|e| e["type"] == "resync"), "the UI is told to reload");
    }

    #[tokio::test]
    async fn a_connection_that_went_silent_is_dropped_and_opened_again() {
        // A server that accepts the stream and then never sends a thing, like a socket left
        // half-open after the PC slept.
        let server = Identity::from_seed([100; 32]);
        let (address, connections) = counting_stream(&server).await;
        tokio::spawn(run_events_with(address.to_string(), server.public(), owner().seed(), |_| async {}, || async {}, Duration::from_millis(300)));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        while *connections.lock().unwrap() < 2 {
            assert!(tokio::time::Instant::now() < deadline, "a silent stream is never given up");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn an_entry_written_before_the_stream_opens_is_not_missed() {
        let store = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        let address = serve(store.clone()).await.to_string();
        let session = Session::claim(&address, &owner(), "Хата", &[]).await.unwrap();
        let server_key = session.server_key;
        let channel = ChannelDef { id: "games".into(), name: "Игры".into(), user_limit: 0, overrides: vec![], kind: Default::default() };
        let entry = store.read(|r| sign_entry(r, &owner(), unix_now(), Body::ChannelCreate(channel)));
        store.append(entry, unix_now()).unwrap();

        let session = Arc::new(tokio::sync::Mutex::new(session));
        let on_sync = session.clone();
        tokio::spawn(run_events(address, server_key, owner().seed(), |_| async {}, move || {
            let session = on_sync.clone();
            async move {
                let _ = session.lock().await.sync(&owner()).await;
            }
        }));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while session.lock().await.roster().len() < 2 {
            assert!(tokio::time::Instant::now() < deadline, "the entry from before the stream never arrived");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn the_stream_stops_when_we_are_no_longer_a_member() {
        let store = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        let server = serve(store.clone()).await;
        let address = server.to_string();
        let session = Session::claim(&address, &owner(), "Хата", &[]).await.unwrap();
        let stranger = Identity::from_seed([9; 32]);
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let on_seen = seen.clone();
        let finished = tokio::time::timeout(
            Duration::from_secs(5),
            run_events(address, session.server_key, stranger.seed(), move |e| {
                on_seen.lock().unwrap().push(e);
                async {}
            }, || async {}),
        )
        .await;
        assert!(finished.is_ok(), "no endless reconnecting when the server says we are not a member");
        assert!(seen.lock().unwrap().iter().any(|e| e["type"] == "stream_refused"));
    }

    #[tokio::test]
    async fn events_flow_over_tls() {
        let store = Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap());
        let address = serve(store).await.to_string();
        let session = Session::claim(&address, &owner(), "Хата", &[]).await.unwrap();
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let on_seen = seen.clone();
        tokio::spawn(run_events(address, session.server_key, owner().seed(), move |event| {
            on_seen.lock().unwrap().push(event);
            async {}
        }, || async {}));

        // Our own «online» comes back once the stream is up.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let me = owner().public().user_id().0;
        while !seen.lock().unwrap().iter().any(|e| e["type"] == "online" && e["user"] == me.as_str()) {
            assert!(tokio::time::Instant::now() < deadline, "no event came through the TLS stream");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn events_refuse_a_server_with_another_key() {
        let server = Identity::from_seed([100; 32]);
        let (addr, opened) = counting_stream(&server).await;
        let address = addr.to_string();
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let (on_seen, on_open) = (seen.clone(), seen.clone());

        let wrong = tokio::spawn(run_events(address.clone(), Identity::from_seed([101; 32]).public(), owner().seed(), move |event| {
            on_seen.lock().unwrap().push(event);
            async {}
        }, move || {
            on_open.lock().unwrap().push(Value::String("reconnect".into()));
            async {}
        }));
        // Long enough for a first attempt and, after the first pause, a second one.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(*opened.lock().unwrap(), 0, "the stream must never open on a server with another key");
        assert!(seen.lock().unwrap().is_empty(), "nothing is delivered from a server we did not pin: {:?}", seen.lock().unwrap());
        wrong.abort();

        // The same server is fine for whoever pinned its key.
        tokio::spawn(run_events(address, server.public(), owner().seed(), |_| async {}, || async {}));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while *opened.lock().unwrap() == 0 {
            assert!(tokio::time::Instant::now() < deadline, "the pinned key never connected");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
