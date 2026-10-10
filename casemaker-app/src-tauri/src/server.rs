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
    /// parses as a valid IP. Empty string / invalid IP → fall back to the
    /// bind_to_all / 127.0.0.1 behaviour.
    pub host: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct ServerHandle {
    pub bound_port: u16,
    pub bind_addr: IpAddr,
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
/// Returns the actually-bound port (which may differ from `requested_port`
/// if it was taken). The returned receiver fires when the server stops.
pub fn start(
    cfg: ServerConfig,
    house: &HouseLock,
) -> Result<(ServerHandle, oneshot::Receiver<()>), std::io::Error> {
    let bind_addr = match cfg.host.as_deref() {
        Some(h) if !h.is_empty() => match h.parse::<IpAddr>() {
            Ok(ip) => ip,
            Err(_) => {
                log::warn!("invalid host '{h}'; falling back to {}",
                    if cfg.bind_to_all { "0.0.0.0" } else { "127.0.0.1" });
                if cfg.bind_to_all {
                    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
                } else {
                    IpAddr::V4(Ipv4Addr::LOCALHOST)
                }
            }
        },
        _ => {
            if cfg.bind_to_all {
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            } else {
                IpAddr::V4(Ipv4Addr::LOCALHOST)
            }
        }
    };

    // Try the requested port first; if taken, let the OS pick.
    let listener = match TcpListener::bind(SocketAddr::new(bind_addr, cfg.requested_port)) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            log::warn!(
                "port {} in use; falling back to ephemeral port",
                cfg.requested_port
            );
            TcpListener::bind(SocketAddr::new(bind_addr, 0))?
        }
        Err(e) => return Err(e),
    };
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
    let app = router(store);

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
                if let Err(e) = axum::serve(listener, app).await {
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
fn router(store: Arc<HouseStore>) -> Router {
    Router::new()
        .merge(crate::house_api::routes(store))
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
/// IPC origins and `wasm-unsafe-eval` for the manifold-3d worker.
const CSP_HEADER: &str = "default-src 'self' tauri: ipc: http://ipc.localhost; \
img-src 'self' data: blob: tauri: ipc: http://ipc.localhost; \
style-src 'self' 'unsafe-inline'; \
script-src 'self' 'wasm-unsafe-eval' tauri: ipc: http://ipc.localhost; \
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
        (dir, router(store))
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
}
