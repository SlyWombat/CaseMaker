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
use tokio::sync::oneshot;

#[derive(RustEmbed)]
#[folder = "../dist/"]
#[exclude = "*.map"]
struct Assets;

#[derive(Debug, Clone, Copy)]
pub struct ServerConfig {
    pub requested_port: u16,
    pub bind_to_all: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ServerHandle {
    pub bound_port: u16,
    pub bind_addr: IpAddr,
}

/// Start the static-asset HTTP server on a background tokio task.
///
/// Returns the actually-bound port (which may differ from `requested_port`
/// if it was taken). The returned receiver fires when the server stops.
pub fn start(
    cfg: ServerConfig,
) -> Result<(ServerHandle, oneshot::Receiver<()>), std::io::Error> {
    let bind_addr = if cfg.bind_to_all {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
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
    let app = router();

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

fn router() -> Router {
    Router::new()
        .route("/", get(serve_root))
        .route("/*path", get(serve_path))
}

async fn serve_root(_req: Request<Body>) -> impl IntoResponse {
    serve_asset("index.html")
}

async fn serve_path(AxumPath(path): AxumPath<String>) -> impl IntoResponse {
    serve_asset(&path)
}

fn serve_asset(path: &str) -> Response<Body> {
    // Strip leading slashes; fall back to index.html for SPA routes.
    let trimmed = path.trim_start_matches('/');
    let primary = if trimmed.is_empty() { "index.html" } else { trimmed };
    let asset = Assets::get(primary).or_else(|| Assets::get("index.html"));
    match asset {
        Some(content) => {
            let mime = mime_guess::from_path(primary).first_or_octet_stream();
            let header_val = HeaderValue::from_str(mime.as_ref())
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
            let mut resp = Response::new(Body::from(content.data.into_owned()));
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, header_val);
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=3600"),
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
