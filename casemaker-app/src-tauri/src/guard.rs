// The one place a WRITE has to prove it is Case Maker (#375).
//
// WHAT WAS WRONG. Decision 33 put the LAN at the trust boundary for the house's data — tools,
// inventory, feeds, cuts — and that is still true: the app serves one origin, a browser on the LAN
// is served that origin, and sharing a house on a home network is what the LAN is for. What decision
// 33 did not consider is that "a browser" and "a browser this app served" are not the same client. A
// page on ANY website, open in the user's own browser, can POST to
// `http://127.0.0.1:<port>/api/v1/import` — a CORS *simple* request, `Content-Type: text/plain`,
// needing no preflight this server never answers — and `import_house` takes the raw body and parses
// it by hand, so the write landed. The same shape reaches `/api/v1/catalogue/sync`, which needs no
// body at all. A rebound hostname is the same attack from the other side: by then the browser
// believes the request is same-origin, so there is no provenance header left to disagree with and
// the only tell is the name it addressed. `peer.ip().is_loopback()` — the settings endpoint's guard
// (decision 35) — cannot see any of this: the page is on this machine, so its peer IS loopback.
//
// WHAT THIS IS. One middleware over the whole `/api/v1` surface: every POST, PATCH and DELETE that
// the house service and the settings endpoint own, and any write added to them later, judged by the
// same three questions, each of which a page on another site cannot answer:
//
//   * `Host` names this server AND its port is the port this process serves on — `localhost`, an IP
//     literal, or the name Case Maker is configured to serve under, with the port stated or, when it
//     is not, the one the scheme defaults to. This is the one a REBOUND name fails: the browser sends
//     the name it believed it was talking to, and that name is the attacker's.
//   * `Origin` is absent, or is exactly `http://` + that same `Host`. A page on another site always
//     sends its own origin, and it cannot equal the address it is posting to — so this is what
//     separates a LAN browser reaching the app at `http://192.168.10.43:8000` (allowed: that IS the
//     app, served there) from a page at `https://evil.example` posting to it (refused).
//   * a request that DECLARES a body has to call it `application/json`. The type is the whole point:
//     it is the one Content-Type a cross-origin page cannot send without a preflight. See
//     `declares_a_body` for why the rule is phrased from the framing rather than unconditionally.
//
// Every request shape below was OBSERVED against a real browser rather than argued from the fetch
// spec (a Playwright page on one origin posting to a logging listener on another, plus the same page
// served from the listener's own origin as the control): a `text/plain` POST, a `TypedArray` body,
// a bodyless POST, a `<form>`, a JSON body in `cors` mode, and the app's own same-origin writes. The
// table is in `declares_a_body`'s note. #375 was filed because a client was assumed rather than
// looked at, so the fix is not going to be the second thing assumed.
//
// WHAT IT IS NOT. Not an identity: nothing here authenticates anyone. A client that is not a page at
// all — curl, a script, the installer, another Case Maker — sends no `Origin`, and its absence is
// not a refusal: it is a local process that could edit the files directly, so refusing it would buy
// nothing and break the tooling. Not a read guard either: GETs skip this entirely, because decision
// 33's LAN browser renders the same lists and reads the numbers it needs to explain what it is
// looking at — and that is a stated limitation rather than a gap in the reasoning, since a rebound
// name is same-origin to the browser on a `GET` as much as on anything else, so it can READ every
// read this API answers, `/api/v1/export` and the whole house document included. Decision 33 carries
// the note; what a hostile page gains there is a copy to send elsewhere, not a change to the house.
// And not a replacement for the settings endpoint's PEER check: "are you the app?" and
// "are you on this machine?" are different questions with different answers, and `/api/v1/config`
// asks both (decision 35).
//
// ORDER. The peer check stays in `config_api::write_config` and runs AFTER this, which is deliberate
// — see the note there — but the three checks here run before any body is read, so a client that may
// not write is never told what a valid request would have looked like.

use crate::config;
use crate::house_api::json_error;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::Router;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;

/// What a write is judged against: which port this process is serving on (a `Host` has to name it),
/// and where the settings file is, so the name the app was told to serve under can be read from it.
///
/// The path is state rather than a lookup of `config::config_path()`, for the reason `config_api`'s
/// is: a test must be able to point this at a `TempDir` instead of the settings of the machine
/// running the suite.
#[derive(Clone)]
pub struct Guard {
    serving_port: u16,
    config_path: Arc<PathBuf>,
}

impl Guard {
    pub fn new(serving_port: u16, config_path: PathBuf) -> Self {
        Self {
            serving_port,
            config_path: Arc::new(config_path),
        }
    }
}

/// Wrap the API surface in the guard.
///
/// `Router::layer` covers every route registered BEFORE it, and only those — which is why `server.rs`
/// calls this on the merged `/api/v1` routers and registers the SPA's asset routes afterwards. The
/// pages themselves are not writes and have no provenance to judge.
pub fn enforce(router: Router, guard: Guard) -> Router {
    router.layer(axum::middleware::from_fn_with_state(guard, app_writes_only))
}

/// The middleware. A safe method is passed through untouched; anything else has to pass all three
/// checks, and a refusal is the service's own `{"error": …}` shape — including the 415 that axum's
/// `Json` extractor used to produce for two of these endpoints, which was a refusal in plain text
/// and therefore read by `houseClient.ts` as "something other than the service" (that shape is also
/// what decision 35 asks for: the webview has to be able to show the reason).
async fn app_writes_only(State(guard): State<Guard>, req: Request, next: Next) -> Response<Body> {
    if is_safe(req.method()) {
        return next.run(req).await;
    }

    let host = header_str(req.headers(), header::HOST).unwrap_or_default();
    if !addressed_to_this_server(&host, guard.serving_port, configured_host(&guard).as_deref()) {
        return json_error(
            StatusCode::FORBIDDEN,
            format!(
                "Case Maker only accepts writes addressed to itself — localhost, an address the app \
                 is served at, or the name it is configured to serve under — and this request was \
                 addressed to {}.",
                said(&host)
            ),
        );
    }

    let origin = origin_of(req.headers());
    if !from_the_page_it_served(origin, &host) {
        return json_error(
            StatusCode::FORBIDDEN,
            format!(
                "Case Maker only accepts writes from the page it itself served at that address \
                 (http://{host}), and this request came from {}.",
                match origin {
                    Origin::At(stated) => format!("`{stated}`"),
                    Origin::Unreadable => "an `Origin` this server cannot read".to_string(),
                    Origin::Absent => "no origin at all".to_string(),
                }
            ),
        );
    }

    if declares_a_body(req.headers()) {
        let content_type = content_type_of(req.headers());
        if content_type.as_deref() != Some(APPLICATION_JSON) {
            return json_error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                format!(
                    "a write that carries a body has to be `{APPLICATION_JSON}`, and this one said {}.",
                    match content_type.as_deref() {
                        Some(t) => format!("`{t}`"),
                        None => "no Content-Type at all".to_string(),
                    }
                ),
            );
        }
    }

    next.run(req).await
}

/// The two provenance questions of the write guard, for a GET that still makes THIS SERVER open an
/// outgoing connection on the page's behalf (#530's camera proxy). Returns the refusal sentence, or
/// `None` when the request was addressed to this server by the page it served.
///
/// The third question — a body that declares itself JSON — is about writes that carry bytes, which a
/// WebSocket upgrade never does, so it does not belong here. The other two belong exactly as much:
/// a page on another site must not be able to make this server open a socket to a machine (the SSRF
/// the write guard exists to stop), and a rebound name is the same attack here as there.
pub fn foreign_page_refusal(guard: &Guard, headers: &HeaderMap) -> Option<String> {
    let host = header_str(headers, header::HOST).unwrap_or_default();
    if !addressed_to_this_server(&host, guard.serving_port, configured_host(guard).as_deref()) {
        return Some(format!(
            "Case Maker only opens a machine connection for a page it served itself — localhost, an \
             address the app is served at, or the name it is configured to serve under — and this \
             request was addressed to {}.",
            said(&host)
        ));
    }
    let origin = origin_of(headers);
    if !from_the_page_it_served(origin, &host) {
        return Some(format!(
            "Case Maker only opens a machine connection for the page it served at that address \
             (http://{host}), and this request came from {}.",
            match origin {
                Origin::At(stated) => format!("`{stated}`"),
                Origin::Unreadable => "an `Origin` this server cannot read".to_string(),
                Origin::Absent => "no origin at all".to_string(),
            }
        ));
    }
    None
}

const APPLICATION_JSON: &str = "application/json";

/// `GET`, `HEAD` and `OPTIONS` are not writes. `OPTIONS` is in the list because it is a preflight,
/// and this server answers none: letting it through to the API's own 405 says the truth (there is no
/// CORS answer here) rather than dressing a cross-origin preflight up as a refusal of a write.
fn is_safe(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
    headers.get(name)?.to_str().ok().map(str::to_string)
}

/// What the client said, for a refusal sentence: the header, or that there was none.
fn said(value: &str) -> String {
    if value.is_empty() {
        "no name at all".to_string()
    } else {
        format!("`{value}`")
    }
}

/// Whether a `Host` names this server.
///
/// Three things are accepted, and the reason each is: `localhost` is the machine under the name a
/// user types; an IP literal is an address the app is reachable at — every way a LAN browser gets
/// here is one, since it typed an address or a bookmark settled on one; and the settings file's
/// `host` covers a user who configured a name and reaches the app by it.
///
/// What is left out is a NAME that is not `localhost`: that is the only shape a rebound hostname
/// can take, and it cannot be told from a legitimate one by resolving it — by the time the request
/// arrives, the attacker's name resolves to this machine too, which is the whole trick. So a name
/// that is not the configured one is refused, and the sentence says which forms are accepted.
///
/// The port has to be the port this process serves on. A `Host` naming a different port is a
/// different origin, and after a rebind the port is the only part of the authority the attacker does
/// not get to choose. A header that states NO port names the scheme's default — 80 for `http`, and
/// this server speaks only `http` — so `Host: 127.0.0.1` is this process only when this process is ON
/// port 80. Writing the default out, rather than reading "no port stated" as "our port", is what
/// keeps a portless authority from being the one way past this check.
fn addressed_to_this_server(host: &str, serving_port: u16, configured: Option<&str>) -> bool {
    let Some((name, port)) = split_authority(host) else {
        return false;
    };
    if port.unwrap_or(80) != serving_port {
        return false;
    }
    if name.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if configured.is_some_and(|c| name.eq_ignore_ascii_case(c)) {
        return true;
    }
    name.parse::<IpAddr>().is_ok()
}

/// A `Host`'s host part and the port it states, or `None` when it is not a shape a `Host` can have.
///
/// `None` is a refusal rather than a shrug: `[::1]junk` and `evil.example:port` are not names this
/// server answers to, and a malformed authority is not one to guess about.
fn split_authority(authority: &str) -> Option<(&str, Option<u16>)> {
    if let Some(rest) = authority.strip_prefix('[') {
        // An IPv6 literal is bracketed, and the bracket is where its port starts.
        let (addr, tail) = rest.split_once(']')?;
        if addr.parse::<std::net::Ipv6Addr>().is_err() {
            return None;
        }
        return match tail.strip_prefix(':') {
            Some(port) => port.parse::<u16>().ok().map(|port| (addr, Some(port))),
            None if tail.is_empty() => Some((addr, None)),
            None => None,
        };
    }
    match authority.rsplit_once(':') {
        // A colon in an unbracketed authority means a port — an IPv6 literal has to be bracketed —
        // so a port that is not a number is a malformed header, not a name with a colon in it.
        Some((name, port)) => port.parse::<u16>().ok().map(|port| (name, Some(port))),
        None => Some((authority, None)),
    }
}

/// What a request's `Origin` header says, in THREE states rather than the two an `Option` gives.
///
/// The third is the reason this is a type and not a lookup: a header that is PRESENT but not text is
/// not an absent one, and folding the two together leaves the rule with exactly one bypass — state an
/// `Origin` the parser cannot read and be judged as the client that stated none. A header value
/// carries bytes above ASCII (`obs-text`) and `to_str` rejects them, so that state is one a request
/// can really reach. A browser writes visible ASCII, so the distinction costs a real client nothing.
#[derive(Clone, Copy)]
enum Origin<'a> {
    Absent,
    At(&'a str),
    Unreadable,
}

fn origin_of(headers: &HeaderMap) -> Origin<'_> {
    match headers.get(header::ORIGIN) {
        None => Origin::Absent,
        Some(value) => match value.to_str() {
            Ok(stated) => Origin::At(stated),
            Err(_) => Origin::Unreadable,
        },
    }
}

/// Whether a request's `Origin`, if it has one, is the page this server served at the address the
/// request was sent to.
///
/// The comparison is exact, because the value is a browser's own: `Origin` is a scheme, a host and a
/// port and never carries a path or a trailing slash. So a request that is same-origin by the
/// browser's own account — including a LAN browser reaching the app at its LAN address, which is
/// decision 33's everyday case — passes, and one from another site cannot: its origin names that
/// site, and the two cannot be made to agree by anything the page controls.
///
/// An ABSENT origin is not a refusal, and this is the one judgement here that is deliberately not
/// about attackers: `Origin` is sent by browsers, so a client without one is a process on this
/// machine that could edit the files directly. An UNREADABLE one is a refusal, which is the whole
/// reason the state exists — it is not a client that stated nothing, it is a client stating something
/// this server declines to guess at, and only an attacker has a reason to send it. (`Origin: null`,
/// which a sandboxed frame and a `file://` page do send, is text and simply does not match.)
///
/// That a same-origin POST carries one at all is observed and not assumed: the app's own page, served
/// from a listener on one origin, posted to that same origin with `Origin: http://127.0.0.1:8411` and
/// `Host: 127.0.0.1:8411` — equal to `http://` plus its own `Host`, which is what this comparison
/// wants. Had browsers omitted `Origin` on same-origin writes there would be nothing to compare and
/// the rule would have to be weaker; they do not, so it does not.
fn from_the_page_it_served(origin: Origin<'_>, host: &str) -> bool {
    match origin {
        Origin::Absent => true,
        Origin::At(stated) => stated == format!("http://{host}"),
        Origin::Unreadable => false,
    }
}

/// Whether a request says it is carrying a body.
///
/// The rule has to be framed from the message and not from the handler, because the request that
/// defeats "a write must be `application/json`" is a body with NO content type at all: a
/// `fetch(url, {method: 'POST', mode: 'no-cors', body: new TextEncoder().encode(json)})` — a
/// `TypedArray` body — is still a simple request, and the browser sets no `Content-Type` for it
/// (it does for a string, a `FormData`, a `Blob` and a `URLSearchParams`, which is why the type is
/// present on the ordinary attack and absent on this one).
///
/// So the test is the framing rather than a guess about the handler: HTTP/1.1 carries a body only
/// under a `Content-Length` or a `Transfer-Encoding`, and this server answers HTTP/1.1 only
/// (`Cargo.toml`: axum's `http1` feature alone, and no `h2`). A bodyless write — `POST
/// /api/v1/catalogue/sync`, both DELETEs, and the app's own client, which sends no `Content-Type`
/// when there is no body on purpose (`houseClient.send`) — is therefore judged by Host and Origin
/// alone, which it must be: a `Content-Type` with nothing after it is a request the service cannot
/// parse, and demanding one would make the app's own client the thing that is refused.
///
/// An unreadable `Content-Length` counts as a body. It cannot arrive through hyper, and assuming the
/// stricter answer costs nothing.
///
/// OBSERVED, on Chromium through Playwright, because this is the rule a reader is most likely to
/// think is over- or under-done. Each is what arrived at a logging listener, not what the spec says:
///
///   | what the page did                                      | Content-Type                | Content-Length |
///   | `fetch(…, {mode:'no-cors', headers:{'Content-Type':'text/plain'}, body:'…'})` | `text/plain`                | 26             |
///   | `fetch(…, {mode:'no-cors', body: new TextEncoder().encode('…')})`            | **absent**                  | 26             |
///   | `fetch(…, {mode:'no-cors', method:'POST'})` (no body)                        | absent                      | 0              |
///   | a `<form method=POST>` submit                                                | `application/x-www-form-urlencoded` | 20     |
///   | `fetch(…, {headers:{'Content-Type':'application/json'}, body:'…'})` cross-site | — only an `OPTIONS` preflight arrived |
///   | the app's own page, same-origin, JSON body                                   | `application/json`          | 26             |
///
/// Row 2 is the reason the rule is about the framing: the body is there and the type is not. Row 6 is
/// the reason the type can be demanded of the client at all: the app's own page sends it. Row 5 is why
/// the type rule is sufficient rather than merely a speed bump — a JSON body from another site never
/// reaches this server, because the preflight it needs is never answered.
fn declares_a_body(headers: &HeaderMap) -> bool {
    if headers.contains_key(header::TRANSFER_ENCODING) {
        return true;
    }
    match headers.get(header::CONTENT_LENGTH) {
        Some(len) => len
            .to_str()
            .ok()
            .and_then(|len| len.trim().parse::<u64>().ok())
            .map_or(true, |len| len > 0),
        None => false,
    }
}

/// The declared type, without its parameters — `application/json; charset=utf-8` is the same type as
/// `application/json`, which is the one the client sends.
fn content_type_of(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::CONTENT_TYPE)?.to_str().ok()?;
    Some(raw.split(';').next().unwrap_or(raw).trim().to_string())
}

/// The name the settings file says the app serves under, if any.
///
/// Read per request rather than captured at startup: `host` is written by `--host` and by the
/// installer, and the sentence a refused write gets should name what the file says NOW. It is a
/// small file and only writes reach this.
fn configured_host(guard: &Guard) -> Option<String> {
    config::load_from(&guard.config_path)
        .and_then(|cfg| cfg.host)
        .filter(|host| !host.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body as AxumBody;
    use axum::http::HeaderValue;
    use axum::http::Request as HttpRequest;
    use axum::routing::any;
    use std::path::PathBuf;
    use tempfile::TempDir;
    use tower::ServiceExt;

    const PORT: u16 = 5173;
    const APP_HOST: &str = "127.0.0.1:5173";
    const APP_ORIGIN: &str = "http://127.0.0.1:5173";

    /// The guard over a probe route, so what is being judged is the middleware and not any endpoint:
    /// a handler that answers 200 says "the guard let this through", and nothing about the guard
    /// depends on what is behind it.
    fn guarded(config_path: PathBuf) -> Router {
        enforce(
            Router::new().route("/api/v1/probe", any(|| async { "reached the handler" })),
            Guard::new(PORT, config_path),
        )
    }

    fn with_settings() -> (TempDir, Router) {
        let dir = TempDir::new().unwrap();
        let app = guarded(dir.path().join("config.json"));
        (dir, app)
    }

    /// A write with each provenance header a test wants to vary, and `None` for the ones it wants
    /// ABSENT — a different case from empty, for all three.
    ///
    /// `Content-Length` is written out because the FRAMING is what the guard judges a body by, and an
    /// in-process `Request` has no wire to have it added by: hyper sets it for a body it is about to
    /// write, and `oneshot` never gets that far. Without it every request below would look bodyless
    /// and the Content-Type rule would never be exercised — the test would pass by not asking.
    fn write_with(
        method: &str,
        host: Option<&str>,
        origin: Option<&str>,
        content_type: Option<&str>,
        body: &str,
    ) -> HttpRequest<AxumBody> {
        let mut builder = HttpRequest::builder()
            .method(method)
            .uri("/api/v1/probe")
            .header(header::CONTENT_LENGTH, body.len().to_string());
        if let Some(h) = host {
            builder = builder.header(header::HOST, h);
        }
        if let Some(o) = origin {
            builder = builder.header(header::ORIGIN, o);
        }
        if let Some(c) = content_type {
            builder = builder.header(header::CONTENT_TYPE, c);
        }
        builder.body(AxumBody::from(body.to_string())).unwrap()
    }

    async fn answer(app: &Router, req: HttpRequest<AxumBody>) -> (StatusCode, String, serde_json::Value) {
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, text, json)
    }

    #[tokio::test]
    async fn the_apps_own_page_writes_under_every_name_the_app_has() {
        // The window is loaded from `http://127.0.0.1:<port>`, and the other spellings are the same
        // machine under names a user types. A guard that refused them would refuse the app.
        for (host, origin) in [
            ("127.0.0.1:5173", "http://127.0.0.1:5173"),
            ("localhost:5173", "http://localhost:5173"),
            ("[::1]:5173", "http://[::1]:5173"),
        ] {
            let (_dir, app) = with_settings();
            let (status, text, _) = answer(
                &app,
                write_with("POST", Some(host), Some(origin), Some(APPLICATION_JSON), "{}"),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{host}: {text}");
        }

        // And the app served on the LAN (decision 33): the browser is at the address the app answers
        // on, and that is the origin it sends. This is the case the guard has to keep working, and it
        // is the reason the rule is "the page this server served" rather than "loopback only".
        let (_dir, app) = with_settings();
        let (status, text, _) = answer(
            &app,
            write_with(
                "POST",
                Some("192.168.10.43:5173"),
                Some("http://192.168.10.43:5173"),
                Some(APPLICATION_JSON),
                "{}",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}");

        // A name the settings file says the app serves under. A LAN user who reaches the app by a
        // configured name is not locked out of writing to it.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        config::save_to(
            &path,
            &config::AppConfig {
                port: 8000,
                bind_to_all: true,
                host: Some("bench-pc".to_string()),
            },
        )
        .unwrap();
        let (status, text, _) = answer(
            &guarded(path),
            write_with(
                "POST",
                Some("bench-pc:5173"),
                Some("http://bench-pc:5173"),
                Some(APPLICATION_JSON),
                "{}",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}");

        // A client that is not a page at all — curl, a script, the installer — carries no origin, and
        // that is not a refusal: it is a process on this machine, which could edit the file directly.
        for method in ["POST", "PATCH", "DELETE"] {
            let (_dir, app) = with_settings();
            let (status, text, _) =
                answer(&app, write_with(method, Some(APP_HOST), None, None, "")).await;
            assert_eq!(status, StatusCode::OK, "{method} without an origin: {text}");
        }
    }

    #[tokio::test]
    async fn every_shape_a_cross_site_page_can_send_is_refused_in_the_services_own_shape() {
        for (label, req) in [
            (
                "the browser's simple request: text/plain is a type no preflight is needed for",
                write_with(
                    "POST",
                    Some(APP_HOST),
                    Some("https://evil.example"),
                    Some("text/plain"),
                    r#"{"nope":true}"#,
                ),
            ),
            (
                "the same request as JSON, which a cross-origin page cannot send without a preflight",
                write_with(
                    "POST",
                    Some(APP_HOST),
                    Some("https://evil.example"),
                    Some(APPLICATION_JSON),
                    r#"{"nope":true}"#,
                ),
            ),
            (
                "(#375) a TYPED ARRAY body: bytes, and no Content-Type at all — still a simple request",
                write_with("POST", Some(APP_HOST), Some("https://evil.example"), None, r#"{"nope":true}"#),
            ),
            (
                "a page on the same LAN posting to a different address on it",
                write_with(
                    "POST",
                    Some(APP_HOST),
                    Some("http://192.168.10.99:5173"),
                    Some(APPLICATION_JSON),
                    r#"{"nope":true}"#,
                ),
            ),
            (
                "a rebound hostname: same-origin to the browser, and the name is the only tell",
                write_with(
                    "POST",
                    Some("evil.example:5173"),
                    None,
                    Some(APPLICATION_JSON),
                    r#"{"nope":true}"#,
                ),
            ),
            (
                "a rebound hostname that also states the right port and origin",
                write_with(
                    "POST",
                    Some("evil.example:5173"),
                    Some("http://evil.example:5173"),
                    Some(APPLICATION_JSON),
                    r#"{"nope":true}"#,
                ),
            ),
            (
                "a request with no Host at all, which is not a name this server answers to",
                write_with("POST", None, None, Some(APPLICATION_JSON), "{}"),
            ),
            (
                "a Host with a port this process is not on, which is a different origin",
                write_with(
                    "POST",
                    Some("127.0.0.1:9999"),
                    Some("http://127.0.0.1:9999"),
                    Some(APPLICATION_JSON),
                    "{}",
                ),
            ),
            (
                "a malformed authority, which is not a shape to guess about",
                write_with("POST", Some("[::1]junk"), None, Some(APPLICATION_JSON), "{}"),
            ),
            (
                "a portless Host, which names port 80 and not this server's port",
                write_with("POST", Some("127.0.0.1"), None, Some(APPLICATION_JSON), "{}"),
            ),
        ] {
            let (_dir, app) = with_settings();
            let (status, text, json) = answer(&app, req).await;
            assert!(
                matches!(status, StatusCode::FORBIDDEN | StatusCode::UNSUPPORTED_MEDIA_TYPE),
                "{label} answered {status}: {text}"
            );
            assert!(
                json["error"].is_string(),
                "{label} has to refuse in the service's own shape: {text}"
            );
            assert!(
                !text.contains("reached the handler"),
                "{label} reached the handler: {text}"
            );
        }
    }

    #[tokio::test]
    async fn a_body_must_declare_itself_json_but_a_write_without_one_needs_no_type() {
        // The type is what stops the simple request, so it is required whenever bytes are coming —
        // including the byte-array body whose type a browser never sets.
        for (label, content_type, body) in [
            ("no type at all", None, "{}"),
            ("the wrong type", Some("text/plain"), "{}"),
            ("a type that is nearly right", Some("text/json"), "{}"),
            ("the form encoding a <form> sends", Some("application/x-www-form-urlencoded"), "a=b"),
        ] {
            let (_dir, app) = with_settings();
            let (status, text, json) =
                answer(&app, write_with("POST", Some(APP_HOST), Some(APP_ORIGIN), content_type, body))
                    .await;
            assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{label}: {text}");
            assert!(
                json["error"]
                    .as_str()
                    .is_some_and(|m| m.contains(APPLICATION_JSON)),
                "{label} should name the type it takes: {text}"
            );
        }

        // A bodyless write carries no type, and demanding one would refuse the app's own client —
        // `POST /api/v1/catalogue/sync` and both DELETEs, which `houseClient.send` builds with the
        // body left off on purpose. A `Content-Length: 0` is what a browser sends with no body, and
        // it is not a body. The helper above writes exactly that for the empty string.
        for (label, req) in [
            ("a POST with nothing to say", write_with("POST", Some(APP_HOST), None, None, "")),
            (
                "a DELETE, which has no body to type",
                write_with("DELETE", Some(APP_HOST), None, None, ""),
            ),
        ] {
            let (_dir, app) = with_settings();
            let (status, text, _) = answer(&app, req).await;
            assert_eq!(status, StatusCode::OK, "{label}: {text}");
        }

        // A charset parameter is the same type, not another one.
        let (_dir, app) = with_settings();
        let (status, text, _) = answer(
            &app,
            write_with(
                "POST",
                Some(APP_HOST),
                Some(APP_ORIGIN),
                Some("application/json; charset=utf-8"),
                "{}",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}");
    }

    /// (#375) A present `Origin` this server cannot READ is a refusal, not an absent one. The
    /// `Option` a plain header lookup hands back conflates the two, and that conflation is the bypass
    /// this state exists to close: state an origin the parser cannot read and be judged as the client
    /// that stated none. A browser writes visible ASCII, so nothing real is refused by it.
    #[tokio::test]
    async fn an_origin_that_is_not_text_is_refused_rather_than_read_as_no_origin() {
        let (_dir, app) = with_settings();
        let json_write = || write_with("POST", Some(APP_HOST), None, Some(APPLICATION_JSON), "{}");

        // The control: the same write with no origin at all is the local client, and it goes through.
        let (status, text, _) = answer(&app, json_write()).await;
        assert_eq!(status, StatusCode::OK, "{text}");

        // The same request with an origin the server cannot read. `HeaderValue` carries `obs-text`,
        // and `to_str` rejects it — which is exactly the shape a client would send to be read as
        // having sent nothing.
        let mut req = json_write();
        req.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_bytes(b"http://127.0.0.1:5173\xff").expect("obs-text is a header byte"),
        );
        let (status, text, json) = answer(&app, req).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
        assert!(json["error"].is_string(), "{text}");
        assert!(!text.contains("reached the handler"), "{text}");
    }

    #[tokio::test]
    async fn reads_are_not_guarded() {
        // Decision 33/35: a browser on the LAN renders the same lists and needs them, so the guard
        // is a rule about WRITES. A GET is not judged on anything — the query string, the origin, the
        // name it was addressed to.
        for method in ["GET", "HEAD", "OPTIONS"] {
            let (_dir, app) = with_settings();
            let (status, text, _) = answer(
                &app,
                write_with(method, Some("evil.example:5173"), Some("https://evil.example"), None, ""),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{method}: {text}");
        }
    }

    #[test]
    fn an_authority_is_read_as_a_browser_writes_it() {
        // The pieces the middleware decides on, tested as the pure functions they are: brackets, a
        // stated port and its absence, and the three forms that name this machine.
        assert_eq!(split_authority("192.168.10.43:8000"), Some(("192.168.10.43", Some(8000))));
        assert_eq!(split_authority("localhost"), Some(("localhost", None)));
        assert_eq!(split_authority("[::1]:5173"), Some(("::1", Some(5173))));
        assert_eq!(split_authority("[::1]"), Some(("::1", None)));
        // Not shapes a `Host` can have, so they are refused rather than guessed at.
        assert_eq!(split_authority("[::1]junk"), None);
        assert_eq!(split_authority("[not-an-address]:5173"), None);
        assert_eq!(split_authority("evil.example:port"), None);

        assert!(addressed_to_this_server("localhost:5173", 5173, None));
        assert!(addressed_to_this_server("[::1]:5173", 5173, None));
        assert!(addressed_to_this_server("192.168.10.43:5173", 5173, None));
        assert!(addressed_to_this_server("bench-pc:5173", 5173, Some("bench-pc")));
        assert!(!addressed_to_this_server("bench-pc:5173", 5173, Some("other-pc")));
        assert!(!addressed_to_this_server("evil.example:5173", 5173, None));
        // A portless authority names the SCHEME's default — 80 for http — so it is this server only
        // when this server is on 80. Reading "no port stated" as "our port" would leave a portless
        // `Host` as the one way past the port check.
        assert!(!addressed_to_this_server("127.0.0.1", 5173, None));
        assert!(!addressed_to_this_server("localhost", 5173, None));
        assert!(!addressed_to_this_server("[::1]", 5173, None));
        assert!(addressed_to_this_server("127.0.0.1", 80, None));
        assert!(addressed_to_this_server("localhost", 80, None));
        assert!(addressed_to_this_server("[::1]", 80, None));
        // An IP literal at another port is another origin, and `2130706433` is `127.0.0.1` to a
        // resolver but not to `IpAddr` — which is the safe half to be on.
        assert!(!addressed_to_this_server("127.0.0.1:9999", 5173, None));
        assert!(!addressed_to_this_server("2130706433:5173", 5173, None));

        // The origin rule is exact, and its absence is a local process rather than an attacker.
        assert!(from_the_page_it_served(Origin::Absent, "127.0.0.1:5173"));
        assert!(from_the_page_it_served(Origin::At("http://127.0.0.1:5173"), "127.0.0.1:5173"));
        assert!(!from_the_page_it_served(Origin::At("https://evil.example"), "127.0.0.1:5173"));
        assert!(!from_the_page_it_served(Origin::At("http://127.0.0.1:5173"), "192.168.10.43:5173"));
        // Present but not text is its own answer rather than "no origin", and `null` — what a
        // sandboxed frame and a `file://` page send — is text that simply does not match.
        assert!(!from_the_page_it_served(Origin::Unreadable, "127.0.0.1:5173"));
        assert!(!from_the_page_it_served(Origin::At("null"), "127.0.0.1:5173"));
    }

    /// (#530) The provenance half the camera proxy asks. A page from another site cannot make this
    /// server open a socket to a machine; the app's own page — and a local client with no origin —
    /// still can.
    #[test]
    fn a_foreign_page_cannot_borrow_a_connection() {
        let dir = TempDir::new().unwrap();
        let guard = Guard::new(PORT, dir.path().join("config.json"));
        let headers = |host: Option<&str>, origin: Option<&str>| {
            let mut h = HeaderMap::new();
            if let Some(host) = host {
                h.insert(header::HOST, host.parse().unwrap());
            }
            if let Some(origin) = origin {
                h.insert(header::ORIGIN, origin.parse().unwrap());
            }
            h
        };
        assert_eq!(
            foreign_page_refusal(&guard, &headers(Some(APP_HOST), Some(APP_ORIGIN))),
            None,
            "the app's own page"
        );
        assert_eq!(
            foreign_page_refusal(&guard, &headers(Some(APP_HOST), None)),
            None,
            "a local client, which could edit the files directly"
        );
        for (what, h) in [
            ("another site's page", headers(Some(APP_HOST), Some("https://evil.example"))),
            (
                "a rebound name",
                headers(Some("evil.example:5173"), Some("http://evil.example:5173")),
            ),
            ("no address at all", headers(None, None)),
        ] {
            let refusal = foreign_page_refusal(&guard, &h);
            assert!(refusal.is_some(), "{what} must be refused");
            assert!(
                refusal.unwrap().contains("connection"),
                "{what} refuses with the reason, not a bare word"
            );
        }
    }

    #[test]
    fn a_body_is_read_from_the_framing_not_from_the_handler() {
        let mut headers = HeaderMap::new();
        assert!(!declares_a_body(&headers), "no framing at all");
        headers.insert(header::CONTENT_LENGTH, "0".parse().unwrap());
        assert!(!declares_a_body(&headers), "the Content-Length a browser sends with no body");
        headers.insert(header::CONTENT_LENGTH, "42".parse().unwrap());
        assert!(declares_a_body(&headers));
        let mut headers = HeaderMap::new();
        headers.insert(header::TRANSFER_ENCODING, "chunked".parse().unwrap());
        assert!(declares_a_body(&headers), "a chunked body has no Content-Length to read");
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, "not a number".parse().unwrap());
        assert!(declares_a_body(&headers), "unreadable framing is judged as a body");
    }
}
