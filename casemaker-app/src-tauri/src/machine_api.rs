// The machine bridge over HTTP (#571).
//
// WHY THIS EXISTS. The machine transport (`platform/desktop/transport.ts`) talks to the sockets
// through Tauri IPC (`invoke`), which exists only inside the desktop shell's webview. When the SAME
// front end is served over the embedded HTTP server (`casemaker --bind-all --port 8000`) and opened
// in a plain LAN browser, there is no Tauri runtime and every `invoke` throws — so the browser could
// render and design but never connect to or drive the machine. This module gives the browser a path:
// the five transport calls (`Z1-Bridge-Protocol.md` §7) as same-origin `/api/v1/machine/*` POSTs,
// backed by the SAME `MachineTransport` registry (`machine.rs`) the Tauri commands use.
//
// WHAT IT IS NOT. No protocol, no framing, no CRC — exactly like `machine.rs` and `transport.ts`,
// those live in `protocol.ts`. This only moves bytes. The sockets belong to the SERVER process, which
// is on the LAN with the controller; the browser never opens a raw socket (it cannot).
//
// GUARD. These are POSTs under `/api/v1`, so `guard.rs` covers them: a same-origin `application/json`
// request from the page this server served is allowed; a page on another site cannot forge the
// `Host`/`Origin`/`Content-Type` shape, so it cannot make this server open a socket on its behalf
// (the SSRF a bare `connect {host,port}` would otherwise be). The registry here is the HTTP server's
// own instance, separate from the Tauri State registry the local webview uses — the two clients never
// share a connection id and never collide.

use crate::house_api::json_error;
use crate::machine::{udp_listen, MachineTransport};
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The `/api/v1/machine/*` surface, with its own connection registry. Merge into the API router
/// BEFORE the guard layer, so every call here is judged the same as any other `/api/v1` write.
pub fn routes(transport: Arc<MachineTransport>) -> Router {
    Router::new()
        .route("/api/v1/machine/tcp/connect", post(tcp_connect))
        .route("/api/v1/machine/tcp/write", post(tcp_write))
        .route("/api/v1/machine/tcp/read", post(tcp_read))
        .route("/api/v1/machine/tcp/close", post(tcp_close))
        .route("/api/v1/machine/udp/listen", post(udp_listen_handler))
        .with_state(transport)
}

/// A machine/socket failure. 502 Bad Gateway: the request was well formed, the upstream (the
/// controller, or the socket) is what did not answer. The TypeScript transport throws the `error`
/// string, so the protocol layer sees the same words the Tauri path would have returned.
fn upstream_error(e: String) -> Response {
    json_error(StatusCode::BAD_GATEWAY, e)
}

#[derive(Deserialize)]
struct ConnectReq {
    host: String,
    port: u16,
    timeout_ms: u64,
}

#[derive(Serialize)]
struct ConnectResp {
    conn: u64,
}

async fn tcp_connect(State(t): State<Arc<MachineTransport>>, Json(req): Json<ConnectReq>) -> Response {
    match t.connect(&req.host, req.port, req.timeout_ms).await {
        Ok(conn) => Json(ConnectResp { conn }).into_response(),
        Err(e) => upstream_error(e),
    }
}

#[derive(Deserialize)]
struct WriteReq {
    conn: u64,
    data: Vec<u8>,
}

async fn tcp_write(State(t): State<Arc<MachineTransport>>, Json(req): Json<WriteReq>) -> Response {
    match t.write(req.conn, &req.data).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => upstream_error(e),
    }
}

#[derive(Deserialize)]
struct ReadReq {
    conn: u64,
    max: usize,
    timeout_ms: u64,
}

#[derive(Serialize)]
struct ReadResp {
    /// The bytes read, possibly empty — empty means "nothing arrived in time", NOT a closed socket
    /// (which is a 502). The transport returns the empty array, exactly as the Tauri path does.
    bytes: Vec<u8>,
}

async fn tcp_read(State(t): State<Arc<MachineTransport>>, Json(req): Json<ReadReq>) -> Response {
    match t.read(req.conn, req.max, req.timeout_ms).await {
        Ok(bytes) => Json(ReadResp { bytes }).into_response(),
        Err(e) => upstream_error(e),
    }
}

#[derive(Deserialize)]
struct CloseReq {
    conn: u64,
}

async fn tcp_close(State(t): State<Arc<MachineTransport>>, Json(req): Json<CloseReq>) -> Response {
    t.close(req.conn).await;
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct UdpReq {
    port: u16,
    window_ms: u64,
}

async fn udp_listen_handler(Json(req): Json<UdpReq>) -> Response {
    match udp_listen(req.port, req.window_ms).await {
        Ok(datagrams) => Json(datagrams).into_response(),
        Err(e) => upstream_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    fn post_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn body_json(res: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    // The five calls, end to end over the router, against a local TcpListener standing in for the
    // controller: connect -> write (the server reads it) -> read (what the server sends back) -> close.
    #[tokio::test]
    async fn connect_write_read_close_round_trips_over_http() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = routes(Arc::new(MachineTransport::default()));

        // The stand-in controller: read "ping", answer "pong".
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4];
            sock.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"ping");
            sock.write_all(b"pong").await.unwrap();
        });

        let res = app
            .clone()
            .oneshot(post_json(
                "/api/v1/machine/tcp/connect",
                serde_json::json!({ "host": addr.ip().to_string(), "port": addr.port(), "timeout_ms": 1000 }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let conn = body_json(res).await["conn"].as_u64().unwrap();

        let res = app
            .clone()
            .oneshot(post_json(
                "/api/v1/machine/tcp/write",
                serde_json::json!({ "conn": conn, "data": [0x70, 0x69, 0x6e, 0x67] }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let res = app
            .clone()
            .oneshot(post_json(
                "/api/v1/machine/tcp/read",
                serde_json::json!({ "conn": conn, "max": 64, "timeout_ms": 1000 }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = body_json(res).await["bytes"].clone();
        assert_eq!(bytes, serde_json::json!([0x70, 0x6f, 0x6e, 0x67])); // "pong"

        let res = app
            .clone()
            .oneshot(post_json("/api/v1/machine/tcp/close", serde_json::json!({ "conn": conn })))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        server.await.unwrap();
    }

    // A read on a connection that was closed is a 502 with the registry's own words, not an empty 200.
    #[tokio::test]
    async fn a_closed_connection_reads_as_bad_gateway() {
        let app = routes(Arc::new(MachineTransport::default()));
        let res = app
            .oneshot(post_json(
                "/api/v1/machine/tcp/read",
                serde_json::json!({ "conn": 999, "max": 16, "timeout_ms": 50 }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert!(body_json(res).await["error"].as_str().unwrap().contains("unknown connection"));
    }
}
