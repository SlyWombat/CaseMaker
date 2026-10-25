// The machine bridge over HTTP (#571, #660).
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
//
// THE KNOWN-MACHINE RULE (#660). `guard.rs` judges the PAGE; a LAN client with curl can pose as one
// (it can send, or omit, any header), so the guard's questions are not a claim about where the socket
// goes. This route therefore checks the TARGET too, against the two lists the request cannot extend:
// `location.json` says which machines exist and at what address, and the machine's profile names the
// ports its own services listen on (`machine_profiles.rs`). A connect to anything else is refused
// before `TcpStream::connect`; the udp listen binds only a profile's discovery port. What this
// closes is the RELAY property — the server can only be made to reach the house's own machines, on
// their own ports. What it does not claim is authentication; `docs/design/machine-bridge-threat-model.md`
// is the full note.

use crate::house::HouseStore;
use crate::house_api::json_error;
use crate::machine::{udp_listen, MachineTransport};
use crate::machine_profiles::{
    any_profile_discovers, machines_in, standard_ports, target_refusal, PortsOf,
};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone)]
struct MachineApiState {
    transport: Arc<MachineTransport>,
    house: Arc<HouseStore>,
    ports: PortsOf,
}

/// The `/api/v1/machine/*` surface, with its own connection registry and the house it resolves
/// targets against. Merge into the API router BEFORE the guard layer, so every call here is judged
/// the same as any other `/api/v1` write.
pub fn routes(transport: Arc<MachineTransport>, house: Arc<HouseStore>) -> Router {
    build(transport, house, standard_ports())
}

fn build(transport: Arc<MachineTransport>, house: Arc<HouseStore>, ports: PortsOf) -> Router {
    Router::new()
        .route("/api/v1/machine/tcp/connect", post(tcp_connect))
        .route("/api/v1/machine/tcp/write", post(tcp_write))
        .route("/api/v1/machine/tcp/read", post(tcp_read))
        .route("/api/v1/machine/tcp/close", post(tcp_close))
        .route("/api/v1/machine/udp/listen", post(udp_listen_handler))
        .with_state(MachineApiState {
            transport,
            house,
            ports,
        })
}

/// A machine/socket failure. 502 Bad Gateway: the request was well formed, the upstream (the
/// controller, or the socket) is what did not answer. The TypeScript transport throws the `error`
/// string, so the protocol layer sees the same words the Tauri path would have returned.
fn upstream_error(e: String) -> Response {
    json_error(StatusCode::BAD_GATEWAY, e)
}

/// A target this server will not dial (#660): 403, in the same `{"error": …}` shape as every other
/// refusal, and named so the person reading it knows which of the three facts failed.
fn target_forbidden(sentence: String) -> Response {
    json_error(StatusCode::FORBIDDEN, sentence)
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

async fn tcp_connect(State(state): State<MachineApiState>, Json(req): Json<ConnectReq>) -> Response {
    // THE TARGET IS CHECKED BEFORE THE SOCKET IS OPENED. Reading the location is cheap (it is in
    // memory) and this is the one call that names an address at all.
    let machines = match machines_in(&state.house).await {
        Ok(machines) => machines,
        Err(refusal) => return target_forbidden(refusal),
    };
    if let Some(refusal) = target_refusal(&machines, state.ports.as_ref(), &req.host, req.port) {
        return target_forbidden(refusal);
    }
    match state.transport.connect(&req.host, req.port, req.timeout_ms).await {
        Ok(conn) => Json(ConnectResp { conn }).into_response(),
        Err(e) => upstream_error(e),
    }
}

#[derive(Deserialize)]
struct WriteReq {
    conn: u64,
    data: Vec<u8>,
}

async fn tcp_write(State(state): State<MachineApiState>, Json(req): Json<WriteReq>) -> Response {
    match state.transport.write(req.conn, &req.data).await {
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

async fn tcp_read(State(state): State<MachineApiState>, Json(req): Json<ReadReq>) -> Response {
    match state.transport.read(req.conn, req.max, req.timeout_ms).await {
        Ok(bytes) => Json(ReadResp { bytes }).into_response(),
        Err(e) => upstream_error(e),
    }
}

#[derive(Deserialize)]
struct CloseReq {
    conn: u64,
}

async fn tcp_close(State(state): State<MachineApiState>, Json(req): Json<CloseReq>) -> Response {
    state.transport.close(req.conn).await;
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct UdpReq {
    port: u16,
    window_ms: u64,
}

async fn udp_listen_handler(State(state): State<MachineApiState>, Json(req): Json<UdpReq>) -> Response {
    // No host to resolve: the listen BINDS a local port, and its one use is discovery. So the rule
    // is the profiles' discovery ports — a list the request cannot extend, not a free bind.
    if !any_profile_discovers(state.ports.as_ref(), req.port) {
        return target_forbidden(format!(
            "no machine this house knows listens for discovery on port {}.",
            req.port
        ));
    }
    match udp_listen(req.port, req.window_ms).await {
        Ok(datagrams) => Json(datagrams).into_response(),
        Err(e) => upstream_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use crate::location::MachineRecord;
    use crate::machine_profiles::MachinePorts;
    use tempfile::TempDir;
    use tokio::net::TcpListener;
    use tokio::time::Duration;
    use tower::ServiceExt;

    fn post_json(uri: &str, body: serde_json::Value) -> axum::http::Request<Body> {
        axum::http::Request::builder()
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

    /// A machine record at `host`, with the Z1's profile — the house's own statement that this
    /// address is one of ours.
    fn machine(id: &str, host: &str) -> MachineRecord {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "profileId": "Z1",
            "address": { "host": host, "port": 2222 },
            "updatedAt": "2026-10-25T00:00:00.000Z"
        }))
        .unwrap()
    }

    /// The port table a test hands the route. `command` is the stand-in controller's ephemeral port,
    /// which no profile could ever name; the other two stay the Z1's own.
    fn ports(command: u16) -> MachinePorts {
        MachinePorts {
            command,
            camera: Some(82),
            discovery: 3333,
        }
    }

    /// The route on a house that holds `machines`, with `ports` as its profile table.
    async fn app_in(dir: &TempDir, machines: Vec<MachineRecord>, ports: MachinePorts) -> Router {
        let store = Arc::new(HouseStore::open_with(dir.path().to_path_buf(), None));
        for machine in machines {
            // `*` is the guard's own "whatever is there now" — a test seeding its own house.
            store.put_machine(machine, Some("*")).await.unwrap();
        }
        build(Arc::new(MachineTransport::default()), store, Arc::new(move |_| Some(ports)))
    }

    /// The common case: one known machine, the stand-in's command port.
    async fn app(dir: &TempDir, machines: Vec<MachineRecord>, command: u16) -> Router {
        app_in(dir, machines, ports(command)).await
    }

    // The five calls, end to end over the router, against a local TcpListener standing in for the
    // controller: connect -> write (the server reads it) -> read (what the server sends back) -> close.
    #[tokio::test]
    async fn connect_write_read_close_round_trips_over_http() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let dir = TempDir::new().unwrap();
        let app = app(&dir, vec![machine("m-1", "127.0.0.1")], addr.port()).await;

        // The stand-in controller: read "ping", answer "pong".
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4];
            tokio::io::AsyncReadExt::read_exact(&mut sock, &mut buf).await.unwrap();
            assert_eq!(&buf, b"ping");
            tokio::io::AsyncWriteExt::write_all(&mut sock, b"pong").await.unwrap();
        });

        let res = app
            .clone()
            .oneshot(post_json(
                "/api/v1/machine/tcp/connect",
                serde_json::json!({ "host": "127.0.0.1", "port": addr.port(), "timeout_ms": 1000 }),
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

    // #660 — an address no machine record names is refused BEFORE the socket is opened. The stand-in
    // controller's accept is still waiting when the refusal comes back.
    #[tokio::test]
    async fn an_unknown_host_is_refused_without_dialling_it() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let dir = TempDir::new().unwrap();
        // The house knows a machine — just not at this address.
        let app = app(&dir, vec![machine("m-1", "192.0.2.10")], addr.port()).await;

        let res = app
            .oneshot(post_json(
                "/api/v1/machine/tcp/connect",
                serde_json::json!({ "host": "127.0.0.1", "port": addr.port(), "timeout_ms": 1000 }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let json = body_json(res).await;
        assert!(
            json["error"].as_str().unwrap().contains("not a machine this house knows"),
            "{json}"
        );

        let quiet = tokio::time::timeout(Duration::from_millis(200), async {
            listener.accept().await
        })
        .await;
        assert!(quiet.is_err(), "the socket must not be opened for an unknown address");
    }

    // #660 — a machine the house knows, on a port its profile does not serve: also refused, and the
    // sentence names the port rather than pretending the machine is unknown.
    #[tokio::test]
    async fn a_known_host_on_an_unknown_port_is_refused() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir, vec![machine("m-1", "127.0.0.1")], 2222).await;
        let res = app
            .oneshot(post_json(
                "/api/v1/machine/tcp/connect",
                serde_json::json!({ "host": "127.0.0.1", "port": 9999, "timeout_ms": 1000 }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let json = body_json(res).await;
        assert!(json["error"].as_str().unwrap().contains("does not serve port 9999"), "{json}");
    }

    // A read on a connection that was closed is a 502 with the registry's own words, not an empty 200.
    #[tokio::test]
    async fn a_closed_connection_reads_as_bad_gateway() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir, vec![], 2222).await;
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

    // #660 — the two conn-addressed endpoints take no address, so the registry is their gate: a
    // write on an unknown id is the registry's refusal, and a close is idempotent by design.
    #[tokio::test]
    async fn the_conn_addressed_endpoints_are_gated_by_the_registry() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir, vec![], 2222).await;

        let res = app
            .clone()
            .oneshot(post_json(
                "/api/v1/machine/tcp/write",
                serde_json::json!({ "conn": 999, "data": [1] }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert!(body_json(res).await["error"].as_str().unwrap().contains("unknown connection"));

        let res = app
            .oneshot(post_json("/api/v1/machine/tcp/close", serde_json::json!({ "conn": 999 })))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT, "closing a dead connection is not a failure");
    }

    // #660 — the discovery listen binds only a port a profile of this build discovers on; anything
    // else is refused before a socket is bound.
    #[tokio::test]
    async fn the_udp_listen_refuses_a_port_no_profile_discovers_on() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir, vec![], 2222).await;
        let res = app
            .oneshot(post_json(
                "/api/v1/machine/udp/listen",
                serde_json::json!({ "port": 8080, "window_ms": 10 }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let json = body_json(res).await;
        assert!(json["error"].as_str().unwrap().contains("discovery on port 8080"), "{json}");
    }

    // #660 — and a known discovery port still listens: the rule is a bound, not a removal.
    #[tokio::test]
    async fn the_udp_listen_binds_a_known_discovery_port() {
        // A port picked by the OS and released: this test's stand-in for 3333, which the test
        // machine may already be using.
        let probe = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let discovery = probe.local_addr().unwrap().port();
        drop(probe);

        let dir = TempDir::new().unwrap();
        let app = app_in(
            &dir,
            vec![],
            MachinePorts {
                command: 2222,
                camera: Some(82),
                discovery,
            },
        )
        .await;
        let res = app
            .oneshot(post_json(
                "/api/v1/machine/udp/listen",
                serde_json::json!({ "port": discovery, "window_ms": 10 }),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await, serde_json::json!([]));
    }
}
