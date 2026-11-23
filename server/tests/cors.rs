use axum::body::Body;
use axum::http::{Request, header};
use tower::ServiceExt;

async fn preflight_from(origin: &str) -> Option<String> {
    let response = hatavoice_server::app(hatavoice_server::LiveKitConfig::dev())
        .oneshot(
            Request::options("/api/voice/token")
                .header(header::ORIGIN, origin)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .map(|v| v.to_str().unwrap().to_string())
}

#[tokio::test]
async fn dev_ui_origin_is_allowed() {
    assert_eq!(preflight_from("http://localhost:1420").await.as_deref(), Some("http://localhost:1420"));
}

#[tokio::test]
async fn other_web_origins_are_not_allowed() {
    assert_eq!(preflight_from("https://evil.example").await, None);
}
