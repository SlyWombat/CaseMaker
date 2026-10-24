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
// WRITES ARE HERE, AND SO IS THE CLIENT'S WRITE PATH. Every endpoint #212 describes has been served
// here since #306, and since #311 `platform/houseClient.ts` implements the writes as well as the
// reads — register, clone, edit, remove, sync, export, import are all reachable from the panel.
//
// TWO OF THE FOUR METHODS TAKE A GUARD, AND THE OTHER TWO TAKE A REASON INSTEAD (#321). `PATCH` and
// `DELETE` change a document somebody has already read, so each requires `If-Match` with that
// document's `ETag`: a missing header is 428 and one that names a version no longer served is 412
// (`status_for`). `POST` is NOT guarded, because a create is judged against its key — a second create
// of the same key is a 409 whatever version it was based on, which is a stronger answer than a
// validator. `POST /import` is not guarded either: a "my machine" file replaces the house wholesale
// and there is no prior version here to be based on. The guard is per LIST (`/tools` vs
// `/inventory`), never per entry: the list is the representation the client actually read and whose
// `ETag` it holds.
//
// THE KEY IS A WILDCARD PATH SEGMENT (`/tools/*key`), NOT A SINGLE SEGMENT, so a key containing `/`
// routes without any escaping — and the client must therefore NOT `encodeURIComponent` a whole key,
// because `%2F` is decoded or rejected at the discretion of every proxy in between. Mint keys
// without slashes anyway; the wildcard exists so that a bad one cannot silently 404.
//
// NO CACHE HEADERS BEYOND `ETag`. `no-cache` and an `ETag` are enough for a same-origin fetch from
// the app's own window: a 304 saves the body and nothing else is gained by `max-age` on a list the
// user is editing.

use crate::feeds::FeedRow;
use crate::house::{HouseError, HouseStore, InventoryItem, ToolLibraryEntry};
use crate::location::{FixtureRecord, MachineRecord};
use crate::stock::StockItem;
use axum::body::Body;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{any, get, patch, post, put};
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
        // #446. The vendor's purchasable stock sizes, read from Studio's library at sync time. Its
        // own document for the same reason as `/feeds`: a client that wants only the sizes does not
        // parse 1 328 feed rows, and the two lists move independently.
        .route("/api/v1/material-specs", get(list_material_specs))
        .route(
            "/api/v1/inventory/*id",
            patch(update_inventory).delete(delete_inventory),
        )
        // #412. The location's identity and machines; the tool tiers stay on their own routes.
        .route("/api/v1/location", get(get_location))
        .route("/api/v1/location/machines/*id", put(put_machine))
        .route("/api/v1/location/accessories/*id", put(put_accessory).delete(delete_accessory))
        // #412 re-review. Dismiss the "house.json changed after location.json" warning. No body.
        .route("/api/v1/location/house-warning/dismiss", post(dismiss_house_warning))
        // #413. The stock shelf: its own list, `ETag` and guarded writes, as the inventory has.
        .route("/api/v1/stock", get(list_stock).post(create_stock))
        .route("/api/v1/stock/*id", patch(update_stock).delete(delete_stock))
        // #450 slice 2. The feeds table: its own list, `ETag` and guarded writes like the shelf.
        // NOT `/api/v1/feeds` — that path is the Makera catalogue (see the route above).
        .route("/api/v1/feed-table", get(list_feed_table).post(create_feed))
        .route("/api/v1/feed-table/*id", patch(update_feed).delete(delete_feed))
        // #416. An optional power switch per machine: its config (guarded on the location), its token
        // (this computer only, into the secure store), and the switch itself.
        .route(
            "/api/v1/power/:id",
            get(power_status).put(set_power).delete(remove_power),
        )
        .route("/api/v1/power/:id/token", put(set_power_token))
        .route("/api/v1/power/:id/on", post(power_on))
        .route("/api/v1/power/:id/off", post(power_off))
        // #417. The machine's wasteboard record (null clears it), guarded on the location.
        .route("/api/v1/wasteboard/:id", put(set_wasteboard))
        // #419 §4.5. Append one finished program's FNV hash to a machine's list. A POST action, not
        // a guarded PUT: an append needs no prior read, and two windows finishing at once must both
        // land (see `HouseStore::add_finished_program`).
        .route("/api/v1/finished-programs/:id", post(add_finished_program))
        // The shop's defaults: tunable values with provenance, open to new keys (`defaults.rs`).
        .route("/api/v1/defaults", get(list_defaults))
        .route("/api/v1/defaults/:key", put(put_default).delete(reset_default))
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
        // #321. A guarded write with no validator to check, and one whose validator is no longer
        // current. 428 is the status that says the header was MISSING rather than wrong, which is
        // the difference between "your client is out of date" and "somebody else got there first".
        HouseError::PreconditionRequired(_) => StatusCode::PRECONDITION_REQUIRED,
        HouseError::StalePrecondition(_) => StatusCode::PRECONDITION_FAILED,
        HouseError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// The `If-Match` header, if the request carried one (#321).
///
/// Trimmed: the header's grammar allows optional whitespace around the field value, and a validator
/// with a stray space around it would compare unequal to the very `ETag` the client meant. An EMPTY
/// value is no validator at all (#339): it names no version, so it is the 428 "you did not say"
/// rather than the 412 "you said a version that is gone".
fn if_match(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub(crate) fn json_body(status: StatusCode, bytes: Vec<u8>) -> Response<Body> {
    let mut res = Response::new(Body::from(bytes));
    *res.status_mut() = status;
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

/// A refusal, in the one shape this server uses for them (#372).
///
/// `{"error": "..."}` and nothing else, because that is exactly what `platform/houseClient.ts`
/// reads as "the service itself said no, in these words" — anything else that answers (a page, a
/// proxy, a static host) is reported as "somebody else answered", and the user then sees a
/// transport failure instead of a reason. `config_api.rs` writes its refusals with this too, so
/// the shape is stated once rather than agreed on twice.
pub(crate) fn json_error(status: StatusCode, message: String) -> Response<Body> {
    let body = serde_json::json!({ "error": message }).to_string();
    json_body(status, body.into_bytes())
}

fn empty(status: StatusCode) -> Response<Body> {
    let mut res = Response::new(Body::empty());
    *res.status_mut() = status;
    res
}

fn error_response(e: HouseError) -> Response<Body> {
    // The message is written for the user, not the developer: the client shows it as-is
    // (`houseClient.ts` surfaces `error`), so a refusal has to say what to do about it.
    json_error(status_for(&e), e.to_string())
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
        // The matching rule is `etag.rs`'s, so the API and the SPA shell answer "the same bytes"
        // identically (#313).
        if crate::etag::if_none_match_covers(requested, &etag) {
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

/// The vendor's purchasable stock sizes (#446). A plain array, like `/feeds`: the client's schema is
/// the shape, and `[]` — a library with no `t_MaterialSpecs`, or a catalogue synced before the sizes
/// were read — is a normal answer, not a 404.
async fn list_material_specs(
    State(store): State<Arc<HouseStore>>,
    headers: HeaderMap,
) -> Response<Body> {
    match store.material_specs().await {
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

/// Replace a definition in place. GUARDED (#321): the request must carry `If-Match` with the `ETag`
/// of the tool list it read, or the service has no way to tell this save from one based on a list
/// somebody else has already changed. A missing header is 428, a stale one 412 — see
/// `status_for`. `POST` is not guarded: a create is checked against the key, which is a stronger
/// answer than a validator (a second create of the same key is a 409 whatever version it was based
/// on).
async fn update_tool(
    State(store): State<Arc<HouseStore>>,
    Path(key): Path<String>,
    headers: HeaderMap,
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
    let guard = if_match(&headers);
    match store.update_tool(entry, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// Remove a definition. Guarded exactly as `update_tool` is (#321).
async fn delete_tool(
    State(store): State<Arc<HouseStore>>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let guard = if_match(&headers);
    match store.delete_tool(&key, guard.as_deref()).await {
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

/// Change a possession. GUARDED on the INVENTORY list's `ETag` (#321) — the document this client
/// read to find the row, so a re-measured tool definition does not invalidate a count edit.
async fn update_inventory(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    axum::Json(item): axum::Json<InventoryItem>,
) -> Response<Body> {
    if item.id != id {
        return error_response(HouseError::NotFound(format!(
            "the body's id {} does not match the URL's {id}",
            item.id
        )));
    }
    let guard = if_match(&headers);
    match store.update_inventory(item, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// Take a cutter out of the inventory. Guarded as `update_inventory` is (#321).
async fn delete_inventory(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let guard = if_match(&headers);
    match store.delete_inventory(&id, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

async fn list_stock(State(store): State<Arc<HouseStore>>, headers: HeaderMap) -> Response<Body> {
    match store.stock().await {
        Ok((bytes, etag)) => json_with_etag(bytes, etag, &headers, StatusCode::OK),
        Err(e) => error_response(e),
    }
}

async fn create_stock(
    State(store): State<Arc<HouseStore>>,
    axum::Json(item): axum::Json<StockItem>,
) -> Response<Body> {
    match store.create_stock(item).await {
        Ok(()) => empty(StatusCode::CREATED),
        Err(e) => error_response(e),
    }
}

/// Replace a shelf entry. GUARDED on the shelf's `ETag` (#321's rule, #413).
async fn update_stock(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    axum::Json(item): axum::Json<StockItem>,
) -> Response<Body> {
    if item.id != id {
        return error_response(HouseError::BadEntry(format!(
            "the body's id {} does not match the URL's {id}",
            item.id
        )));
    }
    let guard = if_match(&headers);
    match store.update_stock(item, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// Take an entry off the shelf. Guarded as `update_stock` is.
async fn delete_stock(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let guard = if_match(&headers);
    match store.delete_stock(&id, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

/// The feeds table (#450). Same shape as the shelf: its own `ETag`, an unguarded create and
/// guarded edits.
async fn list_feed_table(State(store): State<Arc<HouseStore>>, headers: HeaderMap) -> Response<Body> {
    match store.feed_table().await {
        Ok((bytes, etag)) => json_with_etag(bytes, etag, &headers, StatusCode::OK),
        Err(e) => error_response(e),
    }
}

async fn create_feed(
    State(store): State<Arc<HouseStore>>,
    axum::Json(row): axum::Json<FeedRow>,
) -> Response<Body> {
    match store.create_feed(row).await {
        Ok(()) => empty(StatusCode::CREATED),
        Err(e) => error_response(e),
    }
}

/// Replace a feed row. GUARDED on the table's `ETag`, like `update_stock`.
async fn update_feed(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    axum::Json(row): axum::Json<FeedRow>,
) -> Response<Body> {
    if row.id != id {
        return error_response(HouseError::BadEntry(format!(
            "the body's id {} does not match the URL's {id}",
            row.id
        )));
    }
    let guard = if_match(&headers);
    match store.update_feed(row, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// Remove a feed row. Guarded as `update_feed` is.
async fn delete_feed(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let guard = if_match(&headers);
    match store.delete_feed(&id, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

/// Refuse a request that did not come from the computer Case Maker runs on (#416 review). A power
/// switch's configuration says where its token is sent, and its on/off cuts a machine's mains: both
/// are decisions for the person at that computer, not for any browser on the LAN (decision 35's rule,
/// as `config_api` applies it).
fn local_only(peer: std::net::SocketAddr, what: &str) -> Option<Response<Body>> {
    let ip = peer.ip().to_canonical();
    (!ip.is_loopback()).then(|| {
        json_error(
            StatusCode::FORBIDDEN,
            format!("{what} only from the computer Case Maker runs on, and this request came from {ip}"),
        )
    })
}

type Peer = axum::extract::ConnectInfo<std::net::SocketAddr>;

fn power_json(status: crate::house::PowerStatus) -> Response<Body> {
    match serde_json::to_vec(&status) {
        Ok(bytes) => json_body(StatusCode::OK, bytes),
        Err(e) => error_response(HouseError::Io(format!("could not report the switch: {e}"))),
    }
}

/// The switch, whether a token is saved, and the plug's state (#416). Never the token.
async fn power_status(State(store): State<Arc<HouseStore>>, Path(id): Path<String>) -> Response<Body> {
    match store.power_status(&id).await {
        Ok(s) => power_json(s),
        Err(e) => error_response(e),
    }
}

/// Set up or change a machine's switch. Guarded on the location's `ETag` (#321's rule).
async fn set_power(
    State(store): State<Arc<HouseStore>>,
    axum::extract::ConnectInfo(peer): Peer,
    Path(id): Path<String>,
    headers: HeaderMap,
    axum::Json(switch): axum::Json<crate::power::PowerSwitch>,
) -> Response<Body> {
    if let Some(refused) = local_only(peer, "a power switch can be set up") {
        return refused;
    }
    let guard = if_match(&headers);
    match store.set_power(&id, Some(switch), guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// Remove a machine's switch, and its token. Guarded as `set_power` is.
async fn remove_power(
    State(store): State<Arc<HouseStore>>,
    axum::extract::ConnectInfo(peer): Peer,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    if let Some(refused) = local_only(peer, "a power switch can be removed") {
        return refused;
    }
    let guard = if_match(&headers);
    match store.set_power(&id, None, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    token: String,
}

/// Save a switch's token in the secure store (#416). FROM THIS COMPUTER ONLY — decision 35's rule,
/// as `config_api` applies it: whoever can set the token decides what the app's switch talks to, and
/// the LAN is a boundary for the house's data, not for the machine's mains.
async fn set_power_token(
    State(store): State<Arc<HouseStore>>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> Response<Body> {
    if let Some(refused) = local_only(peer, "a power switch's token can be saved") {
        return refused;
    }
    // Parsed by hand so a refusal can never echo the body back (serde's error quotes the input).
    let Ok(TokenBody { token }) = serde_json::from_slice::<TokenBody>(&body) else {
        return error_response(HouseError::BadEntry("this endpoint takes {\"token\": \"…\"}".into()));
    };
    match store.set_power_token(&id, &token).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

async fn power_on(
    State(store): State<Arc<HouseStore>>,
    axum::extract::ConnectInfo(peer): Peer,
    Path(id): Path<String>,
) -> Response<Body> {
    if let Some(refused) = local_only(peer, "a machine's power can be switched") {
        return refused;
    }
    match store.switch_power(&id, true).await {
        Ok(s) => power_json(s),
        Err(e) => error_response(e),
    }
}

async fn power_off(
    State(store): State<Arc<HouseStore>>,
    axum::extract::ConnectInfo(peer): Peer,
    Path(id): Path<String>,
) -> Response<Body> {
    if let Some(refused) = local_only(peer, "a machine's power can be switched") {
        return refused;
    }
    match store.switch_power(&id, false).await {
        Ok(s) => power_json(s),
        Err(e) => error_response(e),
    }
}

/// Record, change or clear (`null`) a machine's wasteboard (#417). Guarded on the location's `ETag`.
async fn set_wasteboard(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    axum::Json(board): axum::Json<Option<crate::wasteboard::Wasteboard>>,
) -> Response<Body> {
    let guard = if_match(&headers);
    match store.set_wasteboard(&id, board, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FinishedProgramBody {
    hash: String,
}

/// Record one program that finished cleanly on a machine (#419 §4.5). A repeat is a no-op, so a
/// retry after a dropped response cannot duplicate the hash.
async fn add_finished_program(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    axum::Json(body): axum::Json<FinishedProgramBody>,
) -> Response<Body> {
    match store.add_finished_program(&id, &body.hash).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

async fn list_defaults(State(store): State<Arc<HouseStore>>, headers: HeaderMap) -> Response<Body> {
    match store.defaults().await {
        Ok((bytes, etag)) => json_with_etag(bytes, etag, &headers, StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// Set one default. Guarded on the defaults' `ETag`.
async fn put_default(
    State(store): State<Arc<HouseStore>>,
    Path(key): Path<String>,
    headers: HeaderMap,
    axum::Json(value): axum::Json<crate::defaults::ShopDefault>,
) -> Response<Body> {
    let guard = if_match(&headers);
    match store.put_default(&key, value, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// Reset one default to its seed (or remove a key with none). Guarded on the defaults' `ETag`.
async fn reset_default(
    State(store): State<Arc<HouseStore>>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let guard = if_match(&headers);
    match store.reset_default(&key, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(e) => error_response(e),
    }
}

/// The location (#412): id, name and machine records, without the tool tiers. Its `ETag` is the
/// validator a machine write must carry.
async fn get_location(State(store): State<Arc<HouseStore>>, headers: HeaderMap) -> Response<Body> {
    match store.location().await {
        Ok((bytes, etag)) => json_with_etag(bytes, etag, &headers, StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// The user has seen the stale-`house.json` warning and dealt with it (#412 re-review). Recorded
/// against that file's modification time, so only a later change to it raises the warning again.
async fn dismiss_house_warning(State(store): State<Arc<HouseStore>>) -> Response<Body> {
    store.acknowledge_house_warning();
    empty(StatusCode::NO_CONTENT)
}

/// Create or replace one machine record. GUARDED on the location's `ETag` (#321's rule, #412).
async fn put_machine(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    axum::Json(record): axum::Json<MachineRecord>,
) -> Response<Body> {
    if record.id != id {
        return error_response(HouseError::BadEntry(format!(
            "the body's id {} does not match the URL's {id}",
            record.id
        )));
    }
    let guard = if_match(&headers);
    match store.put_machine(record, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// #601 — create or replace one accessory record, the same guarded write shape as `put_machine`.
async fn put_accessory(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    axum::Json(record): axum::Json<FixtureRecord>,
) -> Response<Body> {
    if record.id != id {
        return error_response(HouseError::BadEntry(format!(
            "the body's id {} does not match the URL's {id}",
            record.id
        )));
    }
    let guard = if_match(&headers);
    match store.put_accessory(record, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// #601 — retire one accessory record, guarded as `put_accessory` is.
async fn delete_accessory(
    State(store): State<Arc<HouseStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response<Body> {
    let guard = if_match(&headers);
    match store.delete_accessory(&id, guard.as_deref()).await {
        Ok(()) => empty(StatusCode::OK),
        Err(e) => error_response(e),
    }
}

/// The location document as one file (#412, §3.5): machines, definitions and inventory, never the
/// catalogue. `Content-Disposition` is set so the browser saves rather than renders it — the only
/// endpoint here whose body is a file.
async fn export_house(State(store): State<Arc<HouseStore>>) -> Response<Body> {
    match store.export().await {
        Ok(bytes) => {
            let mut res = json_body(StatusCode::OK, bytes);
            res.headers_mut().insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"location.json\""),
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

    /// The current `ETag` of a list endpoint, read the way the client reads it (#321). Every guarded
    /// request below is built from one of these, because that is the only honest way to write the
    /// header: the validator means "the version I am editing", so a test that invented one would be
    /// testing a request the client cannot produce.
    async fn etag_of(app: &Router, uri: &str) -> String {
        let res = app.clone().oneshot(get(uri)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{uri}");
        res.headers()
            .get(header::ETAG)
            .expect("a list endpoint always carries a validator")
            .to_str()
            .unwrap()
            .to_string()
    }

    fn patch_json(uri: &str, if_match: Option<&str>, body: &impl serde::Serialize) -> Request<Body> {
        let mut builder = Request::builder()
            .method("PATCH")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(tag) = if_match {
            builder = builder.header(header::IF_MATCH, tag);
        }
        builder.body(Body::from(serde_json::to_vec(body).unwrap())).unwrap()
    }

    fn delete(uri: &str, if_match: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().method("DELETE").uri(uri);
        if let Some(tag) = if_match {
            builder = builder.header(header::IF_MATCH, tag);
        }
        builder.body(Body::empty()).unwrap()
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
            // Derived from the id: a code names one cutter (#320), so two items may not share one.
            codes: vec![Coded {
                symbology: "qr_code".to_string(),
                value: format!("C1-BIT-{}", id.to_uppercase()),
            }],
            added_at: "2026-10-08T00:00:00.000Z".to_string(),
            notes: None,
            copies: vec![],
            collet_fits: None,
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
        // #566 — the build this binary IS, straight from the stamp `build.rs` wrote into the crate.
        // The value is whatever git said at compile time (`v1.0.0-…-g…`, possibly `-dirty`), so the
        // test pins the WIRING, not a literal: a reader must be able to tell which commit is installed.
        assert_eq!(body["build"], serde_json::json!(env!("CM_BUILD")));
        assert!(!env!("CM_BUILD").is_empty());
        assert_eq!(body["hasCatalogue"], serde_json::json!(false));
        // A fresh house has no feed rows either, and the two are separate answers: a catalogue
        // synced before the feed tier existed is `hasCatalogue: true, feedRows: 0` (#310).
        assert_eq!(body["feedRows"], serde_json::json!(0));
        assert_eq!(body["problems"], serde_json::json!([]));
        // No sync yet, so nothing to say about one (#328): the key is there and it is null, which
        // is what the client's `lastSync: nullable().default(null)` reads.
        assert!(body["lastSync"].is_null(), "{body}");
        assert!(body.get("lastSync").is_some(), "{body}");
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
        assert_eq!(body["materialSpecRows"], serde_json::json!(0));
        assert_eq!(body["problems"], serde_json::json!([]));
        assert_eq!(
            json_of(app.clone().oneshot(get("/api/v1/feeds")).await.unwrap()).await,
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn the_vendor_stock_sizes_are_served_as_their_own_list_with_a_validator() {
        // #446. `[]` is a normal answer when the library has no sizes or the catalogue predates
        // them, and the list revalidates like the others.
        let (_dir, app) = app_under_test();
        let res = app.clone().oneshot(get("/api/v1/material-specs")).await.unwrap();
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

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/material-specs")
                    .header(header::IF_NONE_MATCH, etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);

        // A catalogue that holds sizes serves them as the plain array the client parses, and
        // `/health` counts them.
        use crate::house::CATALOGUE_FILE;
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(CATALOGUE_FILE),
            br#"{"kind":"casemaker-catalogue","schemaVersion":1,
                 "syncedAt":"2026-10-17T12:00:00.000Z","tools":[],
                 "materialSpecs":[{"id":"spec-1","material":"Hardwood",
                   "name":"Hardwood / 100mm * 200mm * 5mm","shape":"R",
                   "length":200.0,"width":100.0,"height":5.0,"diameter":null,
                   "stockCode":"9990000000000001"}]}"#,
        )
        .unwrap();
        let store = Arc::new(HouseStore::open(dir.path().to_path_buf()));
        let app = routes(store);
        let body = json_of(app.clone().oneshot(get("/api/v1/health")).await.unwrap()).await;
        assert_eq!(body["materialSpecRows"], serde_json::json!(1));
        let rows =
            json_of(app.clone().oneshot(get("/api/v1/material-specs")).await.unwrap()).await;
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["material"], "Hardwood");
        assert_eq!(rows[0]["shape"], "R");
        assert!(rows[0]["diameter"].is_null());
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
        let etag = etag_of(&app, "/api/v1/tools").await;
        let res = app
            .clone()
            .oneshot(patch_json("/api/v1/tools/user:abc", Some(&etag), &edited))
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
            .oneshot(patch_json("/api/v1/tools/user:abc", Some(&etag_of(&app, "/api/v1/tools").await), &mismatched))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        let etag = etag_of(&app, "/api/v1/tools").await;
        let res = app
            .clone()
            .oneshot(delete("/api/v1/tools/user:abc", Some(&etag)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let body = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body, serde_json::json!([]));
    }

    /// The guard as the wire sees it (#321): no `If-Match` is a 428, a validator from a version that
    /// is gone is a 412, and the current one goes through. The point of the whole mechanism is the
    /// middle case — a second window's save meeting the first's must be a visible refusal and not a
    /// silent overwrite, so the status, the body and the UNCHANGED document are all asserted.
    #[tokio::test]
    async fn a_guarded_write_needs_the_version_the_client_read() {
        let (_dir, app) = app_under_test();
        app.clone()
            .oneshot(post_json("/api/v1/tools", &an_entry("user:abc")))
            .await
            .unwrap();
        let edited = ToolLibraryEntry {
            key: "user:abc".to_string(),
            tool: a_tool("re-measured"),
            provenance: "calipers".to_string(),
        };

        // 428: the request said nothing about which version it was based on.
        let res = app
            .clone()
            .oneshot(patch_json("/api/v1/tools/user:abc", None, &edited))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_REQUIRED);
        let body = json_of(res).await;
        assert!(
            body["error"].as_str().unwrap().contains("version"),
            "the refusal has to say what was missing: {body}"
        );
        // An EMPTY header says nothing either (#339): it is the same 428, not a 412 about a version
        // that was never named. Whitespace alone is empty too, since the value is trimmed.
        for blank in ["", "   "] {
            let res = app
                .clone()
                .oneshot(patch_json("/api/v1/tools/user:abc", Some(blank), &edited))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::PRECONDITION_REQUIRED, "If-Match: {blank:?}");
        }
        let res = app
            .clone()
            .oneshot(delete("/api/v1/tools/user:abc", None))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_REQUIRED);

        // Somebody else's write moves the document. The validator in hand is now history.
        let stale = etag_of(&app, "/api/v1/tools").await;
        let other = ToolLibraryEntry {
            key: "user:abc".to_string(),
            tool: a_tool("the other window's edit"),
            provenance: "calipers, other window".to_string(),
        };
        assert_eq!(
            app.clone()
                .oneshot(patch_json("/api/v1/tools/user:abc", Some(&stale), &other))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );

        // 412, and nothing moved: the stale save must not undo the write it never saw.
        let res = app
            .clone()
            .oneshot(patch_json("/api/v1/tools/user:abc", Some(&stale), &edited))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        let body = json_of(res).await;
        assert!(
            body["error"].as_str().unwrap().contains("reload"),
            "the refusal has to say what to do: {body}"
        );
        assert_eq!(
            app.clone()
                .oneshot(delete("/api/v1/tools/user:abc", Some(&stale)))
                .await
                .unwrap()
                .status(),
            StatusCode::PRECONDITION_FAILED
        );
        let body = json_of(app.clone().oneshot(get("/api/v1/tools")).await.unwrap()).await;
        assert_eq!(body[0]["provenance"], serde_json::json!("calipers, other window"));

        // The current validator — the one the client would have read by reloading — goes through.
        let fresh = etag_of(&app, "/api/v1/tools").await;
        assert_ne!(fresh, stale);
        assert_eq!(
            app.clone()
                .oneshot(patch_json("/api/v1/tools/user:abc", Some(&fresh), &edited))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    /// The inventory has its OWN validator (#321): a definition edit must not invalidate a count
    /// edit, and the tool list's `ETag` is not accepted for an inventory write. This is the case that
    /// a single house-wide validator would have got wrong.
    #[tokio::test]
    async fn the_inventory_guards_on_its_own_validator() {
        let (_dir, app) = app_under_test();
        app.clone()
            .oneshot(post_json("/api/v1/inventory", &an_item("inv-1")))
            .await
            .unwrap();
        app.clone()
            .oneshot(post_json("/api/v1/tools", &an_entry("user:abc")))
            .await
            .unwrap();

        let inventory = etag_of(&app, "/api/v1/inventory").await;
        let tools = etag_of(&app, "/api/v1/tools").await;
        assert_ne!(inventory, tools);

        // The tool list's validator is simply the wrong version for the inventory — a stale one.
        let mut more = an_item("inv-1");
        more.quantity = 4;
        assert_eq!(
            app.clone()
                .oneshot(patch_json("/api/v1/inventory/inv-1", Some(&tools), &more))
                .await
                .unwrap()
                .status(),
            StatusCode::PRECONDITION_FAILED
        );
        // And an unrelated tool write leaves the inventory's validator alone, so the count edit still
        // goes through with what it read.
        app.clone()
            .oneshot(post_json("/api/v1/tools", &an_entry("user:def")))
            .await
            .unwrap();
        assert_eq!(
            app.clone()
                .oneshot(patch_json("/api/v1/inventory/inv-1", Some(&inventory), &more))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let body = json_of(app.clone().oneshot(get("/api/v1/inventory")).await.unwrap()).await;
        assert_eq!(body[0]["quantity"], serde_json::json!(4));
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
        assert_eq!(body[0]["codes"][0]["value"], serde_json::json!("C1-BIT-INV-1"));

        let mut more = an_item("inv-1");
        more.quantity = 2;
        let etag = etag_of(&app, "/api/v1/inventory").await;
        assert_eq!(
            app.clone()
                .oneshot(patch_json("/api/v1/inventory/inv-1", Some(&etag), &more))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let body = json_of(app.clone().oneshot(get("/api/v1/inventory")).await.unwrap()).await;
        assert_eq!(body[0]["quantity"], serde_json::json!(2));

        let etag = etag_of(&app, "/api/v1/inventory").await;
        assert_eq!(
            app.clone()
                .oneshot(delete("/api/v1/inventory/inv-1", Some(&etag)))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn the_location_is_read_and_a_machine_written_under_its_validator() {
        // #412. The location's own body carries no tool tiers, and its ETag guards a machine write
        // exactly as the lists' ETags guard theirs (#321).
        let (_dir, app) = app_under_test();
        let view = json_of(app.clone().oneshot(get("/api/v1/location")).await.unwrap()).await;
        assert_eq!(view["kind"], serde_json::json!("casemaker-location"));
        assert!(view.get("tools").is_none(), "{view}");

        let machine = serde_json::json!({
            "id": "machine-1", "profileId": "Z1", "name": null, "serial": null, "firmware": null,
            "address": { "host": "192.0.2.10", "port": 2222 },
            "calibration": null, "fixtures": {}, "margins": null,
            "updatedAt": "2026-10-15T00:00:00.000Z"
        });
        let put = |if_match: Option<&str>, uri: &str, body: &serde_json::Value| {
            let mut b = Request::builder()
                .method("PUT")
                .uri(uri)
                .header(header::CONTENT_TYPE, "application/json");
            if let Some(tag) = if_match {
                b = b.header(header::IF_MATCH, tag);
            }
            b.body(Body::from(serde_json::to_vec(body).unwrap())).unwrap()
        };
        let res = app
            .clone()
            .oneshot(put(None, "/api/v1/location/machines/machine-1", &machine))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_REQUIRED);

        let tag = etag_of(&app, "/api/v1/location").await;
        let res = app
            .clone()
            .oneshot(put(Some(&tag), "/api/v1/location/machines/other", &machine))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "the URL and the body disagree");

        let res = app
            .clone()
            .oneshot(put(Some(&tag), "/api/v1/location/machines/machine-1", &machine))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let view = json_of(app.clone().oneshot(get("/api/v1/location")).await.unwrap()).await;
        assert_eq!(view["machines"][0]["address"]["host"], serde_json::json!("192.0.2.10"));

        let res = app
            .clone()
            .oneshot(put(Some(&tag), "/api/v1/location/machines/machine-1", &machine))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED, "the validator moved");

        // And the export is the location, saved under its own name.
        let res = app.clone().oneshot(get("/api/v1/export")).await.unwrap();
        assert!(res
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap()
            .contains("location.json"));
        let exported = json_of(res).await;
        assert_eq!(exported["machines"][0]["id"], serde_json::json!("machine-1"));
    }

    #[tokio::test]
    async fn a_finished_program_is_appended_over_http_without_a_validator() {
        // #419 §4.5. An APPEND, not a read-modify-write: no `If-Match`, and a repeat is a no-op.
        let (_dir, app) = app_under_test();
        let machine = serde_json::json!({
            "id": "m-1", "profileId": "Z1", "name": null, "serial": null, "firmware": null,
            "address": null, "calibration": null, "fixtures": null, "margins": null,
            "updatedAt": "2026-10-15T00:00:00.000Z"
        });
        let tag = etag_of(&app, "/api/v1/location").await;
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/v1/location/machines/m-1")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::IF_MATCH, tag.as_str())
                    .body(Body::from(serde_json::to_vec(&machine).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let body = serde_json::json!({ "hash": "a1b2c3d4" });
        let res = app.clone().oneshot(post_json("/api/v1/finished-programs/m-1", &body)).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        // A repeat (a retried request, or a second window) is a no-op, not a duplicate.
        let res = app.clone().oneshot(post_json("/api/v1/finished-programs/m-1", &body)).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let view = json_of(app.clone().oneshot(get("/api/v1/location")).await.unwrap()).await;
        assert_eq!(view["machines"][0]["finishedPrograms"], serde_json::json!(["a1b2c3d4"]));

        // A blank hash and a machine that does not exist are refused.
        let res = app
            .clone()
            .oneshot(post_json("/api/v1/finished-programs/m-1", &serde_json::json!({ "hash": " " })))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let res = app
            .clone()
            .oneshot(post_json("/api/v1/finished-programs/nope", &body))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_stock_shelf_walks_its_lifecycle_over_http() {
        // #413. Created unguarded, edited and removed under the shelf's own validator.
        let (_dir, app) = app_under_test();
        let item = serde_json::to_value(crate::stock::tests::a_plate("s-1")).unwrap();
        let res = app.clone().oneshot(post_json("/api/v1/stock", &item)).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let mut sphere = item.clone();
        sphere["id"] = serde_json::json!("s-2");
        sphere["form"] = serde_json::json!("sphere");
        let res = app.clone().oneshot(post_json("/api/v1/stock", &sphere)).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(json_of(res).await["error"].as_str().unwrap().contains("sphere"));

        let mut edited = item.clone();
        edited["quantity"] = serde_json::json!(5);
        let res = app.clone().oneshot(patch_json("/api/v1/stock/s-1", None, &edited)).await.unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_REQUIRED);
        let tag = etag_of(&app, "/api/v1/stock").await;
        let res = app.clone().oneshot(patch_json("/api/v1/stock/s-1", Some(&tag), &edited)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let listed = json_of(app.clone().oneshot(get("/api/v1/stock")).await.unwrap()).await;
        assert_eq!(listed[0]["quantity"], serde_json::json!(5));

        let res = app.clone().oneshot(delete("/api/v1/stock/s-1", Some(&tag))).await.unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED, "the validator moved");
        let tag = etag_of(&app, "/api/v1/stock").await;
        let res = app.clone().oneshot(delete("/api/v1/stock/s-1", Some(&tag))).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn the_feed_table_walks_its_lifecycle_over_http() {
        // #450 slice 2. The same shape as the shelf, on its own path: `/feeds` is the catalogue.
        // #450 slice 3: a fresh location holds the twelve seeded rows, so this row is made on a
        // material and band the seeds do not cover — the test is the lifecycle, not the seed.
        let (_dir, app) = app_under_test();
        let mut row = serde_json::to_value(crate::feeds::tests::a_row("feed-1")).unwrap();
        row["material"] = serde_json::json!("petg");
        let res = app.clone().oneshot(post_json("/api/v1/feed-table", &row)).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        // A row the table cannot use is a 400, in the service's own words.
        let mut bad = row.clone();
        bad["id"] = serde_json::json!("feed-bad");
        bad["params"]["rpm"] = serde_json::json!(0);
        let res = app.clone().oneshot(post_json("/api/v1/feed-table", &bad)).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(json_of(res).await["error"].as_str().unwrap().contains("rpm"));

        // An overlap with the stored row is refused by the WHOLE-TABLE rule.
        let mut overlap = row.clone();
        overlap["id"] = serde_json::json!("feed-overlap");
        overlap["minDiameter"] = serde_json::json!(1.0);
        overlap["maxDiameter"] = serde_json::json!(3.2);
        let res = app.clone().oneshot(post_json("/api/v1/feed-table", &overlap)).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(json_of(res).await["error"].as_str().unwrap().contains("overlap"));

        // Guarded edit: no header 428, a stale one 412, the current one 200. The URL and body ids
        // must agree.
        let mut edited = row.clone();
        edited["params"]["feed"] = serde_json::json!(600);
        let res = app.clone().oneshot(patch_json("/api/v1/feed-table/feed-1", None, &edited)).await.unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_REQUIRED);
        let tag = etag_of(&app, "/api/v1/feed-table").await;
        let res = app
            .clone()
            .oneshot(patch_json("/api/v1/feed-table/other", Some(&tag), &edited))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "the URL and the body disagree");
        let res = app
            .clone()
            .oneshot(patch_json("/api/v1/feed-table/feed-1", Some("\"old\""), &edited))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        let res = app
            .clone()
            .oneshot(patch_json("/api/v1/feed-table/feed-1", Some(&tag), &edited))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let listed = json_of(app.clone().oneshot(get("/api/v1/feed-table")).await.unwrap()).await;
        let stored = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == serde_json::json!("feed-1"))
            .unwrap();
        assert_eq!(stored["params"]["feed"], serde_json::json!(600.0));

        // Delete is guarded too.
        let res = app.clone().oneshot(delete("/api/v1/feed-table/feed-1", Some(&tag))).await.unwrap();
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED, "the validator moved");
        let tag = etag_of(&app, "/api/v1/feed-table").await;
        let res = app.clone().oneshot(delete("/api/v1/feed-table/feed-1", Some(&tag))).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let listed = json_of(app.clone().oneshot(get("/api/v1/feed-table")).await.unwrap()).await;
        let left = listed.as_array().unwrap();
        assert!(!left.iter().any(|r| r["id"] == serde_json::json!("feed-1")), "{listed}");
        assert_eq!(left.len(), 12, "the seeded rows are still there: {listed}");
    }

    #[tokio::test]
    async fn a_power_token_is_saved_only_from_this_computer_and_never_echoed() {
        // #416. The secure store here is the test build's memory one (`house::default_secrets`).
        let (_dir, app) = app_under_test();
        let tag = etag_of(&app, "/api/v1/location").await;
        let machine = serde_json::json!({
            "id": "m-1", "profileId": "Z1", "updatedAt": "2026-10-15T00:00:00.000Z"
        });
        let put = |uri: &str, tag: Option<&str>, body: String| {
            let mut b = Request::builder().method("PUT").uri(uri).header(header::CONTENT_TYPE, "application/json");
            if let Some(t) = tag {
                b = b.header(header::IF_MATCH, t);
            }
            b.body(Body::from(body)).unwrap()
        };
        let res = app.clone().oneshot(put("/api/v1/location/machines/m-1", Some(&tag), machine.to_string())).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let tag = etag_of(&app, "/api/v1/location").await;
        let sw = r#"{"provider":"home-assistant","baseUrl":"http://127.0.0.1:9","entityId":"switch.makera_cnc"}"#;
        let peer = |mut req: Request<Body>, addr: &str| {
            req.extensions_mut()
                .insert(axum::extract::ConnectInfo(addr.parse::<std::net::SocketAddr>().unwrap()));
            req
        };
        // From the LAN: refused — set-up, on and off are this computer's (#416 review).
        let res = app.clone().oneshot(peer(put("/api/v1/power/m-1", Some(&tag), sw.into()), "192.168.10.20:5000")).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = app.clone().oneshot(peer(put("/api/v1/power/m-1", Some(&tag), sw.into()), "127.0.0.1:5000")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        for verb in ["on", "off"] {
            let req = Request::builder().method("POST").uri(format!("/api/v1/power/m-1/{verb}")).body(Body::empty()).unwrap();
            let res = app.clone().oneshot(peer(req, "192.168.10.20:5000")).await.unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{verb} from the LAN");
        }
        let tag = etag_of(&app, "/api/v1/location").await;
        let req = Request::builder().method("DELETE").uri("/api/v1/power/m-1").header(header::IF_MATCH, &tag).body(Body::empty()).unwrap();
        assert_eq!(app.clone().oneshot(peer(req, "10.0.0.9:1")).await.unwrap().status(), StatusCode::FORBIDDEN);

        let with_peer = |addr: &str, body: &str| {
            let mut req = put("/api/v1/power/m-1/token", None, body.into());
            req.extensions_mut()
                .insert(axum::extract::ConnectInfo(addr.parse::<std::net::SocketAddr>().unwrap()));
            req
        };
        let res = app.clone().oneshot(with_peer("192.168.10.20:5000", r#"{"token":"lan-secret"}"#)).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = app.clone().oneshot(with_peer("127.0.0.1:5000", r#"{"tokn":"oops-secret"}"#)).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(!String::from_utf8(bytes_of(res).await).unwrap().contains("oops-secret"), "echoed the body");
        let res = app.clone().oneshot(with_peer("127.0.0.1:5000", r#"{"token":"local-secret"}"#)).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let status = json_of(app.clone().oneshot(get("/api/v1/power/m-1")).await.unwrap()).await;
        assert_eq!(status["hasToken"], serde_json::json!(true));
        assert!(!status.to_string().contains("local-secret"), "{status}");
        // Nothing listens on port 9: the problem is said, without the token.
        assert!(status["problem"].as_str().is_some(), "{status}");
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
        // And what that sync came to, served as-is (#328): the counts and the notes, not the diff
        // lists — a client that connects later reads the same last sync this response carried.
        assert_eq!(body["lastSync"]["total"], serde_json::json!(2), "{body}");
        assert_eq!(body["lastSync"]["feedRows"], serde_json::json!(1), "{body}");
        assert_eq!(body["lastSync"]["notes"], serde_json::json!([]), "{body}");
        assert_eq!(body["lastSync"]["syncedAt"], report["syncedAt"], "{body}");
        assert_eq!(body["lastSync"]["source"], report["source"], "{body}");
        assert!(body["lastSync"].get("added").is_none(), "{body}");

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
        let before_digest = crate::etag::fnv1a_hex(&std::fs::read(&db).unwrap());
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
            crate::etag::fnv1a_hex(&std::fs::read(&db).unwrap()),
            before_digest,
            "the vendor database was modified by a sync"
        );
    }
}
