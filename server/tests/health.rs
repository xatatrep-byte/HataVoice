use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn app() -> axum::Router {
    hatavoice_server::app(hatavoice_server::LiveKitConfig::dev())
}

#[tokio::test]
async fn health_reports_ok_name_and_version() {
    let response = app()
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
    assert_eq!(json["name"], "hatavoice-server");
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn unknown_path_is_not_found() {
    let response = app()
        .oneshot(Request::get("/nope").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[test]
fn listen_addr_defaults_to_localhost_7350() {
    let addr = hatavoice_server::listen_addr(None).unwrap();
    assert_eq!(addr.to_string(), "127.0.0.1:7350");
}

#[test]
fn listen_addr_accepts_override_and_rejects_garbage() {
    let addr = hatavoice_server::listen_addr(Some("0.0.0.0:9000")).unwrap();
    assert_eq!(addr.to_string(), "0.0.0.0:9000");
    assert!(hatavoice_server::listen_addr(Some("not-an-address")).is_err());
}
