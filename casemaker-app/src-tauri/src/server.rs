use crate::house::{house_dir, HouseStore};
use axum::{
    body::Body,
    extract::Path as AxumPath,
    http::{header, HeaderValue, Request, Response, StatusCode},
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
/// Returns the actually-bound port (which may differ from `requested_port`
/// if it was taken). The returned receiver fires when the server stops.
pub fn start(
    cfg: ServerConfig,
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
    let store = Arc::new(HouseStore::open(house_dir()));
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

async fn serve_root(_req: Request<Body>) -> impl IntoResponse {
    serve_asset("index.html")
}

async fn serve_path(AxumPath(path): AxumPath<String>) -> impl IntoResponse {
    serve_asset(&path)
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

fn serve_asset(path: &str) -> Response<Body> {
    // Strip leading slashes; fall back to index.html for SPA routes.
    let trimmed = path.trim_start_matches('/');
    let requested = if trimmed.is_empty() { "index.html" } else { trimmed };
    // Which asset ANSWERS, paired with its own name — because the content type has to describe the
    // bytes being served and not the path that was asked for. `/tools/3` is answered with
    // `index.html`, and guessing the type from the request labelled it `application/octet-stream`:
    // a browser downloads a file it was told is binary rather than running the app (#306's tests
    // caught this while proving the fallback cannot lie about `/api/…`).
    let asset = Assets::get(requested)
        .map(|content| (requested, content))
        .or_else(|| Assets::get("index.html").map(|content| ("index.html", content)));
    match asset {
        Some((served, content)) => {
            let mime = mime_guess::from_path(served).first_or_octet_stream();
            let header_val = HeaderValue::from_str(mime.as_ref())
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
            let mut resp = Response::new(Body::from(content.data.into_owned()));
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, header_val);
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=3600"),
            );
            resp.headers_mut().insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP_HEADER),
            );
            resp
        }
        None => {
            let mut resp = Response::new(Body::from("not found"));
            *resp.status_mut() = StatusCode::NOT_FOUND;
            resp
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
