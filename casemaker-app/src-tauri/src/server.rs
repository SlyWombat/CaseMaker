use crate::etag::{etag_for, if_none_match_covers};
use crate::house::{HouseLock, HouseStore};
use axum::{
    body::Body,
    extract::Path as AxumPath,
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use rust_embed::RustEmbed;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::oneshot;

#[derive(RustEmbed)]
#[folder = "../dist/"]
#[exclude = "*.map"]
struct Assets;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub requested_port: u16,
    pub bind_to_all: bool,
    /// Optional explicit listen IP. Wins over `bind_to_all` when set and
    /// parses as a valid IP. Empty string / invalid IP / an IPv6 literal → fall back to the
    /// bind_to_all / 127.0.0.1 behaviour (`bind_addr_for`, and #401 for why IPv6 is refused).
    pub host: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct ServerHandle {
    pub bound_port: u16,
    pub bind_addr: IpAddr,
}

/// Why a `host` setting cannot be used, if it cannot (#401). `None` means it can.
///
/// One rule with two readers, because it decides two different things: `bind_addr_for` warns with
/// this and binds the default, and `lib.rs` refuses to SAVE a `--host` that answers `Some` here —
/// `--host` is persisted (#399), and a saved host is the address of every later launch, so a
/// refused value written once is a refusal on every launch after it.
///
/// An IPv6 literal is a real address this shell cannot serve. It BINDS — the OS does that happily —
/// but the window's origin is built from the same address, and there it is a URLPattern, where
/// `[::1]` is not the address: a bare `:` opens a named group, so the pattern does not parse at all,
/// and Tauri PANICS on a pattern it cannot parse rather than refusing it.
///
/// Refused rather than supported: nobody has asked to serve the app over IPv6, the bench LAN is
/// IPv4, and supporting it means two spellings of the one address — the pattern needs the colons
/// escaped (`[\:\:1]`) and the URL must not have them (`[::1]`) — so `window_capability` would have
/// to take a pattern as well as the origin.
///
/// A host that is not an address at all is NOT refused here. That is the older route: it is saved,
/// and `bind_addr_for` warns about it at bind time.
pub fn host_refusal(host: &str) -> Option<&'static str> {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => Some("IPv6 is not supported"),
        _ => None,
    }
}

/// The address to bind: the three settings and nothing else — the one place they become a socket
/// address (`config.rs`'s `host` field says why there is only one).
///
/// An absent or empty host, a host that is not an address at all, and an IPv6 literal all end at the
/// same default: loopback, or every interface if `--bind-all` asked for it. The default is where a
/// *port* is deliberately different — a different port is a different origin, and there is no
/// fallback to it (#312) — but nothing about an unusable ADDRESS reaches the window, because
/// `lib.rs` builds the window's origin from this same value.
fn bind_addr_for(host: Option<&str>, bind_to_all: bool) -> IpAddr {
    let fallback = if bind_to_all {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let Some(h) = host.filter(|h| !h.is_empty()) else {
        return fallback;
    };
    if let Some(why) = host_refusal(h) {
        log::warn!("{why} (host '{h}'); falling back to {fallback}");
        return fallback;
    }
    match h.parse::<IpAddr>() {
        Ok(ip) => ip,
        Err(_) => {
            log::warn!("invalid host '{h}'; falling back to {fallback}");
            fallback
        }
    }
}

/// Start the HTTP server on a background tokio task: the SPA's static assets, and the house service
/// under `/api/v1` (#306). Both are served from this one listener, because a second port would need
/// its own discovery on the client and its own firewall story on Windows for no gain.
///
/// `house` is the held lock on the house directory, and it is a PARAMETER rather than something this
/// function looks up (#321) for one reason: the store below is opened over `house.dir()`, so "the
/// process serving the house is the process holding its lock" is a thing the compiler checks. A
/// second instance cannot reach the store without the lock, because `lib.rs` cannot acquire it while
/// the first instance holds it.
///
/// `config_path` is where the settings endpoints (#372) read and write, and it is a parameter for
/// the same reason: `config::config_path()` is the developer's own settings file, and a test that
/// reached it would rewrite the settings of whichever machine ran the suite.
///
/// Returns the bound port — which, with no fallback left to move to (#312), is `requested_port`
/// unless the caller asked for 0 and let the OS choose (the tests do, so they never race a real
/// port). The returned receiver fires when the server stops.
pub fn start(
    cfg: ServerConfig,
    house: &HouseLock,
    config_path: PathBuf,
) -> Result<(ServerHandle, oneshot::Receiver<()>), std::io::Error> {
    let bind_addr = bind_addr_for(cfg.host.as_deref(), cfg.bind_to_all);

    // The requested port, or a refusal. There is deliberately NO ephemeral fallback (#312): the
    // webview is loaded from `http://127.0.0.1:<bound_port>`, so a different port is a different
    // ORIGIN, and every origin-keyed store goes with it — `casemaker.settings.v1` (the saved vise
    // and stack, the machine calibration), `casemaker.library.v1`, `casemaker.machine.v1`, the
    // engrave job and the run records. The app would then open looking exactly like a first run,
    // with the user's data still on disk under a port they no longer know. Refusing to start is the
    // only failure that loses nothing, so `AddrInUse` is reported rather than stepped around.
    let listener = TcpListener::bind(SocketAddr::new(bind_addr, cfg.requested_port)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                format!(
                    "port {} is already in use.\n\n\
                     Case Maker serves its own interface from this port, and it has to be this one: \
                     a different port is a different origin, and the app would come up with your \
                     saved settings, library and run records missing.\n\n\
                     Close whatever holds port {}, then start Case Maker again. (Starting with \
                     --port also works, but the port you pass is saved as the configured port, so \
                     later runs use it too — and it is a different origin: the app would open \
                     empty, with today's data left behind on this one.)",
                    cfg.requested_port, cfg.requested_port
                ),
            )
        } else {
            e
        }
    })?;
    listener.set_nonblocking(true)?;
    let local_addr = listener.local_addr()?;
    let handle = ServerHandle {
        bound_port: local_addr.port(),
        bind_addr,
    };

    let (tx, rx) = oneshot::channel::<()>();
    // The house's data, loaded once at start-up. `open` never fails — a directory that is not there
    // yet is a house with no tools, and a file that cannot be read is reported by `/api/v1/health`
    // rather than by refusing to serve the UI.
    let store = Arc::new(HouseStore::open(house.dir().to_path_buf()));
    let app = router(store, handle.bound_port, config_path);

    std::thread::Builder::new()
        .name("casemaker-http".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    log::error!("failed to build tokio runtime: {e}");
                    let _ = tx.send(());
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!("failed to convert listener: {e}");
                        let _ = tx.send(());
                        return;
                    }
                };
                if let Err(e) = axum::serve(
                    listener,
                    // #372 — WITH CONNECT INFO, because `config_api` refuses a settings write from
                    // any peer that is not loopback, and `ConnectInfo<SocketAddr>` is the only thing
                    // that tells a handler where the request came from. Without this the extractor
                    // fails and every settings write answers 500 — a plain `axum::serve(listener,
                    // app)` cannot be tested into correctness, so `a_settings_write_over_the_wire`
                    // below goes through this exact call and a real socket.
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await
                {
                    log::error!("axum server stopped: {e}");
                }
                let _ = tx.send(());
            });
        })?;

    Ok((handle, rx))
}

/// The whole surface, in one router: the house service's API first, then the SPA's assets.
///
/// The ORDER is the point (#306). `serve_asset` answers any path it does not know with
/// `index.html` and status 200, so a client probing `/api/v1/health` on a server without the API
/// merged in would get a perfectly successful-looking HTML response. `house_api::routes` owns every
/// `/api/v1/…` path including a JSON 404 for the ones it does not have, and it is merged BEFORE the
/// `/*path` fallback is registered. The test below pins that against this exact router.
///
/// `config_api::routes` (#372) is merged alongside it — the app's own settings are part of the same
/// `/api/v1` surface and take the same ordering rule. `house_api`'s `/api/v1/*rest` 404 and the
/// static `/api/v1/config` can coexist: matchit gives a static path priority, so the catch-all only
/// ever answers what neither module owns.
///
/// THE GUARD GOES ON THE API, AND THE ORDER HERE IS THE WHOLE OF IT (#375). `Router::layer` covers
/// the routes registered before it and only those, so wrapping the two merged API modules is what
/// makes "every write under `/api/v1` proves it is Case Maker" true by construction: an endpoint
/// added to either module later is inside the layer without anyone remembering to add it, and the
/// SPA's own routes — registered below, outside it — are pages, which have no provenance to judge.
/// `guard.rs` holds the rules; `every_write_under_the_api_is_guarded` below is the test that fails if
/// this line is ever moved after the last `route`.
fn router(store: Arc<HouseStore>, serving_port: u16, config_path: PathBuf) -> Router {
    let api = Router::new()
        .merge(crate::config_api::routes(
            serving_port,
            config_path.clone(),
        ))
        .merge(crate::house_api::routes(store));
    crate::guard::enforce(api, crate::guard::Guard::new(serving_port, config_path))
        .route("/", get(serve_root))
        .route("/*path", get(serve_path))
}

async fn serve_root(headers: HeaderMap) -> impl IntoResponse {
    serve_asset("index.html", &headers)
}

async fn serve_path(AxumPath(path): AxumPath<String>, headers: HeaderMap) -> impl IntoResponse {
    serve_asset(&path, &headers)
}

/// Issue #47 — Content Security Policy that works regardless of bind host.
///
/// `'self'` covers same-origin requests on whatever IP / port the server
/// actually bound to (loopback, LAN, or any future case), so the SPA can
/// always fetch its own chunks. We additionally allow the Tauri webview's
/// IPC origins and `wasm-unsafe-eval` for the manifold-3d worker. `unsafe-eval` as well: Manifold's
/// emscripten embind glue builds its method callers with `Function(...)` at startup, so without it
/// the geometry and sim workers fail to start and nothing renders or generates (found at the bench,
/// 2026-10-12). Every script here is still `'self'`; no remote origin can supply one.
///
/// The font stack is LOCAL BY DESIGN (#330), which is why there is still no `font-src` here and no
/// exception for a font CDN: Space Grotesk, Inter and JetBrains Mono are served from this app's own
/// `public/fonts/` (`/fonts/fonts.css` + three woff2), so `default-src 'self'` already covers them.
/// The same string is `app.security.csp` in `tauri.conf.json` and the two must stay in step.
const CSP_HEADER: &str = "default-src 'self' tauri: ipc: http://ipc.localhost; \
img-src 'self' data: blob: tauri: ipc: http://ipc.localhost; \
style-src 'self' 'unsafe-inline'; \
script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' tauri: ipc: http://ipc.localhost; \
worker-src 'self' blob:; \
connect-src 'self' ws: wss: tauri: ipc: http://ipc.localhost";

/// The hashed-name directory in `dist/`: every file under it is `name-<hash>.ext`, so its name
/// changes when its content does and it can be cached for ever (#313).
const HASHED_ASSETS: &str = "assets/";

/// The SPA shell. Its NAME does not change when its content does, which is the whole of #313: it is
/// the one file that must not be cached blind.
const SHELL: &str = "index.html";

/// How long a served file may be reused without asking, and the validator to ask with (#313).
///
/// The bug this fixes: `index.html` used to be sent `public, max-age=3600` like everything else, so
/// after an update a browser that already held the shell could keep serving it for an hour — and the
/// shell is what names `assets/index-<hash>.js`, so the user saw the previous build, with no error
/// and nothing to click. Vite hashes the asset names precisely so those can be cached hard; the shell
/// is the exception, and it was being treated like the rule.
///
/// `no-cache` rather than `no-store`: it means "revalidate before reuse", which keeps the
/// back/forward cache and the shell's memory entry, and costs one conditional request per load that
/// the validator below answers with a bodyless 304. `no-store` would forbid reuse outright and make
/// every load re-download it.
///
/// The non-hashed leftovers (`favicon.svg`, `logo-mark.svg`, a `manifest.json`) keep the shorter
/// window: only the shell can pin a build, and giving them `immutable` would be a lie about names
/// that do not carry a content hash.
fn cache_policy(served: &str, data: &[u8]) -> (&'static str, Option<String>) {
    if served == SHELL {
        ("no-cache", Some(etag_for(data)))
    } else if served.starts_with(HASHED_ASSETS) {
        ("public, max-age=31536000, immutable", None)
    } else {
        ("public, max-age=3600", None)
    }
}

/// Serve one file out of the embedded `dist/`, with the caching policy its NAME earns.
///
/// `headers` is the request's, and it is needed for exactly one thing: the shell's validator. Every
/// other branch is answerable from the path alone.
fn serve_asset(path: &str, headers: &HeaderMap) -> Response<Body> {
    // Strip leading slashes; fall back to index.html for SPA routes.
    let trimmed = path.trim_start_matches('/');
    let requested = if trimmed.is_empty() { SHELL } else { trimmed };
    // Which asset ANSWERS, paired with its own name — because the content type has to describe the
    // bytes being served and not the path that was asked for. `/tools/3` is answered with
    // `index.html`, and guessing the type from the request labelled it `application/octet-stream`:
    // a browser downloads a file it was told is binary rather than running the app (#306's tests
    // caught this while proving the fallback cannot lie about `/api/…`). The same pairing now decides
    // the cache policy, so the deep link into the SPA is revalidated exactly as `/` is.
    let asset = Assets::get(requested)
        .map(|content| (requested, content))
        .or_else(|| Assets::get(SHELL).map(|content| (SHELL, content)));
    let Some((served, content)) = asset else {
        let mut resp = Response::new(Body::from("not found"));
        *resp.status_mut() = StatusCode::NOT_FOUND;
        return resp;
    };

    let body = content.data.into_owned();
    let (cache_control, validator) = cache_policy(served, &body);

    if let Some(etag) = validator.as_deref() {
        let fresh = headers
            .get(header::IF_NONE_MATCH)
            .is_some_and(|requested| if_none_match_covers(requested, etag));
        if fresh {
            // The 304 says "the shell you have is the shell I would send". The CSP rides along
            // because a 304 updates the stored response's headers with its own and leaves the rest
            // as they were: the validator is over the shell's BYTES, so a build that changed only the
            // policy would otherwise leave the old one governing the cached page.
            let mut resp = Response::new(Body::empty());
            *resp.status_mut() = StatusCode::NOT_MODIFIED;
            resp.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            if let Ok(value) = HeaderValue::from_str(etag) {
                resp.headers_mut().insert(header::ETAG, value);
            }
            resp.headers_mut().insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP_HEADER),
            );
            return resp;
        }
    }

    let mime = mime_guess::from_path(served).first_or_octet_stream();
    let header_val = HeaderValue::from_str(mime.as_ref())
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let mut resp = Response::new(Body::from(body));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, header_val);
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control));
    if let Some(etag) = validator.as_deref() {
        if let Ok(value) = HeaderValue::from_str(etag) {
            resp.headers_mut().insert(header::ETAG, value);
        }
    }
    resp.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP_HEADER),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tempfile::TempDir;
    use tower::ServiceExt;

    /// The REAL router — API merged, SPA wildcard registered after it — because the thing under test
    /// is precisely how those two interact.
    fn app() -> (TempDir, Router) {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(HouseStore::open(dir.path().to_path_buf()));
        let settings = dir.path().join("config.json");
        (dir, router(store, 5173, settings))
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    fn get_with(uri: &str, name: header::HeaderName, value: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header(name, value)
            .body(Body::empty())
            .unwrap()
    }

    fn header_of(res: &Response<Body>, name: header::HeaderName) -> String {
        res.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    }

    fn cache_control(res: &Response<Body>) -> String {
        header_of(res, header::CACHE_CONTROL)
    }

    async fn body_json(res: Response<Body>) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        serde_json::from_slice(&bytes).expect("a JSON body")
    }

    fn content_type(res: &Response<Body>) -> String {
        res.headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    }

    #[tokio::test]
    async fn the_spa_fallback_cannot_answer_for_the_api() {
        // The trap this test exists for: without the API merged in ahead of it, `/*path` answers
        // `/api/v1/health` with index.html and status 200, and a probe reads that as "present".
        let (_dir, app) = app();
        let res = app.clone().oneshot(get("/api/v1/health")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            content_type(&res).starts_with("application/json"),
            "/api/v1/health was answered with {:?}",
            content_type(&res)
        );
        assert_eq!(body_json(res).await["ok"], serde_json::json!(true));

        // And a path the API does NOT own is a JSON 404, not a 200 carrying index.html.
        let res = app.clone().oneshot(get("/api/v1/nope")).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert!(content_type(&res).starts_with("application/json"));
        assert!(body_json(res).await["error"].is_string());
    }

    #[tokio::test]
    async fn the_settings_route_is_the_apis_and_not_the_spa_catch_all() {
        // #372, the ordering half. `house_api` ends in `/api/v1/*rest` → a JSON 404, and the SPA
        // wildcard behind it answers everything with `index.html` and status 200. A route merged in
        // the wrong place would be answered by one of those two and look fine at a glance: a 404 is
        // a plausible "not here" and an HTML 200 is exactly the trap #306's tests exist for. The
        // static path has to win over the catch-all, and this reads the answer rather than the code.
        let (_dir, app) = app();
        let res = app.clone().oneshot(get("/api/v1/config")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            content_type(&res).starts_with("application/json"),
            "/api/v1/config was answered with {:?}",
            content_type(&res)
        );
        let body = body_json(res).await;
        assert!(body["port"].is_number(), "{body}");
        assert!(
            body["servingPort"].is_number(),
            "the port it is actually served on is half the answer: {body}"
        );
    }

    #[tokio::test]
    async fn the_api_reads_the_store_and_the_spa_still_serves_pages() {
        let (_dir, app) = app();
        // An empty house is an empty list, not an error and not index.html.
        let res = app.clone().oneshot(get("/api/v1/tools")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await, serde_json::json!([]));

        // The fallback is untouched: a deep link into the SPA still gets the page.
        for uri in ["/", "/tools/anything"] {
            let res = app.clone().oneshot(get(uri)).await.unwrap();
            assert_eq!(res.status(), StatusCode::OK, "{uri}");
            assert!(
                content_type(&res).starts_with("text/html"),
                "{uri} was answered with {:?}",
                content_type(&res)
            );
        }
    }

    #[tokio::test]
    async fn the_shell_is_revalidated_rather_than_cached_for_an_hour() {
        // (#313) What was wrong: every file was `public, max-age=3600`, so after an update a browser
        // could keep the previous shell — the file that names `assets/index-<hash>.js` — for an hour.
        // A DEEP LINK is in this loop on purpose: the SPA fallback serves the same shell, so it earns
        // the same policy, and a fix that only covered `/` would leave `/tools/3` pinning the build.
        let (_dir, app) = app();
        let mut etags = Vec::new();
        for uri in ["/", "/tools/3"] {
            let res = app.clone().oneshot(get(uri)).await.unwrap();
            assert_eq!(res.status(), StatusCode::OK, "{uri}");
            assert_eq!(cache_control(&res), "no-cache", "{uri}");
            let etag = header_of(&res, header::ETAG);
            assert!(
                etag.starts_with('"') && etag.ends_with('"') && etag.contains("fnv1a-"),
                "{uri} was answered with the validator {etag:?}"
            );
            // The hash is over the bytes, so both routes serving one shell must agree on it.
            etags.push(etag);
        }
        assert_eq!(etags[0], etags[1], "one shell, two validators");

        // And the shell still carries the CSP on the ordinary branch (#313: do not change it).
        let res = app.clone().oneshot(get("/")).await.unwrap();
        assert!(!header_of(&res, header::CONTENT_SECURITY_POLICY).is_empty());
    }

    #[tokio::test]
    async fn a_matching_validator_answers_the_shell_with_a_bodyless_304() {
        let (_dir, app) = app();
        let etag = header_of(&app.clone().oneshot(get("/")).await.unwrap(), header::ETAG);

        let res = app
            .clone()
            .oneshot(get_with("/", header::IF_NONE_MATCH, &etag))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(header_of(&res, header::ETAG), etag);
        assert_eq!(cache_control(&res), "no-cache");
        assert!(
            !header_of(&res, header::CONTENT_SECURITY_POLICY).is_empty(),
            "a 304 updates the stored headers, so the policy has to be restated"
        );
        // And a 304 carries no body at all, which is the point of the exercise: `no-cache` costs one
        // conditional request per load, not a re-download of the shell.
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        assert!(bytes.is_empty(), "a 304 answered with {} bytes", bytes.len());

        // The list form a browser actually sends while revalidating several things.
        let list = format!("\"stale\", {etag}");
        let res = app
            .clone()
            .oneshot(get_with("/", header::IF_NONE_MATCH, &list))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);

        // A validator that is not this shell's is a 200 with the body: the client asked for the page
        // and its copy is old, so the answer is the page.
        let res = app
            .clone()
            .oneshot(get_with("/", header::IF_NONE_MATCH, "\"fnv1a-0000000000000000\""))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(header_of(&res, header::ETAG), etag);
    }

    /// The branches the embedded bundle cannot be asked about directly: no test build contains a
    /// `favicon.json`, and hashed asset names change on every build. The policy is a function of the
    /// name that answers, so it is tested as one.
    #[test]
    fn a_hashed_asset_is_cached_for_ever_and_the_rest_for_an_hour() {
        let (cache, validator) = cache_policy("assets/index-CqhdknQi.js", b"console.log(1)");
        assert_eq!(cache, "public, max-age=31536000, immutable");
        assert!(validator.is_none(), "a hashed name needs no revalidation");

        for name in ["favicon.svg", "logo-mark.svg", "apple-touch-icon-180.png"] {
            let (cache, validator) = cache_policy(name, b"x");
            assert_eq!(cache, "public, max-age=3600", "{name}");
            assert!(validator.is_none(), "{name}");
        }

        // The shell, and `assets/` without a slash so the prefix test is not a `contains`.
        let (cache, validator) = cache_policy("index.html", b"<html>");
        assert_eq!(cache, "no-cache");
        assert_eq!(validator.as_deref(), Some(etag_for(b"<html>").as_str()));
        assert_eq!(cache_policy("assetsx/thing.js", b"x").0, "public, max-age=3600");
    }

    #[tokio::test]
    async fn an_api_route_is_never_answered_as_the_shell() {
        // The shell's validator now decides a 304, and it is computed over `index.html`. The API
        // routes are merged in AHEAD of the wildcard (#306), and this pins that the guard did not
        // reach them: a request for a list carrying the SHELL's validator must still get the list,
        // not a bodyless 304 saying "your copy is current" about a document it never held.
        let (_dir, app) = app();
        let shell_etag = header_of(&app.clone().oneshot(get("/")).await.unwrap(), header::ETAG);

        let res = app
            .clone()
            .oneshot(get_with("/api/v1/tools", header::IF_NONE_MATCH, &shell_etag))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(content_type(&res).starts_with("application/json"));
        assert_eq!(body_json(res).await, serde_json::json!([]));
    }

    /// #401 — the address is refused in this function, not only where `--host` is read, because the
    /// same value can arrive from a `config.json` written before the refusal existed, and a saved
    /// one must not survive into a bind either.
    ///
    /// The two addresses as given are here on purpose: refusing an unusable host must not become a
    /// reason to stop using a usable one — `127.0.0.2` is the sibling loopback a second instance
    /// runs on (#402) and `192.168.10.16` is the LAN case the window's grant is built for (#389).
    #[test]
    fn bind_addr_refuses_ipv6_and_uses_every_other_address_as_given() {
        let loopback = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let every_interface = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

        assert_eq!(bind_addr_for(Some("::1"), false), loopback);
        assert_eq!(bind_addr_for(Some("fe80::1"), true), every_interface);
        assert_eq!(bind_addr_for(Some("2001:db8::5"), false), loopback);

        assert_eq!(
            bind_addr_for(Some("127.0.0.2"), false),
            "127.0.0.2".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            bind_addr_for(Some("192.168.10.16"), false),
            "192.168.10.16".parse::<IpAddr>().unwrap()
        );

        // The older route, unchanged: not an address, empty, or absent.
        assert_eq!(bind_addr_for(Some("bogus"), false), loopback);
        assert_eq!(bind_addr_for(Some(""), true), every_interface);
        assert_eq!(bind_addr_for(None, true), every_interface);
        assert_eq!(bind_addr_for(None, false), loopback);
    }

    /// The predicate `lib.rs` asks before it SAVES a `--host` (#399): it refuses the address the
    /// shell cannot serve and nothing else. A value that is not an address is still saved — that is
    /// the older behaviour, and moving it is not this change.
    #[test]
    fn host_refusal_names_only_the_address_the_shell_cannot_serve() {
        for refused in ["::1", "::", "fe80::1", "2001:db8::5"] {
            assert!(host_refusal(refused).is_some(), "{refused} must be refused");
        }
        for kept in [
            "127.0.0.1",
            "0.0.0.0",
            "127.0.0.2",
            "192.168.10.16",
            "bogus",
            "",
        ] {
            assert!(host_refusal(kept).is_none(), "{kept} must not be refused");
        }
    }

    #[test]
    fn a_taken_port_is_a_refusal_and_not_a_different_origin() {
        // (#312) The defect this pins: `start` used to fall back to an ephemeral port when the
        // requested one was taken, and `lib.rs` loaded the webview from whatever it got — so a
        // foreign process on the port turned a working app into one that had forgotten everything,
        // silently, with the old data stranded under the port that could not be had. Holding a real
        // listener on a free port and asking `start` for that port IS the reproduction; the
        // assertion is that it refuses and returns no handle, so there is no second origin for a
        // window to be built from.
        let dir = TempDir::new().unwrap();
        let lock = HouseLock::acquire(dir.path()).unwrap();

        let held = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
        let taken = held.local_addr().unwrap().port();

        let err = start(
            ServerConfig {
                requested_port: taken,
                bind_to_all: false,
                host: None,
            },
            &lock,
            dir.path().join("config.json"),
        )
        .expect_err("a taken port must refuse, never move to another one");
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
        assert!(
            err.to_string().contains(&taken.to_string()),
            "the message has to name the port the user must free: {err}"
        );
    }

    /// One request over a real socket, answered by a real hyper, returned as bytes.
    fn over_the_wire(port: u16, request: &str) -> String {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[test]
    fn the_headers_a_browser_decides_on_are_written_by_the_real_server() {
        // The tests above run the router in-process, which is the right level for "what does this
        // handler decide". This one is the level #313's claim lives at: `cache-control` and `etag`
        // are things a browser reads off the WIRE, so they are checked as bytes that came back from a
        // bound port through hyper. It is also the only test that exercises `start`'s listener.
        let dir = TempDir::new().unwrap();
        let lock = HouseLock::acquire(dir.path()).unwrap();
        let (handle, _rx) = start(
            ServerConfig {
                requested_port: 0,
                bind_to_all: false,
                host: None,
            },
            &lock,
            dir.path().join("config.json"),
        )
        .unwrap();
        let port = handle.bound_port;

        let response = over_the_wire(
            port,
            "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(
            response.to_ascii_lowercase().contains("cache-control: no-cache\r\n"),
            "{response}"
        );
        let etag = response
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("etag:"))
            .map(|line| line["etag:".len()..].trim().to_string())
            .unwrap_or_else(|| panic!("no validator on the shell: {response}"));
        assert!(etag.starts_with('"') && etag.ends_with('"'), "{etag}");

        // The conditional request a revalidating browser sends, and the bodyless answer it must get.
        let again = over_the_wire(
            port,
            &format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nIf-None-Match: {etag}\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(again.starts_with("HTTP/1.1 304 Not Modified"), "{again}");
        let (head, body) = again.split_once("\r\n\r\n").expect("a header terminator");
        assert!(body.is_empty(), "a 304 carried a body: {body:?}");
        assert!(head.to_ascii_lowercase().contains(&format!("etag: {etag}")), "{head}");
        // And it is still the SPA answering: a deep link with the same validator is the same answer,
        // because it is the same shell.
        let deep = over_the_wire(
            port,
            &format!(
                "GET /tools/3 HTTP/1.1\r\nHost: 127.0.0.1\r\nIf-None-Match: {etag}\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(deep.starts_with("HTTP/1.1 304 Not Modified"), "{deep}");
    }

    #[test]
    fn the_type_stack_comes_from_this_origin_with_the_headers_the_shell_enforces() {
        // (#330) The desktop shell renders this origin under a policy with no `font-src` and no remote
        // style origin, which is exactly why the three families had to be self-hosted: a font CDN is
        // refused there, and the app then falls back to the system stack without saying so. This is
        // the shell's own serving path, over a real socket, because the policy is enforced on the
        // bytes a browser receives — not on the router's intent.
        //
        // A MISSING ASSET IS NOT A 404 HERE. `serve_asset` answers an unknown path with index.html
        // and status 200, so a 200 proves nothing by itself: the CONTENT TYPE is the discriminator,
        // because `text/css` and `font/woff2` are what nothing else in `dist/` is. (That fallback is
        // also why a font file deleted from `public/fonts/` would look like a working page.)
        let dir = TempDir::new().unwrap();
        let lock = HouseLock::acquire(dir.path()).unwrap();
        let (handle, _rx) = start(
            ServerConfig {
                requested_port: 0,
                bind_to_all: false,
                host: None,
            },
            &lock,
            dir.path().join("config.json"),
        )
        .unwrap();
        let port = handle.bound_port;

        for (path, kind) in [
            ("/fonts/fonts.css", "content-type: text/css"),
            ("/fonts/SpaceGrotesk-Variable.woff2", "content-type: font/woff2"),
            ("/fonts/Inter-Variable.woff2", "content-type: font/woff2"),
            ("/fonts/JetBrainsMono-Variable.woff2", "content-type: font/woff2"),
        ] {
            let res = over_the_wire(
                port,
                &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
            );
            let head = res.to_ascii_lowercase();
            assert!(res.starts_with("HTTP/1.1 200 OK"), "{path} was answered: {res}");
            assert!(head.contains(kind), "{path} came back as: {res}");
            assert!(
                head.contains("content-security-policy: default-src 'self'"),
                "{path} carried no policy the shell would enforce: {res}"
            );
        }

        // And the stylesheet declares the three families, pointing at the files this origin just
        // served — a link to a CDN would leave the families declared and the fetches refused.
        let css = over_the_wire(
            port,
            "GET /fonts/fonts.css HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        for family in ["Space Grotesk", "Inter", "JetBrains Mono"] {
            assert!(
                css.contains(&format!("font-family: '{family}'")),
                "{family} is not declared in the served stylesheet: {css}"
            );
        }
        // And every `url()` in the served stylesheet is one of the three files beside it — no host is
        // named to fetch from, which is the actual defect. The check is over the `url()` values and
        // not the whole text because the comment above the rules does name the CDN: it explains why
        // the fonts were taken off it.
        let mut targets: Vec<&str> = css
            .split("url(")
            .skip(1)
            .filter_map(|rest| rest.split(')').next())
            // The comment above the rules writes `url()` as prose, which yields an empty target.
            .filter(|t| !t.is_empty())
            .collect();
        targets.sort_unstable();
        let mut expected = [
            "'Inter-Variable.woff2'",
            "'JetBrainsMono-Variable.woff2'",
            "'SpaceGrotesk-Variable.woff2'",
        ];
        expected.sort_unstable();
        assert_eq!(
            targets, expected.to_vec(),
            "the stylesheet should fetch its three families from beside itself: {css}"
        );
    }

    /// #372 — the settings write, over a real socket, through the real `start`.
    ///
    /// The claim that needs a socket is NOT the guard's decision: `config_api.rs` tests that with a
    /// mocked peer address, which is the only way to be a LAN client from a test host. What cannot
    /// be tested there is that the address EXISTS — `ConnectInfo` is populated only by
    /// `axum::serve(… into_make_service_with_connect_info …)`, and a handler that asks for it without
    /// that answers 500 to everything. Injecting the extension by hand is exactly what the server is
    /// being asked to do, so a mock would go on passing while the app refused every write. Hence a
    /// real request to a bound port, and an assertion on the file it was supposed to change.
    #[test]
    fn a_settings_write_over_the_wire_knows_which_machine_asked() {
        let dir = TempDir::new().unwrap();
        let lock = HouseLock::acquire(dir.path()).unwrap();
        let settings = dir.path().join("config.json");
        let (handle, _rx) = start(
            ServerConfig {
                requested_port: 0,
                bind_to_all: false,
                host: None,
            },
            &lock,
            settings.clone(),
        )
        .unwrap();
        let port = handle.bound_port;

        let body = r#"{"port":8123,"bindToAll":true}"#;
        // The request carries the provenance headers a browser sends to the app's own page: the name
        // and port it is loaded from, and no `Origin` rewriting of the address. `config_api.rs` owns
        // what the guard does with them; what this test adds is that a real socket populates the peer
        // at all, and that the app's own page still writes through it.
        let response = over_the_wire(
            port,
            &format!(
                "POST /api/v1/config HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
                 Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        // The answer is about the NEXT launch, and says which port this one is on — which is the
        // port the OS chose for `requested_port: 0`, and therefore a number only the listener knows.
        assert!(
            response.contains(&format!("{{\"port\":8123,\"bindToAll\":true,\"servingPort\":{port}}}")),
            "{response}"
        );

        // And the file `lib.rs` reads was actually written, which is the whole point of the endpoint.
        let written = crate::config::load_from(&settings).expect("the settings file");
        assert_eq!(written.port, 8123);
        assert!(written.bind_to_all);

        // The READ takes no peer, so it is answered for anyone: the LAN browser that sees the dialog.
        let read = over_the_wire(
            port,
            &format!(
                "GET /api/v1/config HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(read.starts_with("HTTP/1.1 200 OK"), "{read}");
        assert!(read.contains("\"port\":8123"), "{read}");
    }

    /// The name and port a request from the app's own window arrives under: `routes` serves 5173 in
    /// these tests, and the webview is loaded from exactly this URL (`lib.rs`), which is the app's
    /// origin and the reason the guard's Origin rule can be exact.
    const APP_HOST: &str = "127.0.0.1:5173";
    const APP_ORIGIN: &str = "http://127.0.0.1:5173";

    /// The two statuses the guard refuses with, and nothing else is a guard refusal.
    fn refused_by_the_guard(status: StatusCode) -> bool {
        status == StatusCode::FORBIDDEN || status == StatusCode::UNSUPPORTED_MEDIA_TYPE
    }

    /// A write with the provenance headers a test wants to vary and `None` for the ones it wants
    /// ABSENT — a different case from empty, for all three.
    ///
    /// `Content-Length` is written out because the framing is what the guard judges a body by, and an
    /// in-process `Request` has no wire to have it added by (`guard.rs`'s tests carry the same note).
    fn write(
        method: &str,
        uri: &str,
        host: Option<&str>,
        origin: Option<&str>,
        content_type: Option<&str>,
        body: &[u8],
    ) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
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
        builder.body(Body::from(body.to_vec())).unwrap()
    }

    /// Every write the service has, as `(method, uri, body)`, in one table so a route added later is
    /// one line rather than a new test that forgets an attack. `/api/v1/import` is here because it is
    /// the one that takes raw bytes — the handler parses them itself, so no extractor stood in front
    /// of it — and `/api/v1/catalogue/sync` because it is the one a bodyless request reaches.
    const WRITES: &[(&str, &str, &str)] = &[
        ("POST", "/api/v1/config", r#"{"port":8123,"bindToAll":true}"#),
        ("POST", "/api/v1/tools", r#"{"key":"user:abc"}"#),
        ("PATCH", "/api/v1/tools/user:abc", r#"{"key":"user:abc"}"#),
        ("DELETE", "/api/v1/tools/user:abc", "{}"),
        ("POST", "/api/v1/inventory", r#"{"id":"inv-1"}"#),
        ("PATCH", "/api/v1/inventory/inv-1", r#"{"id":"inv-1"}"#),
        ("DELETE", "/api/v1/inventory/inv-1", "{}"),
        ("POST", "/api/v1/import", r#"{"kind":"casemaker-house"}"#),
        ("PUT", "/api/v1/location/machines/m-1", r#"{"id":"m-1"}"#),
        ("POST", "/api/v1/location/house-warning/dismiss", "{}"),
        ("POST", "/api/v1/catalogue/sync", "{}"),
    ];

    /// #375 — the guard's PLACEMENT, over the real router.
    ///
    /// `config_api` and `house_api`'s own tests call their `routes()` directly and therefore see none
    /// of this: they are tests of handlers. What can only be tested here is that every write under
    /// `/api/v1` is inside the layer — and that the SPA's routes are not, which the last case checks
    /// by asserting the page still answers a path that is not the API's.
    #[tokio::test]
    async fn every_write_under_the_api_is_guarded() {
        let (_dir, app) = app();

        for (method, uri, body) in WRITES {
            for (label, req) in [
                (
                    "a cross-site page, typed text/plain — the simple request, no preflight",
                    write(method, uri, Some(APP_HOST), Some("https://evil.example"), Some("text/plain"), body.as_bytes()),
                ),
                (
                    "the same page as JSON, which a cross-origin request cannot send without a preflight this server does not answer",
                    write(method, uri, Some(APP_HOST), Some("https://evil.example"), Some("application/json"), body.as_bytes()),
                ),
                (
                    "a rebound hostname: same-origin to the browser, so the name is the only tell",
                    write(method, uri, Some("evil.example:5173"), None, Some("application/json"), body.as_bytes()),
                ),
                (
                    "a byte-array body, which a browser sends with no Content-Type at all",
                    write(method, uri, Some(APP_HOST), None, None, body.as_bytes()),
                ),
                (
                    "a form post, whose encoding is another simple type",
                    write(method, uri, Some(APP_HOST), None, Some("application/x-www-form-urlencoded"), body.as_bytes()),
                ),
                (
                    "another port on this machine, which is a different origin",
                    write(method, uri, Some("127.0.0.1:9999"), Some("http://127.0.0.1:9999"), Some("application/json"), body.as_bytes()),
                ),
            ] {
                let res = app.clone().oneshot(req).await.unwrap();
                let status = res.status();
                assert!(
                    refused_by_the_guard(status),
                    "{method} {uri} — {label} answered {status}"
                );
                // The refusal has to be the service's own shape: `houseClient.ts` reads anything else
                // as "somebody other than the service answered", which is a transport failure to the
                // user instead of a reason — and axum's own 415 for two of these endpoints used to be
                // exactly that.
                assert!(
                    content_type(&res).starts_with("application/json"),
                    "{method} {uri} — {label} refused with {:?}",
                    content_type(&res)
                );
                let json = body_json(res).await;
                assert!(
                    json["error"].is_string(),
                    "{method} {uri} — {label} has to carry a reason: {json}"
                );
            }

            // And the client that must keep working: the app's own page, under the name and origin it
            // is actually served from. Asserted as "not a guard refusal" and not as a status, because
            // what each handler then says about the body is that handler's business — a 428 from an
            // unguarded PATCH and a 422 from a body that is not an entry are both correct here.
            let res = app
                .clone()
                .oneshot(write(
                    method,
                    uri,
                    Some(APP_HOST),
                    Some(APP_ORIGIN),
                    Some("application/json"),
                    body.as_bytes(),
                ))
                .await
                .unwrap();
            assert!(
                !refused_by_the_guard(res.status()),
                "{method} {uri} refused the app's own page: {}",
                res.status()
            );
        }

        // The SPA is outside the layer. A write method to a page path is not the API's to judge, and
        // the fallback still answers it with the shell — which is the case that would break if the
        // guard were applied over the finished router instead of over the API half of it.
        let res = app
            .clone()
            .oneshot(write("POST", "/tools/3", Some(APP_HOST), None, None, &[]))
            .await
            .unwrap();
        assert!(!refused_by_the_guard(res.status()), "{}", res.status());
    }

    /// The other half of the same rule: a write that declares NO body is judged on its origin alone
    /// (#375), because demanding a type would refuse the app's own client — `houseClient.send` leaves
    /// the `Content-Type` off when there is nothing to send (`POST /api/v1/catalogue/sync`, both
    /// DELETEs). So a bodyless cross-site write still has to be refused, by its origin, and a bodyless
    /// write from the app's own page still has to be let through.
    #[tokio::test]
    async fn a_write_with_no_body_is_judged_on_its_origin_alone() {
        let (_dir, app) = app();

        for (method, uri) in [
            ("POST", "/api/v1/catalogue/sync"),
            ("DELETE", "/api/v1/tools/user:abc"),
            ("DELETE", "/api/v1/inventory/inv-1"),
        ] {
            let res = app
                .clone()
                .oneshot(write(method, uri, Some(APP_HOST), Some("https://evil.example"), None, &[]))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method} {uri}");
            assert!(body_json(res).await["error"].is_string(), "{method} {uri}");

            // A rebound name is refused too, and this is the shape with no origin to disagree with.
            let res = app
                .clone()
                .oneshot(write(method, uri, Some("evil.example:5173"), None, None, &[]))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method} {uri}");

            // And the app's own client — no body to type, and no type on it.
            let res = app
                .clone()
                .oneshot(write(method, uri, Some(APP_HOST), Some(APP_ORIGIN), None, &[]))
                .await
                .unwrap();
            assert!(
                !refused_by_the_guard(res.status()),
                "{method} {uri} refused the app's own bodyless write: {}",
                res.status()
            );
        }
    }

    /// A tool as `house_api`'s own tests build one: a body the handler will actually accept, so that
    /// "the app's own page is not refused" is a write that LANDED rather than a 422 that was not a
    /// guard refusal.
    fn a_tool_entry() -> Vec<u8> {
        use crate::house::{Tool, ToolLibraryEntry, ToolShape};
        serde_json::to_vec(&ToolLibraryEntry {
            key: "user:guarded".to_string(),
            tool: Tool {
                name: "2 mm flat end".to_string(),
                type_text: "Flat End".to_string(),
                shape: ToolShape::Flat,
                diameter: Some(2.0),
                ..Tool::default()
            },
            provenance: "typed in by hand".to_string(),
        })
        .unwrap()
    }

    /// #375's acceptance, through the guarded router: a cross-site write is refused AND the house is
    /// exactly as it was, while the same write from the app's own page lands. `a_refused_write_changes
    /// _nothing` is the half worth having a test for — a refusal that has already done the damage is
    /// not a refusal, and `/api/v1/import` replaces the whole document.
    #[tokio::test]
    async fn a_refused_house_write_leaves_the_house_alone() {
        let (_dir, app) = app();
        let entry = a_tool_entry();

        let res = app
            .clone()
            .oneshot(write("POST", "/api/v1/tools", Some(APP_HOST), Some(APP_ORIGIN), Some("application/json"), &entry))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED, "the app's own page could not write its house");

        // The page on another site, in all three shapes it can send to THIS endpoint without a
        // preflight: the simple `text/plain`, the byte-array body with no type, and — because
        // `import_house` takes raw bytes rather than an `axum::Json` — a body the handler itself would
        // have parsed.
        for (label, content_type, body) in [
            ("the simple request", Some("text/plain"), entry.as_slice()),
            ("a byte-array body with no type", None, entry.as_slice()),
            ("a form post", Some("application/x-www-form-urlencoded"), entry.as_slice()),
        ] {
            let res = app
                .clone()
                .oneshot(write("POST", "/api/v1/tools", Some(APP_HOST), Some("https://evil.example"), content_type, body))
                .await
                .unwrap();
            assert!(refused_by_the_guard(res.status()), "{label} answered {}", res.status());
        }

        // And nothing moved: one tool, the one the app's own page created.
        let body = body_json(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body.as_array().unwrap().len(), 1, "a refused write changed the house: {body}");
        assert_eq!(body[0]["key"], serde_json::json!("user:guarded"));
    }

    /// (#375) The case decision 33 exists for, through the REAL router: the app served on the LAN,
    /// opened at its own address by a browser on another machine, writing the house. `guard.rs` tests
    /// the rule; what has to be pinned HERE is that the guard the router applies is that same rule and
    /// is not quietly loopback-only — a guard that refused this would break the thing decision 33
    /// exists to protect, and the refusal-compiles-a-list tests would never say so.
    #[tokio::test]
    async fn a_browser_on_the_lan_writes_the_house_at_its_own_address() {
        let (_dir, app) = app();
        let res = app
            .clone()
            .oneshot(write(
                "POST",
                "/api/v1/tools",
                Some("192.168.10.43:5173"),
                Some("http://192.168.10.43:5173"),
                Some("application/json"),
                &a_tool_entry(),
            ))
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::CREATED,
            "a LAN browser, which decision 33 is about, could not write its house"
        );

        // And the house it wrote is the house that is there: not a 201 from some other path.
        let body = body_json(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body.as_array().unwrap().len(), 1, "{body}");
        assert_eq!(body[0]["key"], serde_json::json!("user:guarded"));
    }
}
