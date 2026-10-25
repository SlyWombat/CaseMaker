// #530 — the Z1's camera over the embedded server.
//
// WHY THIS ROUTE EXISTS. The camera is a plain WebSocket on the machine (`ws://<host>:82/ws_video`,
// `Z1-Bridge-Protocol.md` §10): the client sends the text `start_stream` once connected and the
// ESP32 answers with complete 640×480 JPEGs. The desktop shell's webview can open that socket
// directly. A LAN browser served this SPA by `casemaker --bind-all` cannot — it has no raw sockets
// and, on an https page, no way to a `ws://` LAN address at all. So this is the camera's twin of
// `/api/v1/machine/*` (#571): the browser talks to this server on its own origin, and the server
// (on the LAN with the machine) owns the socket.
//
// WHAT IT MOVES. Bytes and nothing else. The text `start_stream` goes up; the JPEGs come down; this
// route forwards both directions and adds nothing — no framing, no timestamps, no retry. The replay
// skip and the stall reconnect are the client's (`cameraStream.ts`), because the page is what knows
// whether anyone is looking.
//
// THE QUERY NAMES A MACHINE, NOT AN ADDRESS. This route opens a socket from the server's own
// position on the LAN, so a free-form address would make the server a relay to anything it can
// reach. The provenance check below does not stop that on its own: the page this server served is
// ALLOWED to ask, so what it asks for has to be a machine the house knows. The location is the
// authority — a request is honoured only when one of its machine records has the host asked for AND
// that machine's profile's own camera port is the port asked for. Anything else is refused before a
// socket is opened. The path is the profile's too (`/ws_video`): the page cannot name it.
//
// PROVENANCE. A GET is not a write, so the write guard lets it through by design — but this GET makes
// the server open an outgoing connection, which is exactly the capability the guard withholds from a
// foreign page. The upgrade is therefore judged by the guard's two provenance questions before
// anything is dialled, and every refusal answers in the service's own `{"error": …}` shape.

use crate::guard::{foreign_page_refusal, Guard};
use crate::house::HouseStore;
use crate::house_api::json_error;
use crate::machine_profiles::{machines_in, standard_ports, PortsOf};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as Camera;

/// The camera module's path on the machine (`Z1-Bridge-Protocol.md` §10). NOT a query parameter:
/// a URL built from a page's string is the relay this route refuses to be.
const CAMERA_PATH: &str = "/ws_video";

/// How long the camera gets to answer the handshake. The machine's command port uses 3 s
/// (`DEFAULT_CONNECT_TIMEOUT_MS`); the camera module comes up a few seconds after 2222 at boot, so
/// this is a little more patient, and a failure is reported to the pane rather than left hanging.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct CameraState {
    guard: Guard,
    house: Arc<HouseStore>,
    /// The profile port table (#660 — shared with the `/api/v1/machine/*` bridge). Only the CAMERA
    /// port is honoured here; the forwarding test injects a stand-in camera's ephemeral port.
    port_of: PortsOf,
}

/// The `/api/v1/machine/camera` route, carrying the provenance guard and the house's location.
/// Merged into the API router BEFORE the guard layer, like `machine_api` — the layer then covers
/// this route by construction, and a GET passes it untouched.
pub fn routes(guard: Guard, house: Arc<HouseStore>) -> Router {
    build(guard, house, standard_ports())
}

fn build(guard: Guard, house: Arc<HouseStore>, port_of: PortsOf) -> Router {
    Router::new()
        .route("/api/v1/machine/camera", get(camera))
        .with_state(CameraState {
            guard,
            house,
            port_of,
        })
}

/// Which machine's camera: the host the page already drives, and the port its profile serves the
/// camera on. Both are checked against the location before anything is dialled.
#[derive(Deserialize)]
struct CameraQuery {
    host: String,
    port: u16,
}

async fn camera(
    State(state): State<CameraState>,
    headers: HeaderMap,
    Query(q): Query<CameraQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Some(refusal) = foreign_page_refusal(&state.guard, &headers) {
        return json_error(StatusCode::FORBIDDEN, refusal);
    }
    if let Some(refusal) = host_problem(&q.host) {
        return json_error(StatusCode::BAD_REQUEST, refusal);
    }
    if let Some(refusal) = unknown_machine(&state, &q.host, q.port).await {
        return json_error(StatusCode::FORBIDDEN, refusal);
    }
    let url = format!("ws://{}:{}{CAMERA_PATH}", q.host, q.port);
    upgrade.on_upgrade(move |client| proxy(client, url))
}

/// Whether a host the page named is a shape this server will put in a URL at all. It is not an
/// authorisation — the location is — but a host carrying a slash, a space or an `@` would make the
/// URL point somewhere other than the machine the page named, and that is worth refusing rather
/// than guessing at.
fn host_problem(host: &str) -> Option<String> {
    if host.is_empty() || host.len() > 253 {
        return Some("the camera request named no machine address".to_string());
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']'))
    {
        return Some(format!(
            "`{host}` is not a machine address this server will open a camera connection to"
        ));
    }
    None
}

/// THE KNOWN-MACHINE RULE. A host is honoured only when the location holds a machine record at that
/// address whose profile's camera is on exactly the port asked for. An unreadable location knows no
/// machines, so it refuses too — the route opens a socket, and "I could not read the list" is not
/// the same answer as "this is one of ours".
async fn unknown_machine(state: &CameraState, host: &str, port: u16) -> Option<String> {
    let machines = match machines_in(&state.house).await {
        Ok(machines) => machines,
        Err(refusal) => return Some(refusal),
    };

    let mut known_host = false;
    for machine in &machines {
        let Some(address) = &machine.address else {
            continue;
        };
        if address.host != host {
            continue;
        }
        known_host = true;
        let camera_port = machine
            .profile_id
            .as_deref()
            .and_then(|id| (state.port_of)(id))
            .and_then(|ports| ports.camera);
        if camera_port == Some(port) {
            return None;
        }
    }
    if known_host {
        Some(format!(
            "`{host}` is a machine this house knows, but its camera is not on port {port}."
        ))
    } else {
        Some(format!("`{host}` is not a machine this house knows."))
    }
}

/// Forward both directions until either end closes. The client's `start_stream` is what starts the
/// module; everything after it is a picture. A camera that does not answer is said in words to the
/// pane, which shows them and its own reconnect state.
async fn proxy(mut client: WebSocket, url: String) {
    let upstream = match tokio::time::timeout(UPSTREAM_TIMEOUT, tokio_tungstenite::connect_async(url.as_str())).await
    {
        Ok(Ok((stream, _response))) => stream,
        Ok(Err(e)) => {
            let _ = client
                .send(Message::Text(format!("the camera at {url} did not answer: {e}")))
                .await;
            let _ = client.close().await;
            return;
        }
        Err(_) => {
            let _ = client
                .send(Message::Text(format!(
                    "the camera at {url} did not answer within {} s",
                    UPSTREAM_TIMEOUT.as_secs()
                )))
                .await;
            let _ = client.close().await;
            return;
        }
    };

    // Two halves each, so the select can poll both ends without borrowing one socket twice.
    let (mut client_tx, mut client_rx) = client.split();
    let (mut camera_tx, mut camera_rx) = upstream.split();

    loop {
        tokio::select! {
            from_client = client_rx.next() => match from_client {
                Some(Ok(Message::Text(text))) => {
                    if camera_tx.send(Camera::Text(text.into())).await.is_err() { break; }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if camera_tx.send(Camera::Binary(bytes.into())).await.is_err() { break; }
                }
                // The browser's close is the pane closing or pausing: let the camera go with it.
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
            from_camera = camera_rx.next() => match from_camera {
                Some(Ok(Camera::Binary(bytes))) => {
                    if client_tx.send(Message::Binary(bytes.into())).await.is_err() { break; }
                }
                Some(Ok(Camera::Text(text))) => {
                    if client_tx.send(Message::Text(text.into())).await.is_err() { break; }
                }
                Some(Ok(Camera::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }

    let _ = camera_tx.close().await;
    let _ = client_tx.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::location::MachineRecord;
    use crate::machine_profiles::MachinePorts;
    use tempfile::TempDir;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    /// The machine the house knows, at a host that is not this test's loopback: the forwarding test's
    /// loopback is a SECOND record, and the refusal tests use this one.
    fn known_machine(id: &str, host: &str) -> MachineRecord {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "profileId": "Z1",
            "address": { "host": host, "port": 2222 },
            "updatedAt": "2026-10-25T00:00:00.000Z"
        }))
        .unwrap()
    }

    /// The app's route on an ephemeral port, over a house directory that holds `machines`, with the
    /// camera port injected so a stand-in camera can listen on one this profile would never name.
    async fn serve(
        dir: &TempDir,
        machines: Vec<MachineRecord>,
        camera_port: u16,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        let store = Arc::new(HouseStore::open_with(dir.path().to_path_buf(), None));
        for machine in machines {
            // `*` is the guard's own "whatever is there now" — a test seeding its own house.
            store.put_machine(machine, Some("*")).await.unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = build(
            Guard::new(port, dir.path().join("config.json")),
            store,
            Arc::new(move |_| {
                Some(MachinePorts {
                    command: 2222,
                    camera: Some(camera_port),
                    discovery: 3333,
                })
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, server)
    }

    /// A stand-in camera: accept ONE connection, speak WebSocket over it, demand `start_stream`, and
    /// answer with a JPEG-shaped binary frame (SOI … EOI).
    fn fake_camera(listener: TcpListener) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let first = ws.next().await.unwrap().unwrap();
            assert_eq!(first, Camera::Text("start_stream".to_string()));
            ws.send(Camera::Binary(vec![0xFF, 0xD8, 0xFF, 0xD9])).await.unwrap();
        })
    }

    fn camera_url(app_port: u16, host: &str, port: u16) -> String {
        format!("ws://127.0.0.1:{app_port}/api/v1/machine/camera?host={host}&port={port}")
    }

    // The two directions, end to end over real sockets: the pane's `start_stream` reaches the
    // camera, and the camera's JPEG comes back through the route unchanged — for a machine the
    // location knows.
    #[tokio::test]
    async fn a_known_machine_proxies_start_stream_and_the_frames() {
        let camera_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let camera_addr = camera_listener.local_addr().unwrap();
        let camera = fake_camera(camera_listener);

        let dir = TempDir::new().unwrap();
        let (port, server) = serve(
            &dir,
            vec![known_machine("m-1", "127.0.0.1")],
            camera_addr.port(),
        )
        .await;
        let (mut ws, _) = tokio_tungstenite::connect_async(camera_url(port, "127.0.0.1", camera_addr.port()))
            .await
            .unwrap();
        ws.send(Camera::Text("start_stream".to_string())).await.unwrap();
        let frame = ws.next().await.unwrap().unwrap();
        assert_eq!(frame, Camera::Binary(vec![0xFF, 0xD8, 0xFF, 0xD9]));

        camera.await.unwrap();
        server.abort();
    }

    // An address no machine record names is refused BEFORE a socket is opened: the server is not a
    // relay. The stand-in camera's accept is still waiting when the answer comes back.
    #[tokio::test]
    async fn an_unknown_host_is_refused_without_dialling_it() {
        let camera_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let camera_addr = camera_listener.local_addr().unwrap();

        let dir = TempDir::new().unwrap();
        let (port, server) = serve(
            &dir,
            vec![known_machine("m-1", "192.0.2.10")],
            camera_addr.port(),
        )
        .await;
        let refusal = tokio_tungstenite::connect_async(camera_url(port, "127.0.0.1", camera_addr.port()))
            .await
            .expect_err("no machine is at 127.0.0.1");
        match refusal {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
                let body = response.into_body().unwrap_or_default();
                let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert!(json["error"].as_str().unwrap().contains("not a machine this house knows"));
            }
            other => panic!("expected the service's own 403, got {other:?}"),
        }

        let quiet = tokio::time::timeout(Duration::from_millis(200), async {
            camera_listener.accept().await
        })
        .await;
        assert!(quiet.is_err(), "the socket must not be opened for an unknown address");
        server.abort();
    }

    // A machine the house knows, asked for on a port that is not its camera's, is a different
    // address than the one the location vouches for — refused, with the reason naming the port.
    #[tokio::test]
    async fn a_known_host_on_the_wrong_port_is_refused() {
        let dir = TempDir::new().unwrap();
        let (port, server) = serve(&dir, vec![known_machine("m-1", "192.0.2.10")], 82).await;
        match tokio_tungstenite::connect_async(camera_url(port, "192.0.2.10", 2222)).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
                let body = response.into_body().unwrap_or_default();
                let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert!(json["error"].as_str().unwrap().contains("camera is not on port 2222"));
            }
            other => panic!("expected the service's own 403, got {other:?}"),
        }
        server.abort();
    }

    // The rule itself, without the wire: a known machine on its profile's camera port is the only
    // address this route accepts.
    #[tokio::test]
    async fn the_known_machine_rule_is_the_location_and_the_profile() {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(HouseStore::open_with(dir.path().to_path_buf(), None));
        store.put_machine(known_machine("m-1", "192.0.2.10"), Some("*")).await.unwrap();
        let state = CameraState {
            guard: Guard::new(1, dir.path().join("config.json")),
            house: store.clone(),
            port_of: standard_ports(),
        };
        assert_eq!(unknown_machine(&state, "192.0.2.10", 82).await, None);
        assert!(unknown_machine(&state, "192.0.2.10", 2222)
            .await
            .unwrap()
            .contains("camera is not on port 2222"));
        assert!(unknown_machine(&state, "192.0.2.11", 82)
            .await
            .unwrap()
            .contains("not a machine this house knows"));
        // The port check is per PROFILE: a record whose profile this build cannot name has no
        // camera this build can vouch for.
        let mut other = known_machine("m-2", "192.0.2.12");
        other.profile_id = Some("OTHER".to_string());
        store.put_machine(other, Some("*")).await.unwrap();
        assert!(unknown_machine(&state, "192.0.2.12", 82)
            .await
            .unwrap()
            .contains("camera is not on port 82"));
    }

    // A page on another site cannot make this server open the socket: the upgrade is refused in the
    // service's own shape, and the camera never sees a connection.
    #[tokio::test]
    async fn a_foreign_page_is_refused_before_the_camera_is_dialled() {
        let camera_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let camera_addr = camera_listener.local_addr().unwrap();

        let dir = TempDir::new().unwrap();
        let (port, server) = serve(
            &dir,
            vec![known_machine("m-1", "127.0.0.1")],
            camera_addr.port(),
        )
        .await;
        let mut request = camera_url(port, "127.0.0.1", camera_addr.port())
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", "https://evil.example".parse().unwrap());

        match tokio_tungstenite::connect_async(request).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
                let body = response.into_body().unwrap_or_default();
                let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert!(json["error"].as_str().unwrap().contains("connection"));
            }
            other => panic!("the upgrade must be refused with the service's own 403, got {other:?}"),
        }

        let quiet = tokio::time::timeout(Duration::from_millis(200), async {
            camera_listener.accept().await
        })
        .await;
        assert!(quiet.is_err(), "the camera must not be contacted for a foreign page");
        server.abort();
    }

    #[test]
    fn a_host_that_is_not_an_address_is_refused() {
        assert_eq!(host_problem("192.168.10.43"), None);
        assert_eq!(host_problem("[fe80::1]"), None);
        assert!(host_problem("").is_some());
        assert!(host_problem("host/with/slashes").is_some());
        assert!(host_problem("user@host").is_some());
        assert!(host_problem("a host with spaces").is_some());
    }
}
