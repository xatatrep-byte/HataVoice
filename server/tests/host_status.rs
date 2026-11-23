use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use hatavoice_server::host::HostRuntime;
use hatavoice_server::network::{NetworkReport, VirtualAddress, VirtualNet};
use hatavoice_server::supervisor::LiveKitState;
use hv_host::HostConfig;

async fn spawn(host: Option<HostRuntime>) -> SocketAddr {
    let channels = Arc::new(hatavoice_server::channels::ChannelStore::open(None).unwrap());
    let app = hatavoice_server::host_app(
        hatavoice_server::LiveKitConfig::dev(),
        host.map(Arc::new),
        channels,
        Arc::new(hatavoice_server::roster_store::RosterStore::open(None).unwrap()),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap()
    });
    addr
}

#[tokio::test]
async fn reports_livekit_state_ports_and_addresses_to_this_pc() {
    let config = HostConfig { name: "Хата".into(), upnp: false, ..Default::default() };
    let mut network = NetworkReport::new(&config);
    network.public_ip = Some("203.0.113.7".parse().unwrap());
    network.local_ip = Some("192.168.0.132".parse().unwrap());
    network.virtual_addresses =
        vec![VirtualAddress { kind: VirtualNet::Radmin, ip: "26.10.20.30".parse().unwrap() }];
    let addr = spawn(Some(HostRuntime {
        config,
        livekit: Arc::new(RwLock::new(LiveKitState::Running)),
        network: Arc::new(RwLock::new(network)),
        p2p_address: None,
        shutdown: Default::default(),
    }))
    .await;

    let json: serde_json::Value = reqwest::get(format!("http://{addr}/api/host/status"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(json["name"], "Хата");
    assert_eq!(json["livekit"]["state"], "running");
    assert_eq!(json["share_address"], "203.0.113.7:7350");
    assert_eq!(json["lan_address"], "192.168.0.132:7350");
    assert_eq!(
        json["virtual_addresses"],
        serde_json::json!([{ "kind": "radmin", "address": "26.10.20.30:7350" }])
    );
    assert_eq!(json["network"]["upnp"]["state"], "disabled");
    assert_eq!(json["network"]["ports"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn shutdown_request_from_this_pc_signals_the_host() {
    let config = HostConfig { upnp: false, ..Default::default() };
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let addr = spawn(Some(HostRuntime {
        network: Arc::new(RwLock::new(NetworkReport::new(&config))),
        config,
        livekit: Arc::new(RwLock::new(LiveKitState::Starting)),
        p2p_address: None,
        shutdown: shutdown.clone(),
    }))
    .await;

    let response = reqwest::Client::new()
        .post(format!("http://{addr}/api/host/shutdown"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(1), shutdown.notified())
        .await
        .expect("shutdown was not signalled");
}

#[tokio::test]
async fn a_web_page_cannot_shut_the_server_down() {
    let config = HostConfig { upnp: false, ..Default::default() };
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let addr = spawn(Some(HostRuntime {
        network: Arc::new(RwLock::new(NetworkReport::new(&config))),
        config,
        livekit: Arc::new(RwLock::new(LiveKitState::Starting)),
        p2p_address: None,
        shutdown: shutdown.clone(),
    }))
    .await;

    // What a browser sends for a cross-site form post to 127.0.0.1: no preflight, but an Origin.
    let response = reqwest::Client::new()
        .post(format!("http://{addr}/api/host/shutdown"))
        .header("origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let signalled = tokio::time::timeout(std::time::Duration::from_millis(200), shutdown.notified()).await;
    assert!(signalled.is_err(), "shutdown was signalled");
}

#[tokio::test]
async fn is_not_found_when_the_server_is_not_in_host_mode() {
    let addr = spawn(None).await;
    let response = reqwest::get(format!("http://{addr}/api/host/status")).await.unwrap();
    assert_eq!(response.status(), 404);
}
