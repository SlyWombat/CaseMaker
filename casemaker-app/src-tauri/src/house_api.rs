// The house service's HTTP surface (#306, tracking #212): `/api/v1/*`, served by the app's own
// embedded axum server. The data and the file live in `house.rs`; this module is the routing, the
// status codes and the `ETag` handling.
//
// MOUNTED BEFORE THE SPA. `server.rs` answers every path it does not recognise with `index.html`
// and status 200 (`serve_asset`, so a deep link into the SPA works). That is the right behaviour for
// a page and a trap for an API: a client probing `/api/v1/health` would get an HTML 200 and read it
// as "the house service is here". So the API router is merged into the top-level router BEFORE the
// `/*path` fallback, every `/api/v1/…` route is registered here, and anything else under `/api/v1/`
// is answered by `api_not_found` with a JSON 404. `server.rs`'s tests assert all three of those
// against the real router.
//
// WRITES ARE HERE, THE CLIENT'S WRITE PATH IS NOT. Every endpoint #212 describes exists and is
// tested, but the TypeScript client (#306's `platform/houseClient.ts`) implements the READ path
// only: registering, cloning and importing are #309/#311's, and they need the tray/settings UI
// #308/#310 carry. A service with an unused write path is honest; a client guessing at one is not.
//
// THE KEY IS A WILDCARD PATH SEGMENT (`/tools/*key`), NOT A SINGLE SEGMENT, so a key containing `/`
// routes without any escaping — and the client must therefore NOT `encodeURIComponent` a whole key,
// because `%2F` is decoded or rejected at the discretion of every proxy in between. Mint keys
// without slashes anyway; the wildcard exists so that a bad one cannot silently 404.
//
// NO CACHE HEADERS BEYOND `ETag`. `no-cache` and an `ETag` are enough for a same-origin fetch from
// the app's own window: a 304 saves the body and nothing else is gained by `max-age` on a list the
// user is editing.

use crate::house::{HouseError, HouseStore, InventoryItem, ToolLibraryEntry};
use axum::body::Body;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{any, get, patch, post};
use axum::Router;
use std::sync::Arc;

/// The house service's routes. `server.rs` merges this into the top-level router before the SPA
/// wildcard; see the module doc for why that order matters.
pub fn routes(store: Arc<HouseStore>) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/tools", get(list_tools).post(create_tool))
        .route("/api/v1/tools/*key", patch(update_tool).delete(delete_tool))
        .route("/api/v1/inventory", get(list_inventory).post(create_inventory))
        .route(
            "/api/v1/inventory/*id",
            patch(update_inventory).delete(delete_inventory),
        )
        .route("/api/v1/export", get(export_house))
        .route("/api/v1/import", post(import_house))
        .route("/api/v1/*rest", any(api_not_found))
        .with_state(store)
}

fn status_for(e: &HouseError) -> StatusCode {
    match e {
        HouseError::BadKey(_) | HouseError::BadEntry(_) => StatusCode::BAD_REQUEST,
        HouseError::NotFound(_) => StatusCode::NOT_FOUND,
        // A key that already exists, and a write refused because the file on disk is unreadable.
        // Both are "the request was fine, the house's state says no" — 409, not 400.
        HouseError::Conflict(_) | HouseError::Refused(_) => StatusCode::CONFLICT,
        HouseError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn json_body(status: StatusCode, bytes: Vec<u8>) -> Response<Body> {
    let mut res = Response::new(Body::from(bytes));
    *res.status_mut() = status;
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

fn empty(status: StatusCode) -> Response<Body> {
    let mut res = Response::new(Body::empty());
    *res.status_mut() = status;
    res
}

fn error_response(e: HouseError) -> Response<Body> {
    let status = status_for(&e);
    // The message is written for the user, not the developer: the client shows it as-is
    // (`houseClient.ts` surfaces `error`), so a refusal has to say what to do about it.
    let body = serde_json::json!({ "error": e.to_string() }).to_string();
    json_body(status, body.into_bytes())
}

/// A JSON body with its `ETag`, honouring `If-None-Match`.
///
/// The validator is computed over the exact bytes in `bytes` (in `house.rs`), so a 304 here can
/// only happen when the representation the client holds is byte-identical to the one being served.
fn json_with_etag(bytes: Vec<u8>, etag: String, headers: &HeaderMap, status: StatusCode) -> Response<Body> {
    let Ok(value) = HeaderValue::from_str(&etag) else {
        // Unreachable: the etag is `"fnv1a-<hex>"`. Serving the body without a validator is the
        // safe direction — the client re-reads, which is what it would have done anyway.
        return json_body(status, bytes);
    };
    if let Some(requested) = headers.get(header::IF_NONE_MATCH) {
        let matches = requested == &value
            || requested
                .to_str()
                .map(|s| s.split(',').any(|part| part.trim() == etag || part.trim() == "*"))
                .unwrap_or(false);
        if matches {
            // 304 carries the validator and no body, so the client keeps what it has.
            let mut res = empty(StatusCode::NOT_MODIFIED);
            res.headers_mut().insert(header::ETAG, value);
            return res;
        }
    }
    let mut res = json_body(status, bytes);
    res.headers_mut().insert(header::ETAG, value);
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    res
}

/// The service is up and answering. `problems` names any document that could not be read — a
/// non-empty list is why writes will be refused, so a client should show it rather than hide it.
async fn health(State(store): State<Arc<HouseStore>>) -> Response<Body> {
    match serde_json::to_vec(&store.health().await) {
        Ok(bytes) => json_body(StatusCode::OK, bytes),
        Err(e) => error_response(HouseError::Io(format!("could not report health: {e}"))),
    }
}

async fn list_tools(State(store): State<Arc<HouseStore>>, headers: HeaderMap) -> Response<Body> {
    match store.tools().await {
        Ok((bytes, etag)) => json_with_etag(bytes, etag, &headers, StatusCode::OK),
        Err(e) => error_response(e),
    }
}

async fn create_tool(
    State(store): State<Arc<HouseStore>>,
    axum::Json(entry): axum::Json<ToolLibraryEntry>,
) -> Response<Body> {
    match store.create_tool(entry).await {
        Ok(()) => empty(StatusCode::CREATED),
        Err(e) => error_response(e),
    }
}

async fn update_tool(
    State(store): State<Arc<HouseStore>>,
    Path(key): Path<String>,
    axum::Json(entry): axum::Json<ToolLibraryEntry>,
) -> Response<Body> {
    // The path is the key, not the body's copy of it: a PATCH that disagrees with its own URL is a
    // mistake worth surfacing rather than silently resolving one way.
    if entry.key != key {
        return error_response(HouseError::BadKey(format!(
            "the body's key {} does not match the URL's {key}",
            entry.key
        )));
    }
    match store.update_tool(entry).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

async fn delete_tool(State(store): State<Arc<HouseStore>>, Path(key): Path<String>) -> Response<Body> {
    match store.delete_tool(&key).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

async fn list_inventory(State(store): State<Arc<HouseStore>>, headers: HeaderMap) -> Response<Body> {
    match store.inventory().await {
        Ok((bytes, etag)) => json_with_etag(bytes, etag, &headers, StatusCode::OK),
        Err(e) => error_response(e),
    }
}

async fn create_inventory(
    State(store): State<Arc<HouseStore>>,
    axum::Json(item): axum::Json<InventoryItem>,
) -> Response<Body> {
    match store.create_inventory(item).await {
        Ok(()) => empty(StatusCode::CREATED),
        Err(e) => error_response(e),
    }
}

async fn update_inventory(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    axum::Json(item): axum::Json<InventoryItem>,
) -> Response<Body> {
    if item.id != id {
        return error_response(HouseError::NotFound(format!(
            "the body's id {} does not match the URL's {id}",
            item.id
        )));
    }
    match store.update_inventory(item).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

async fn delete_inventory(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
) -> Response<Body> {
    match store.delete_inventory(&id).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

/// The house document for a "my machine" file (#247). `Content-Disposition` is set so the browser
/// saves rather than renders it — the only endpoint here whose body is a file.
async fn export_house(State(store): State<Arc<HouseStore>>) -> Response<Body> {
    match store.export().await {
        Ok(bytes) => {
            let mut res = json_body(StatusCode::OK, bytes);
            res.headers_mut().insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"house.json\""),
            );
            res
        }
        Err(e) => error_response(e),
    }
}

async fn import_house(State(store): State<Arc<HouseStore>>, body: axum::body::Bytes) -> Response<Body> {
    // Deliberately the RAW body rather than `Json<HouseDoc>`: `house.rs` parses it so the refusal
    // can name the version or the kind it found, which axum's own 422 would not.
    match store.import(&body).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

/// Anything else under `/api/v1/` is 404 **as JSON**, never the SPA's `index.html`. This route is
/// the reason a probe cannot be fooled by the fallback; `server.rs`'s tests pin it against the real
/// router.
async fn api_not_found(OriginalUri(uri): OriginalUri) -> Response<Body> {
    error_response(HouseError::NotFound(format!(
        "{} is not a house service endpoint",
        uri.path()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::house::{Coded, Tool, ToolShape, HOUSE_SCHEMA_VERSION};
    use axum::http::Request;
    use tempfile::TempDir;
    use tower::ServiceExt;

    /// A router over a fresh temp directory. (An in-memory store would be a different code path than
    /// the one the app runs — the file IS the store's other half.)
    pub fn app_under_test() -> (TempDir, Router) {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(HouseStore::open(dir.path().to_path_buf()));
        (dir, routes(store))
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    fn post_json(uri: &str, body: &impl serde::Serialize) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(body).unwrap()))
            .unwrap()
    }

    async fn bytes_of(res: Response<Body>) -> Vec<u8> {
        axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec()
    }

    async fn json_of(res: Response<Body>) -> serde_json::Value {
        let bytes = bytes_of(res).await;
        serde_json::from_slice(&bytes).expect("a JSON body")
    }

    fn is_json(res: &Response<Body>) -> bool {
        res.headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.starts_with("application/json"))
            .unwrap_or(false)
    }

    fn a_tool(name: &str) -> Tool {
        Tool {
            name: name.to_string(),
            type_text: "Flat End".to_string(),
            shape: ToolShape::Flat,
            diameter: Some(2.0),
            ..Tool::default()
        }
    }

    fn an_entry(key: &str) -> ToolLibraryEntry {
        ToolLibraryEntry {
            key: key.to_string(),
            tool: a_tool("2 mm flat end"),
            provenance: "typed in by hand".to_string(),
        }
    }

    fn an_item(id: &str) -> InventoryItem {
        InventoryItem {
            id: id.to_string(),
            tool: a_tool("1/4 in ball nose"),
            origin: None,
            quantity: 1,
            codes: vec![Coded {
                symbology: "qr_code".to_string(),
                value: "C1-BIT-BALL-NOSE-1-4".to_string(),
            }],
            added_at: "2026-10-08T00:00:00.000Z".to_string(),
            notes: None,
        }
    }

    #[tokio::test]
    async fn health_reports_the_schema_the_client_must_agree_with() {
        let (_dir, app) = app_under_test();
        let res = app.oneshot(get("/api/v1/health")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(is_json(&res), "health must not be answered with the SPA's index.html");
        let body = json_of(res).await;
        assert_eq!(body["ok"], serde_json::json!(true));
        assert_eq!(body["schemaVersion"], serde_json::json!(HOUSE_SCHEMA_VERSION));
        assert_eq!(body["hasCatalogue"], serde_json::json!(false));
        assert_eq!(body["problems"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn an_unknown_api_path_is_a_json_404() {
        let (_dir, app) = app_under_test();
        let res = app.oneshot(get("/api/v1/nothing/here")).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert!(is_json(&res));
        let body = json_of(res).await;
        assert!(
            body["error"].as_str().unwrap().contains("/api/v1/nothing/here"),
            "the refusal names the path it refused: {body}"
        );
    }

    #[tokio::test]
    async fn a_tool_is_created_then_listed_with_a_validator() {
        let (_dir, app) = app_under_test();
        let res = app
            .clone()
            .oneshot(post_json("/api/v1/tools", &an_entry("user:abc")))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let res = app.clone().oneshot(get("/api/v1/tools")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let etag = res
            .headers()
            .get(header::ETAG)
            .expect("a list endpoint always carries a validator")
            .clone();
        assert_eq!(res.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
        let body = json_of(res).await;
        assert_eq!(body[0]["key"], serde_json::json!("user:abc"));

        // The second read with the validator is a 304 with no body at all.
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/tools")
                    .header(header::IF_NONE_MATCH, etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
        assert!(bytes_of(res).await.is_empty());
    }

    #[tokio::test]
    async fn the_same_item_twice_is_a_409_and_leaves_one_item() {
        let (_dir, app) = app_under_test();
        let first = app
            .clone()
            .oneshot(post_json("/api/v1/tools", &an_entry("user:abc")))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::CREATED);
        let again = app
            .clone()
            .oneshot(post_json("/api/v1/tools", &an_entry("user:abc")))
            .await
            .unwrap();
        assert_eq!(again.status(), StatusCode::CONFLICT);
        let body = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_key_that_cannot_be_written_to_a_nc_header_is_a_400() {
        let (_dir, app) = app_under_test();
        for key in ["flat-1.0", "user:a|b", "cat:112111313812"] {
            let res = app
                .clone()
                .oneshot(post_json("/api/v1/tools", &an_entry(key)))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{key}");
            assert!(is_json(&res));
        }
    }

    #[tokio::test]
    async fn a_tool_is_replaced_by_patch_and_removed_by_delete() {
        let (_dir, app) = app_under_test();
        app.clone()
            .oneshot(post_json("/api/v1/tools", &an_entry("user:abc")))
            .await
            .unwrap();

        let edited = ToolLibraryEntry {
            key: "user:abc".to_string(),
            tool: a_tool("2 mm flat end, re-measured"),
            provenance: "calipers, 2026-10-08".to_string(),
        };
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/v1/tools/user:abc")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&edited).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body[0]["tool"]["name"], serde_json::json!("2 mm flat end, re-measured"));
        assert_eq!(body[0]["provenance"], serde_json::json!("calipers, 2026-10-08"));

        // A patch whose body disagrees with its own URL is refused rather than resolved silently.
        let mismatched = ToolLibraryEntry {
            key: "user:other".to_string(),
            ..edited.clone()
        };
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/v1/tools/user:abc")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&mismatched).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/tools/user:abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let body = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body, serde_json::json!([]));
    }

    #[tokio::test]
    async fn the_inventory_walks_its_whole_lifecycle() {
        let (_dir, app) = app_under_test();
        assert_eq!(
            app.clone()
                .oneshot(post_json("/api/v1/inventory", &an_item("inv-1")))
                .await
                .unwrap()
                .status(),
            StatusCode::CREATED
        );
        let body = json_of(app.clone().oneshot(get("/api/v1/inventory")).await.unwrap()).await;
        assert_eq!(body[0]["codes"][0]["value"], serde_json::json!("C1-BIT-BALL-NOSE-1-4"));

        let mut more = an_item("inv-1");
        more.quantity = 2;
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method("PATCH")
                        .uri("/api/v1/inventory/inv-1")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(serde_json::to_vec(&more).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let body = json_of(app.clone().oneshot(get("/api/v1/inventory")).await.unwrap()).await;
        assert_eq!(body[0]["quantity"], serde_json::json!(2));

        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method("DELETE")
                        .uri("/api/v1/inventory/inv-1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn an_export_import_round_trip_through_http() {
        let (_dir, app) = app_under_test();
        app.clone()
            .oneshot(post_json("/api/v1/tools", &an_entry("user:abc")))
            .await
            .unwrap();

        let res = app.clone().oneshot(get("/api/v1/export")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("attachment"));
        let exported = bytes_of(res).await;

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/import")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(exported))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let body = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body[0]["key"], serde_json::json!("user:abc"));

        // A body that is not a house file is refused with a reason, not a 500.
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/import")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(b"{\"kind\":\"something-else\"}".to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }
}
