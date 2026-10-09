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
        // #310. A SECOND document from `/tools`, not a field on it: the feed matrix is 1 328 rows
        // against the cutters' 129, and its own `ETag`, so a client that wants only the cutters does
        // not parse it and a re-sync that moves one number does not invalidate the list.
        .route("/api/v1/feeds", get(list_feeds))
        .route(
            "/api/v1/inventory/*id",
            patch(update_inventory).delete(delete_inventory),
        )
        .route("/api/v1/export", get(export_house))
        .route("/api/v1/import", post(import_house))
        // #308. POST and nothing else: a sync reads Makera Studio's own database and replaces the
        // `cat:` tier, so it is not something a GET may do by accident — but it takes NO body. The
        // path to the vendor file is the process's own (see `HouseStore::studio_db`), not a
        // parameter a request can supply: this endpoint must never be a way to read an arbitrary
        // file off the machine it runs on.
        .route("/api/v1/catalogue/sync", post(sync_catalogue))
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

/// Makera's feed matrix, the tier BELOW measurement (#310). A plain array of rows, no envelope: the
/// client's schema is the shape, and `[]` — a catalogue with no starting numbers — is a normal
/// answer, not a 404, so a job in a material the catalogue does not cover simply resolves as it did
/// before the tier existed.
async fn list_feeds(State(store): State<Arc<HouseStore>>, headers: HeaderMap) -> Response<Body> {
    match store.feeds().await {
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

/// Import Makera's catalogue from Studio's own library (#308). The body is the report: what was
/// added, removed and changed, and one sentence per thing worth saying about a sync that worked.
/// No `ETag` — the report is about one event, not a representation a client should be revalidating.
async fn sync_catalogue(State(store): State<Arc<HouseStore>>) -> Response<Body> {
    match store.sync_catalogue().await {
        Ok(report) => match serde_json::to_vec(&report) {
            Ok(bytes) => json_body(StatusCode::OK, bytes),
            Err(e) => error_response(HouseError::Io(format!(
                "the sync worked but its report could not be serialized: {e}"
            ))),
        },
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
        // A fresh house has no feed rows either, and the two are separate answers: a catalogue
        // synced before the feed tier existed is `hasCatalogue: true, feedRows: 0` (#310).
        assert_eq!(body["feedRows"], serde_json::json!(0));
        assert_eq!(body["problems"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn an_empty_feed_matrix_is_served_as_an_empty_list_not_a_404() {
        // The acceptance's last clause from the other side: with no catalogue, `/feeds` answers
        // `[]` rather than a refusal, so the client's tier is simply empty and every job resolves
        // exactly as it did before #310.
        let (_dir, app) = app_under_test();
        let res = app.clone().oneshot(get("/api/v1/feeds")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(is_json(&res), "the SPA fallback must not answer for the API");
        let etag = res
            .headers()
            .get(header::ETAG)
            .expect("a list endpoint always carries a validator")
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(json_of(res).await, serde_json::json!([]));

        // And it revalidates like the other list endpoints.
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/feeds")
                    .header(header::IF_NONE_MATCH, etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn a_catalogue_written_before_the_feed_tier_serves_no_rows() {
        // The upgrade path #310 has to be honest about: a `catalogue.json` written by #308 has no
        // `feeds` key at all. It must still load — `#[serde(default)]` — and serve an empty matrix
        // beside its tools, which is precisely the state health reports as `feedRows: 0`.
        use crate::house::CATALOGUE_FILE;
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(CATALOGUE_FILE),
            br#"{"kind":"casemaker-catalogue","schemaVersion":1,
                 "syncedAt":"2026-10-08T12:00:00.000Z","tools":[]}"#,
        )
        .unwrap();
        let store = Arc::new(HouseStore::open(dir.path().to_path_buf()));
        let app = routes(store);

        let body = json_of(app.clone().oneshot(get("/api/v1/health")).await.unwrap()).await;
        assert_eq!(body["feedRows"], serde_json::json!(0));
        assert_eq!(body["problems"], serde_json::json!([]));
        assert_eq!(
            json_of(app.clone().oneshot(get("/api/v1/feeds")).await.unwrap()).await,
            serde_json::json!([])
        );
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

    /// A router whose sync reads a Makera library built by the test. The path is a constructor
    /// argument and NOT a request parameter — this endpoint must never become a way to read an
    /// arbitrary file on the machine the service runs on.
    fn app_syncing_from(dir: &TempDir, db: &std::path::Path) -> Router {
        let store = Arc::new(HouseStore::open_with(
            dir.path().to_path_buf(),
            Some(db.to_path_buf()),
        ));
        routes(store)
    }

    #[tokio::test]
    async fn a_sync_replaces_the_catalogue_tier_and_reports_it() {
        use crate::catalogue::fixture;
        let dir = TempDir::new().unwrap();
        let db = fixture::temp_db(dir.path());
        let conn = fixture::db(&db);
        let flat = fixture::Cutter {
            diameter: Some(3.175),
            tip: Some(3.175),
            ..fixture::Cutter::new("3.175*12mm Flat End(Metal)", 1)
        };
        fixture::put(&conn, &flat);
        fixture::put(
            &conn,
            &fixture::Cutter {
                diameter: Some(3.175),
                max_diameter: Some(1.0),
                corner: Some(0.5),
                ..fixture::Cutter::new("3.175*1*3mm Ball Nose(Metal)", 0)
            },
        );
        // One row of Makera's feed matrix (#310), for the flat end, filed under a wood material.
        fixture::material(&conn, "mat-hw", "Hardwood");
        fixture::put_feed(
            &conn,
            &fixture::Feed {
                id: "prop-1".to_string(),
                material_id: "mat-hw".to_string(),
                cutter_id: flat.cutter_id.clone(),
                rpm: Some(12000_i64),
                feed: Some(900_i64),
                plunge: Some(300.0),
                step_down: Some(1.2),
            },
        );
        drop(conn);
        let app = app_syncing_from(&dir, &db);

        let body = json_of(app.clone().oneshot(get("/api/v1/health")).await.unwrap()).await;
        assert_eq!(body["hasCatalogue"], serde_json::json!(false));
        assert_eq!(body["feedRows"], serde_json::json!(0));

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/catalogue/sync")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(is_json(&res), "the SPA fallback must not answer for the API");
        let report = json_of(res).await;
        assert_eq!(report["total"], serde_json::json!(2));
        assert_eq!(report["unchanged"], serde_json::json!(0));
        assert_eq!(report["added"].as_array().unwrap().len(), 2);
        assert_eq!(report["removed"].as_array().unwrap().len(), 0);
        assert_eq!(report["changed"].as_array().unwrap().len(), 0);
        // The feed matrix came with it, counted but not diffed (#310).
        assert_eq!(report["feedRows"], serde_json::json!(1));
        assert!(report["source"].as_str().unwrap().ends_with("makera_library.db"));
        assert!(report["syncedAt"].as_str().unwrap().ends_with('Z'));

        // The tier is now served to the client, tool-shaped, without the sync's bookkeeping, and
        // health agrees — this is what makes it browseable in every picker (#311).
        let body = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body.as_array().unwrap().len(), 2);
        assert!(body[0]["key"].as_str().unwrap().starts_with("cat:"));
        assert!(body[0]["extras"].is_null(), "{body}");
        assert!(body[0]["contentHash"].is_null(), "{body}");
        assert_eq!(body[0]["tool"]["shape"], serde_json::json!("ball"));
        let body = json_of(app.clone().oneshot(get("/api/v1/health")).await.unwrap()).await;
        assert_eq!(body["hasCatalogue"], serde_json::json!(true));
        assert_eq!(body["feedRows"], serde_json::json!(1));
        assert_eq!(body["problems"], serde_json::json!([]));

        // The matrix is served as its own document, keyed on the vendor's own ids and material
        // words — the client's map translates; the service does not.
        let body = json_of(app.clone().oneshot(get("/api/v1/feeds")).await.unwrap()).await;
        assert_eq!(
            body,
            serde_json::json!([{
                "cutterId": flat.g_id,
                "material": "Hardwood",
                "rpm": 12000.0,
                "feed": 900.0,
                "plungeFeed": 300.0,
                "stepDown": 1.2,
            }]),
            "{body}"
        );

        // A sync is not a read: a GET is refused by the method router, and the JSON 404 for the
        // rest of `/api/v1/` still answers for a path that does not exist.
        let res = app
            .clone()
            .oneshot(get("/api/v1/catalogue/sync"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
        let res = app
            .clone()
            .oneshot(get("/api/v1/catalogue/other"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        // With nowhere to read from, the endpoint says so rather than 500ing.
        let nowhere = TempDir::new().unwrap();
        let store = Arc::new(HouseStore::open_with(
            nowhere.path().to_path_buf(),
            Some(nowhere.path().join("nothing-here.db")),
        ));
        let res = routes(store)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/catalogue/sync")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let body = json_of(res).await;
        assert!(
            body["error"].as_str().unwrap().contains("nothing-here.db"),
            "{body}"
        );
    }

    /// **The gate #308 names**: "a sync is verified against a real install — a unit test with a
    /// hand-built fixture is not evidence that the SQL is right." Ignored by default because it
    /// reads this machine's own Makera Studio library and takes about a second; run it with
    /// `cargo test --lib -- --ignored --nocapture` where Studio is installed.
    ///
    /// It is the whole path except the socket — read, map, validate, write, serve — against 129
    /// rows that were not written by me, and it closes the loop with the ONE piece of the catalogue
    /// an independent source already pins: the `;@MKR|TOOL` line of Makera's own `TopClamp.nc`,
    /// which is where `TOOL_LIBRARY`'s `flat-3.175x12-metal` was seeded from. If the row and the
    /// header disagree on a field Makera actually states, the mapping is wrong — the single
    /// recorded exception is the three fields the header zeroes because it has no way to leave
    /// them out, spelled out at the assertion.
    #[tokio::test]
    #[ignore = "reads this machine's own Makera Studio library"]
    async fn the_real_install_imports_is_idempotent_and_agrees_with_the_nc_header() {
        let db = crate::catalogue::studio_db_path().expect("a data directory");
        assert!(db.exists(), "no Makera Studio library at {}", db.display());
        let before_digest = crate::house::fnv1a_hex(&std::fs::read(&db).unwrap());
        let dir = TempDir::new().unwrap();
        let app = app_syncing_from(&dir, &db);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/catalogue/sync")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let report = json_of(res).await;
        println!("{:#}", report);

        // The corpus, as `/Makera-Parity.md` §3 documents it. These numbers are a witness of the
        // install this was written against, not a contract: if Makera ships a cutter, this is where
        // the newest facts are, and §3 should be updated with them.
        assert_eq!(report["total"], serde_json::json!(129), "the catalogue has moved on");
        assert!(report["notes"].as_array().unwrap().is_empty(), "{report:#}");
        assert_eq!(report["added"].as_array().unwrap().len(), 129);
        assert_eq!(report["removed"].as_array().unwrap().len(), 0);
        assert_eq!(report["changed"].as_array().unwrap().len(), 0);
        // The feed matrix, from the same library (#310). A COUNT, because a feed row has no
        // identity beyond its (cutter, material) pair — and the number is a witness of this
        // install's `t_MakeraCutterProperties`, not a contract.
        assert_eq!(report["feedRows"], serde_json::json!(1328), "the matrix has moved on");

        let feeds = json_of(app.clone().oneshot(get("/api/v1/feeds")).await.unwrap()).await;
        let rows = feeds.as_array().unwrap();
        assert_eq!(rows.len(), 1328);
        // Keyed on the vendor's `g_ID`, and the material is the vendor's own word — the map that
        // turns "Hardwood" into `hardwood` is the client's, so the service must not pre-translate.
        let materials: std::collections::BTreeSet<&str> =
            rows.iter().map(|r| r["material"].as_str().unwrap()).collect();
        println!("feed materials: {materials:?}");
        assert!(materials.contains("Hardwood") && materials.contains("Softwood"), "{materials:?}");
        // The issue's own headline: PLA has no row at all, so the badge job can never be served by
        // this tier. Neither does MDF.
        assert!(!materials.contains("PLA") && !materials.contains("MDF"), "{materials:?}");
        assert!(rows.iter().all(|r| !r["cutterId"].as_str().unwrap().is_empty()), "an unnamed cutter");
        // The TopClamp cutter, the one with an independent source, has a row for each material in
        // the matrix and one apiece — a (cutter, material) pair is a row's whole identity. Wood is
        // among them, which is what makes the tier usable for CNC-2's material at all.
        let topclamp_rows: Vec<_> = rows
            .iter()
            .filter(|r| r["cutterId"] == serde_json::json!("112111313812"))
            .collect();
        println!("{topclamp_rows:#?}");
        let named: std::collections::BTreeSet<&str> = topclamp_rows
            .iter()
            .map(|r| r["material"].as_str().unwrap())
            .collect();
        assert_eq!(named.len(), topclamp_rows.len(), "a material repeated for one cutter");
        for wood in ["Hardwood", "Softwood"] {
            assert!(named.contains(wood), "the 3.175 flat end has no {wood} row: {named:?}");
        }

        // What was written, read back from the file itself.
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("catalogue.json")).unwrap()).unwrap();
        assert_eq!(written["kind"], serde_json::json!("casemaker-catalogue"));
        let tools = written["tools"].as_array().unwrap();
        // Every cutter a feed row names is a cutter this service also serves: a feed row with no
        // cutter behind it would be a number the client could never look up.
        let cutters: std::collections::BTreeSet<&str> = tools
            .iter()
            .map(|e| e["tool"]["id"].as_str().unwrap())
            .collect();
        for row in rows {
            assert!(cutters.contains(row["cutterId"].as_str().unwrap()), "{row}");
        }
        let mut by_category: std::collections::BTreeMap<i64, usize> = Default::default();
        for entry in tools {
            let category = entry["extras"]["categoryId"].as_i64().unwrap();
            *by_category.entry(category).or_default() += 1;
            assert_eq!(
                entry["key"],
                serde_json::json!(format!("cat:{}", entry["extras"]["cutterId"].as_str().unwrap()))
            );
            // A category this build has no name for would have said so in the notes.
            assert_ne!(entry["tool"]["shape"], serde_json::json!("unknown"));
        }
        println!("by category: {by_category:?}");
        assert_eq!(
            by_category,
            [(0, 18), (1, 45), (2, 3), (3, 22), (5, 30), (6, 8), (7, 3)]
                .into_iter()
                .collect(),
            "the category counts disagree with /Makera-Parity.md §3"
        );

        // The one cutter with an independent source: `flat-3.175x12-metal` in
        // `engine/cnc/toolLibrary.ts` is verbatim from the `;@MKR|TOOL` line of Makera's own
        // TopClamp.nc, so this compares the database against the header Makera wrote.
        let topclamp = tools
            .iter()
            .find(|e| e["tool"]["id"] == serde_json::json!("112111313812"))
            .expect("the TopClamp cutter");
        println!("{topclamp:#}");
        for (field, expected) in [
            ("name", serde_json::json!("3.175*12mm Flat End(Metal)")),
            ("typeText", serde_json::json!("Flat End")),
            ("shape", serde_json::json!("flat")),
            ("handleDiameter", serde_json::json!(3.175)),
            ("diameter", serde_json::json!(3.175)),
            ("tipDiameter", serde_json::json!(3.175)),
            // The one place the header and the database disagree, and the database is the more
            // careful of the two. TopClamp.nc's line ends `cornerradius=0|angle=0|halfAngle=0`,
            // which is what the exporter writes for a flat end mill that has none of the three;
            // Makera's own table stores `''` for the same unstated values, and a stated value is
            // what this service reads. So `TOOL_LIBRARY`'s hand-copied entry carries 0 (it is
            // verbatim from the header) while the imported row carries null — neither is a wrong
            // geometry for a flat end mill, and only the null one avoids claiming the vendor said
            // something it did not. Note the same field round-trips through a job file as 0: the
            // `.nc` writer has no way to write "unset" either.
            ("cornerRadius", serde_json::Value::Null),
            ("angle", serde_json::Value::Null),
            ("halfAngle", serde_json::Value::Null),
            ("fluteLength", serde_json::json!(12.0)),
            ("shoulderLength", serde_json::json!(12.0)),
            ("stickout", serde_json::Value::Null),
            ("centreCutting", serde_json::Value::Null),
        ] {
            assert_eq!(topclamp["tool"][field], expected, "{field} disagrees");
        }

        // Idempotent: the second run reports every row unchanged, and serves byte-identical tools.
        let before = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/catalogue/sync")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let again = json_of(res).await;
        assert_eq!(again["unchanged"], serde_json::json!(129));
        assert_eq!(again["feedRows"], serde_json::json!(1328));
        assert_eq!(again["added"], serde_json::json!([]));
        assert_eq!(again["removed"], serde_json::json!([]));
        assert_eq!(again["changed"], serde_json::json!([]));
        let after = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(before, after, "a re-sync must not change what is served");

        // Leave the real service's own answer where the browser QA can pick it up
        // (`qa-308-catalogue.mjs`, which reads this path unless `QA_308_FIXTURE` says otherwise).
        // The point of the hand-off is that the client and the picker are exercised against the
        // catalogue itself — 129 rows of Makera's own numbers, and since #310 its 1 328 feed rows —
        // instead of a stand-in written by hand, which is the one thing qa-306's stub could not do.
        let fixture = serde_json::json!({
            "source": db.display().to_string(),
            "health": json_of(app.clone().oneshot(get("/api/v1/health")).await.unwrap()).await,
            "tools": after,
            "feeds": feeds,
        });
        let path = std::env::temp_dir().join("casemaker-308-tools.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
        println!("fixture: {}", path.display());

        // And Studio's own file is byte-for-byte where it was: this service never writes to it, and
        // never opened it for writing. A 14 MB digest, because "we only read" is a claim about
        // bytes.
        assert_eq!(
            crate::house::fnv1a_hex(&std::fs::read(&db).unwrap()),
            before_digest,
            "the vendor database was modified by a sync"
        );
    }
}
