// The app's own settings, over HTTP (#372) — `/api/v1/config`, served by the same axum server as the
// house service and merged beside it.
//
// WHY THIS EXISTS. `SettingsMenu`'s "App port" field wrote `casemaker.settings.v1` in the webview's
// own storage and nothing ever read it back: `lib.rs` reads `config.json` (and `--port`), so the
// field has never changed the port the app binds to. After #312 that stopped being a dormant oddity
// and became an actively misleading control — the port is fixed and a taken one is a refusal with a
// dialog, so a field that looks like the way to answer that dialog, and is not, invites the user to
// "fix" the wrong thing. `Allow LAN access (bind 0.0.0.0)` beside it was the same defect: no reader
// in Rust. Both now write `config.rs::AppConfig`, here.
//
// A WRITE IS FOR THE NEXT LAUNCH, AND THAT IS NOT A LIMITATION. A live rebind would move the ORIGIN
// out from under the running page (decision 34): the window is loaded from
// `http://127.0.0.1:<port>`, so every origin-keyed store — settings, library, run records, the
// machine's own calibration — would be left behind while the page kept its old storage. So the
// response carries BOTH numbers: `port`, what the next launch will bind, and `servingPort`, what
// THIS process is bound to. `serving_port` is the listener's own port rather than the requested one
// because `0` asks the OS to choose (the tests do that), and only the listener knows the answer.
//
// LOOPBACK ONLY FOR THE WRITE, AND LOOPBACK IS NOT THE WHOLE GUARD (decision 35). Decision 33
// accepted no authentication for the HOUSE's data — tools, inventory, feeds and cuts are what the LAN
// is for. This endpoint writes the HOST PROCESS's own settings, and a client that can rewrite them can
// decide whether the host starts at all: point it at a busy port and the next launch is the refusal
// dialog; clear `bind_to_all` and the machine that just wrote it can no longer reach the app.
//
// SO THE PEER CHECK IS HERE AND THE PROVENANCE CHECKS ARE NOT (#375). A peer check alone would not
// have closed the settings: a page open in the user's OWN browser reaches this endpoint FROM loopback
// — the webview's machine and the page's machine are the same one — and a rebound hostname is worse,
// being same-origin to the browser with no provenance header left to disagree with. Those are the same
// two attacks `/api/v1/import` and `/api/v1/catalogue/sync` face, and the SAME rule answers all three,
// so it lives once in `guard.rs` and is applied over the whole `/api/v1` surface: over the merged API
// in `server.rs`, and again over these routes in `routes()` below, so that a settings write is guarded
// wherever this router is mounted rather than only where `server.rs` happens to put it.
// What stays here is the one question the guard does not ask and the house API does not want asked:
// "are you on the machine this process runs on?" A LAN browser may write the house and may not write
// these settings, and only this endpoint can draw that line.
//
// The order is guard first, then the peer: a client that may not write is refused before it is asked
// where it is. Both refusals name what would be accepted, and both use the service's `{"error": …}`
// shape — see `house_api::json_error`.
//
// The READ is not guarded (decision 33/35): a browser on the LAN renders the same dialog, and the
// numbers are how it explains why its write was declined.
//
// THE BODY IS PARSED HERE, NOT BY `axum::Json`. A JSON extractor's refusal is a plain-text body, and
// `houseClient.ts` reads anything that is not `{"error": …}` as "something other than the service
// answered" — the user would get a transport failure where there is a reason. `import_house` takes
// the raw body for the same reason. The body is deliberately narrow — `port` and `bind_to_all`, both
// required, and nothing else — and it MERGES into what the file holds rather than replacing it, so
// `host` (set by the installer's `/HOST=` or a hand edit; `--host` is per-run since #399 and never
// writes it) survives a save from the dialog. A body naming a field this endpoint does not own is
// REFUSED rather than ignored: a client that sent `host` would otherwise be told its write succeeded.

use crate::config::{self, AppConfig};
use crate::house_api::json_error;
use axum::body::{Body, Bytes};
use axum::extract::connect_info::ConnectInfo;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

/// What the settings endpoints need: which port this process is actually serving on, and which file
/// the settings live in.
///
/// The path is STATE rather than a lookup of `config::config_path()` inside the handlers, so a test
/// can run both endpoints against a `TempDir` — the same reason `HouseStore::open` takes a directory.
/// Without it, a test of the write would rewrite the settings of whichever machine ran the suite.
#[derive(Clone)]
pub struct ConfigApiState {
    serving_port: u16,
    path: Arc<PathBuf>,
}

/// The settings routes. `server.rs` merges this into the top-level router beside `house_api`, before
/// the SPA wildcard — the ordering note in that module applies unchanged (`/api/v1/*rest` in
/// `house_api` would otherwise be free to answer `/api/v1/config` with a JSON 404, and matchit gives
/// the static path priority).
///
/// The guard is applied HERE as well as over the merged API in `server.rs` (#375), so these routes
/// carry their own provenance check wherever they are mounted: a test, a second server, a future
/// caller that merges this router alone. That the check then runs twice on the real server is
/// deliberate and costs nothing — it is the same idempotent rule, so a request that passed the inner
/// one passes the outer, and the failure a duplicated check can produce is a refusal that would have
/// happened anyway.
pub fn routes(serving_port: u16, config_path: PathBuf) -> Router {
    let guarded = Router::new()
        .route("/api/v1/config", get(read_config).post(write_config))
        .with_state(ConfigApiState {
            serving_port,
            path: Arc::new(config_path.clone()),
        });
    crate::guard::enforce(guarded, crate::guard::Guard::new(serving_port, config_path))
}

/// What a client reads, from both endpoints: the settings as the file holds them, and the port this
/// process is serving on. `camelCase` on the wire, matching the house service's own JSON.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigView {
    port: u16,
    bind_to_all: bool,
    serving_port: u16,
}

/// The whole writable surface, and nothing else.
///
/// `deny_unknown_fields` is the point rather than a hardening: the body is a statement about the
/// settings, and a field this endpoint does not own (a client sending `host`, say) must not be
/// silently dropped while the response says the write went through.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ConfigWrite {
    port: u16,
    bind_to_all: bool,
}

fn view_of(cfg: &AppConfig, serving_port: u16) -> Response<Body> {
    let view = ConfigView {
        port: cfg.port,
        bind_to_all: cfg.bind_to_all,
        serving_port,
    };
    match serde_json::to_vec(&view) {
        Ok(bytes) => crate::house_api::json_body(StatusCode::OK, bytes),
        // Unreachable for three plain fields; a body-less 500 would at least not claim a success.
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the settings were read but could not be described: {e}"),
        ),
    }
}

/// Parse a request body into the write, or the sentence to refuse it with.
///
/// The body is parsed by hand rather than through `axum::Json` so the refusal keeps the service's
/// `{"error": …}` shape — see the module doc. The `Value` step is not ceremony: serde's derived
/// `Deserialize` accepts a struct from a JSON ARRAY as well as an object (the fields positionally),
/// so `[8123,false]` would otherwise be a valid write under a rule nothing documents. The endpoint
/// has one shape, the object its refusal sentence names.
fn parse_write(body: &[u8]) -> Result<ConfigWrite, String> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| format!("these are not Case Maker's settings: {e}."))?;
    if !value.is_object() {
        return Err("these are not Case Maker's settings: the body must be a JSON object.".to_string());
    }
    serde_json::from_value(value).map_err(|e| format!("these are not Case Maker's settings: {e}."))
}

/// Read the settings. Unguarded on purpose — see the module doc: the LAN is what decision 33's
/// no-auth rule is for, and reading is how a browser on it finds out what it is looking at.
async fn read_config(State(state): State<ConfigApiState>) -> Response<Body> {
    let cfg = config::load_from(&state.path).unwrap_or_default();
    view_of(&cfg, state.serving_port)
}

/// Write the settings, from this machine's own copy of the app and nowhere else.
///
/// ONE CHECK IS MADE HERE AND THREE WERE (#375). The host/origin/Content-Type rules are the guard's
/// now — they are the same rules `/api/v1/tools` and `/api/v1/import` live under, and `server.rs`
/// applies them over the whole API surface — so by the time this handler runs, the request has
/// already proved it came from the page this server served at the address it was addressed to. What
/// the guard cannot ask on the house's behalf is whether the caller is on this MACHINE, so that is
/// what is left, and why the peer is still judged here and before any body is read.
async fn write_config(
    State(state): State<ConfigApiState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response<Body> {
    // `to_canonical` because a dual-stack listener (`--host ::`) reports the webview as the
    // IPv4-mapped `::ffff:127.0.0.1`, which `is_loopback` does not recognise on an IPv6 address — the
    // app would refuse its own page.
    let ip = peer.ip().to_canonical();
    if !ip.is_loopback() {
        return json_error(
            StatusCode::FORBIDDEN,
            format!(
                "Case Maker's own settings can only be changed from the machine it runs on, and this \
                 request came from {ip}. Open the app on that machine, or start it with --port or \
                 --bind-all to change which port and address it serves on."
            ),
        );
    }

    let write = match parse_write(&body) {
        Ok(write) => write,
        Err(why) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("{why} This endpoint takes `port` (1024–65535) and `bindToAll`."),
            )
        }
    };

    if !config::valid_port(write.port) {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "{} is not a port Case Maker can use: it serves its own interface on this port, and \
                 1024–65535 is the range an application may take (below 1024 belongs to the system).",
                write.port
            ),
        );
    }

    // MERGE, do not replace: the file may hold a `host` this endpoint has no field for, and a save
    // from the dialog must not quietly drop the way the app was told to bind.
    let mut cfg = config::load_from(&state.path).unwrap_or_default();
    cfg.port = write.port;
    cfg.bind_to_all = write.bind_to_all;
    if let Err(e) = config::save_to(&state.path, &cfg) {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the settings were not saved to {}: {e}", state.path.display()),
        );
    }
    view_of(&cfg, state.serving_port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, Request};
    use tempfile::TempDir;
    use tower::ServiceExt;

    /// A router over a temp settings file, so a test never rewrites the settings of the machine
    /// running it.
    fn app_under_test() -> (TempDir, Router) {
        let dir = TempDir::new().unwrap();
        let settings = dir.path().join("config.json");
        (dir, routes(5173, settings))
    }

    /// A request from a chosen peer.
    ///
    /// `ConnectInfo` is inserted into the request's own extensions: that is the same place
    /// `axum::serve(… into_make_service_with_connect_info …)` puts the real one, and it is the only
    /// way to write a test for a LAN peer from a test host that can only reach itself. The PLUMBING
    /// — that the real server populates one at all — cannot be tested here, and is tested over a
    /// real socket in `server.rs`.
    fn with_peer(mut req: Request<Body>, addr: &str) -> Request<Body> {
        req.extensions_mut()
            .insert(ConnectInfo(addr.parse::<SocketAddr>().unwrap()));
        req
    }

    fn get_from(addr: &str) -> Request<Body> {
        with_peer(
            Request::builder()
                .uri("/api/v1/config")
                .header(header::HOST, APP_HOST)
                .body(Body::empty())
                .unwrap(),
            addr,
        )
    }

    /// The app's own window: the name and port a request from its own page arrives under. `routes`
    /// serves 5173 in these tests, so this is the whole of the "is this the app itself" answer.
    const APP_HOST: &str = "127.0.0.1:5173";
    const APP_ORIGIN: &str = "http://127.0.0.1:5173";

    /// A write as the app's own page sends it: from this machine, JSON, addressed to the app, with
    /// the app's own origin.
    fn post_from(addr: &str, body: &str) -> Request<Body> {
        write_with(addr, Some(APP_HOST), Some(APP_ORIGIN), Some("application/json"), body)
    }

    /// A write with each provenance header a test wants to vary, and `None` for the ones it wants
    /// ABSENT — which is a different case from empty, for all three.
    fn write_with(
        addr: &str,
        host: Option<&str>,
        origin: Option<&str>,
        content_type: Option<&str>,
        body: &str,
    ) -> Request<Body> {
        let mut builder = Request::builder().method("POST").uri("/api/v1/config");
        if let Some(h) = host {
            builder = builder.header(header::HOST, h);
        }
        if let Some(o) = origin {
            builder = builder.header(header::ORIGIN, o);
        }
        if let Some(c) = content_type {
            builder = builder.header(header::CONTENT_TYPE, c);
        }
        with_peer(builder.body(Body::from(body.to_string())).unwrap(), addr)
    }

    async fn json_of(app: &Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).expect("a JSON body"))
    }

    fn written(dir: &TempDir) -> AppConfig {
        config::load_from(&dir.path().join("config.json")).expect("the settings file")
    }

    #[tokio::test]
    async fn the_settings_are_read_as_the_file_holds_them() {
        let (dir, app) = app_under_test();
        config::save_to(
            &dir.path().join("config.json"),
            &AppConfig {
                port: 8123,
                bind_to_all: true,
                host: None,
            },
        )
        .unwrap();

        let (status, body) = json_of(&app, get_from("127.0.0.1:5555")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["port"], serde_json::json!(8123));
        assert_eq!(body["bindToAll"], serde_json::json!(true));
        // The port this process is serving on, not the configured one: after a save the two
        // disagree, and that disagreement is the whole of what the dialog has to say.
        assert_eq!(body["servingPort"], serde_json::json!(5173));
    }

    #[tokio::test]
    async fn a_fresh_install_reads_the_defaults_rather_than_failing() {
        // No file at all: a first run is 8000/loopback, which is what `AppConfig::default` says and
        // what `load_config` falls back to. Reading must not need the file to exist first.
        let (dir, app) = app_under_test();
        assert!(!dir.path().join("config.json").exists());
        let (status, body) = json_of(&app, get_from("127.0.0.1:5555")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["port"], serde_json::json!(config::DEFAULT_PORT));
        assert_eq!(body["bindToAll"], serde_json::json!(false));
    }

    #[tokio::test]
    async fn a_write_saves_the_file_and_answers_with_both_ports() {
        let (dir, app) = app_under_test();
        let (status, body) = json_of(
            &app,
            post_from("127.0.0.1:5555", r#"{"port":8123,"bindToAll":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // What the next launch will bind, and what this one is bound to — the pair the dialog warns
        // about, and the reason a save is a promise about a restart rather than a live rebind.
        assert_eq!(body["port"], serde_json::json!(8123));
        assert_eq!(body["bindToAll"], serde_json::json!(true));
        assert_eq!(body["servingPort"], serde_json::json!(5173));

        // The file is the point: `lib.rs` reads `config.json` and nothing else.
        let on_disk = written(&dir);
        assert_eq!(on_disk.port, 8123);
        assert!(on_disk.bind_to_all);
    }

    #[tokio::test]
    async fn a_write_merges_into_the_file_and_keeps_the_host_it_does_not_own() {
        // `host` is set by the installer's `/HOST=` or a hand edit (`--host` is a per-run override
        // since #399 and never writes the field), never by this dialog, and it has no field here. A
        // save from the dialog has to leave it alone: an explicit listen address is how a user said
        // which interface to serve on, and dropping it would silently move the app back to loopback
        // at the next launch.
        let (dir, app) = app_under_test();
        let path = dir.path().join("config.json");
        config::save_to(
            &path,
            &AppConfig {
                port: 8000,
                bind_to_all: false,
                host: Some("192.168.10.16".to_string()),
            },
        )
        .unwrap();

        let (status, _) = json_of(
            &app,
            post_from("127.0.0.1:5555", r#"{"port":8123,"bindToAll":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let on_disk = written(&dir);
        assert_eq!(on_disk.port, 8123);
        assert!(on_disk.bind_to_all);
        assert_eq!(on_disk.host.as_deref(), Some("192.168.10.16"));
    }

    /// A write from another machine is refused, and this is now the ONLY check this handler makes
    /// about who is asking (#375 moved the host/origin/Content-Type rules into `guard.rs`, where the
    /// whole API shares them — `server.rs`'s tests exercise them over this route too). What is left
    /// here is a question the house API does not want asked at all: a LAN browser may write the
    /// house and may not write these settings.
    #[tokio::test]
    async fn a_write_from_another_machine_is_refused_and_changes_nothing() {
        let (dir, app) = app_under_test();
        let path = dir.path().join("config.json");
        config::save_to(&path, &AppConfig::default()).unwrap();

        let (status, body) = json_of(
            &app,
            post_from("192.168.10.44:5555", r#"{"port":8123,"bindToAll":false}"#),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let message = body["error"].as_str().unwrap();
        assert!(message.contains("192.168.10.44"), "name the peer: {message}");
        assert!(
            message.contains("machine it runs on"),
            "say that this is a rule, not a failure: {message}"
        );
        assert_eq!(written(&dir).port, config::DEFAULT_PORT);

        // The IPv6 loopback is loopback too: a test host that reaches the app over `::1` is this
        // machine, and refusing it would refuse the app's own webview on some configurations.
        let (status, _) = json_of(
            &app,
            post_from("[::1]:5555", r#"{"port":8123,"bindToAll":false}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(written(&dir).port, 8123);
    }

    /// The three provenance checks this endpoint used to make for itself are the guard's now (#375),
    /// and they are tested where the whole API is put under them: `guard.rs` for the rules and
    /// `server.rs` for their placement over this route and every other write. What is left below is
    /// what only this handler knows — the peer, the body's shape, and the port.
    #[tokio::test]
    async fn a_port_outside_the_range_is_refused_with_the_range() {
        let (dir, app) = app_under_test();
        config::save_to(&dir.path().join("config.json"), &AppConfig::default()).unwrap();

        for bad in ["80", "1023", "65536"] {
            let (status, body) = json_of(
                &app,
                post_from(
                    "127.0.0.1:5555",
                    &format!(r#"{{"port":{bad},"bindToAll":false}}"#),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "port {bad}");
            let message = body["error"].as_str().unwrap();
            assert!(message.contains(bad), "name the port that was refused: {message}");
            assert!(
                message.contains("1024") && message.contains("65535"),
                "state the range that would be accepted: {message}"
            );
            // The clamp `load_from` applies is for a hand-edited file; a refused WRITE must not
            // leave 8000 behind it, which would be a silent change to a setting nobody chose.
            assert_eq!(written(&dir).port, config::DEFAULT_PORT);
        }
    }

    #[tokio::test]
    async fn a_body_that_is_not_the_settings_is_refused_in_the_services_own_shape() {
        // `houseClient.ts` reads a refusal only from `{"error": …}`; anything else it reports as
        // "somebody other than the service answered", which is a transport failure to the user and
        // throws away the reason. So the refusal here has to carry the shape even though the body
        // was unreadable.
        let (dir, app) = app_under_test();
        for (label, body) in [
            ("not JSON at all", "port=8123"),
            ("an array", "[8123,false]"),
            ("the wrong type", r#"{"port":"8123","bindToAll":false}"#),
            ("a field missing", r#"{"port":8123}"#),
            // A field this endpoint does not own is refused rather than dropped: a client that sent
            // `host` would otherwise be told the save went through.
            ("a field it does not own", r#"{"port":8123,"bindToAll":false,"host":"10.0.0.1"}"#),
        ] {
            let (status, json) = json_of(&app, post_from("127.0.0.1:5555", body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}");
            assert!(json["error"].is_string(), "{label} answered {json}");
            assert!(
                json["error"].as_str().unwrap().contains("port"),
                "{label} should say what the endpoint takes: {json}"
            );
        }
        assert!(!dir.path().join("config.json").exists(), "nothing may have been written");
    }

    #[tokio::test]
    async fn a_read_from_another_machine_is_answered() {
        // Unread is not unwritable (decision 33 for the data, decision 35 for this one endpoint): a
        // browser on the LAN renders the same dialog, and the numbers are how it explains itself.
        let (dir, app) = app_under_test();
        config::save_to(
            &dir.path().join("config.json"),
            &AppConfig {
                port: 8123,
                bind_to_all: true,
                host: None,
            },
        )
        .unwrap();
        let (status, body) = json_of(&app, get_from("192.168.10.44:5555")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["port"], serde_json::json!(8123));
    }
}
