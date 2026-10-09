// The house service's data and its file (#306, tracking #212).
//
// WHAT THIS IS. The app's embedded axum server (`server.rs`) already serves the web bundle and is
// the process that talks to the Z1. This module is what it now serves on top of that: the house's
// own cutters and inventory, kept as versioned JSON on disk, with the HTTP API as the contract
// rather than the file. `house_api.rs` is the HTTP half; nothing here knows about axum.
//
// WHY JSON AND NOT SQLITE. Scale is 129 catalogue cutters and 1 328 feed rows — a few hundred KB,
// served from memory, needing no index and no join. Every client funnels through this one process,
// so a `tokio::sync::RwLock` plus an atomic temp-write-and-rename gives what is actually required;
// a browser can never open the file, so multi-process safety is unusable anyway. And there is
// exactly ONE shape authority: the client Zod-parses the JSON (`ToolLibrarySchema` already refuses
// duplicate keys), where SQLite would put the shape in Rust DDL, serde and TS Zod at once — with no
// migration runner anywhere in this project. The API is the contract, not the file: if the data
// grows, the same endpoints can be backed by SQLite without the client changing.
//
// TWO DOCUMENTS, because the tiers have different lifetimes. `catalogue.json` is Makera's list,
// replaced wholesale by a sync and never user-owned; `house.json` is the user's own tools and
// inventory, which a sync must never touch. Separate files make that invariant structural rather
// than a promise. `catalogue.rs` is the reader that fills the first one (#308); its type is
// {@link crate::catalogue::CatalogueDoc}, and `HouseStore::sync_catalogue` is what replaces it.
//
// THE BUILTINS ARE NOT IN HERE. `TOOL_LIBRARY` (`engine/cnc/toolLibrary.ts`) is the client's
// permanent `builtin` tier (#305) and the client merges it, so `GET /api/v1/tools` carries only the
// tiers ABOVE it: `cat:` and `user:`. Serving the builtins would list them twice in every picker.
//
// A KEY THIS SERVICE STORES MUST BE NAMESPACED (it must contain `:`) AND MUST NOT CONTAIN `|`. The
// namespace is what keeps `flat-1.0` — a key no user tier may claim — out of the house file, and
// the pipe is what `;@CM|TOOL|key=…` cannot carry (#305 design point 3, `/Fabrication.md` §2). Both
// are refused at the door rather than sanitised, so a bad key is a visible 4xx and not a silent
// rename. `cat:` is refused too: that namespace belongs to a sync, which replaces it wholesale.
//
// A FILE THAT DOES NOT PARSE IS PRESERVED, NEVER OVERWRITTEN. If `house.json` exists but cannot be
// read, the store serves an empty house with the reason in `GET /api/v1/health` and refuses every
// write until the file is dealt with by hand. The alternative — start empty, then save over it —
// destroys the user's own tool list to recover from a truncated write, which is not a recovery.
// **The catalogue is the exception, and deliberately so** (#308): it holds vendor rows whose only
// copy is Makera's database, so a sync REPLACES an unreadable `catalogue.json` and says in its
// report that it did. Refusing would make a corrupt file a permanent block on the one operation
// that can heal it, and there is no user data in there to lose.

// NO VENDOR DATA IS EVER COMMITTED OR EXPORTED. `catalogue.json` lives on the user's machine, read
// from their own install (#308); the export endpoint emits the HOUSE document only, so a "my
// machine" file carried between two computers (#247) can never smuggle Makera's table with it
// (`/Fabrication.md` §3, #186).

use crate::catalogue::{CatalogueDoc, SyncReport, CATALOGUE_KIND};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::sync::RwLock;

/// Magic string that says "this is a Case Maker house file", not some other JSON. Same discipline
/// as `store/myMachineFile.ts`: an import refuses a document whose kind or version it does not know.
pub const HOUSE_KIND: &str = "casemaker-house";
/// Bump when either document's shape changes incompatibly; loading refuses unknown versions.
pub const HOUSE_SCHEMA_VERSION: u32 = 1;
pub const HOUSE_FILE: &str = "house.json";
pub const CATALOGUE_FILE: &str = "catalogue.json";

/// `dirs::data_dir()/casemaker` — where the house lives.
///
/// NOT `config_dir()`, and the distinction is a real one on Linux (`~/.local/share` vs `~/.config`):
/// the config is this machine's wiring — its port, its bind address — and means nothing on another
/// computer, while the house is user data that is *meant* to move between them (#247). On Windows
/// both resolve under Roaming AppData, so there the two documents simply sit beside `config.json`:
/// different files, one folder, harmless. `config_dir` is the fallback for a platform with no data
/// dir at all and the temp dir after that, so the service always has somewhere to write.
pub fn house_dir() -> PathBuf {
    dirs::data_dir()
        .or_else(dirs::config_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(crate::config::APP_DIR_NAME)
}

/// Studio's `type=` vocabulary, from the binary's string table (`/Makera-Parity.md` §12) — the
/// same nine the TS `ToolShape` carries. An enum here, not a `String`, so a row with a shape nobody
/// knows is refused at the API boundary instead of reaching a picker that cannot render it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolShape {
    Flat,
    Ball,
    TaperedBall,
    Engraving,
    Chamfer,
    Drill,
    Thread,
    Bull,
    Unknown,
}

impl Default for ToolShape {
    fn default() -> Self {
        ToolShape::Unknown
    }
}

/// One cutter's geometry — the CAM/sweep view, and deliberately NOT Makera's full 26-field record
/// (#212 "do not widen `Tool`"). The extra catalogue columns (`pitch`, `threadAngle`,
/// `drillDiameter`, `matelDuty`, …) belong in a separate extras record when something reads them.
///
/// Every field is `Option` except the identity ones, and **every field is serialized even when it
/// is `null`**: the client's `ToolSchema` is `.nullable()`, not `.optional()`, so an omitted key
/// would fail the parse where an explicit `null` is the honest "not stated by the source".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub number: Option<i64>,
    pub id: Option<String>,
    pub name: String,
    /// The `type=` string exactly as written, for diagnostics.
    #[serde(default)]
    pub type_text: String,
    #[serde(default)]
    pub shape: ToolShape,
    pub handle_diameter: Option<f64>,
    pub tip_diameter: Option<f64>,
    pub diameter: Option<f64>,
    pub corner_radius: Option<f64>,
    pub angle: Option<f64>,
    pub half_angle: Option<f64>,
    pub flute_length: Option<f64>,
    pub shoulder_length: Option<f64>,
    pub stickout: Option<f64>,
    /// Can this cutter plunge straight down without a pilot hole? Only a centre-cutting end mill
    /// can, and neither the `.nc` header nor Makera's catalogue states it (#220), so a `null` here
    /// is "unknown" and makes a drilling job raise `plunge-unproven`.
    pub centre_cutting: Option<bool>,
}

impl Tool {
    /// Refuse a tool that cannot be served: an empty name fails `ToolSchema`'s `min(1)`, and a
    /// non-finite number has no JSON representation at all — `serde_json` would fail mid-response
    /// rather than at the door, which is the wrong place to find out. `pub(crate)` because the
    /// catalogue import (`catalogue.rs`) builds a `Tool` from a vendor row and must be held to the
    /// same rule as a hand-typed one.
    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        if self.name.trim().is_empty() {
            return Err(HouseError::BadEntry("the tool has no name".into()));
        }
        let numbers = [
            self.handle_diameter,
            self.tip_diameter,
            self.diameter,
            self.corner_radius,
            self.angle,
            self.half_angle,
            self.flute_length,
            self.shoulder_length,
            self.stickout,
        ];
        if let Some(v) = numbers.iter().flatten().find(|v| !v.is_finite()) {
            return Err(HouseError::BadEntry(format!("{v} is not a number a machine can use")));
        }
        Ok(())
    }
}

/// Where a definition came from (#212). `None` is the user's own, typed by hand; `Some` is the
/// catalogue row this was materialised from, with the date it was taken — so a later re-sync (#308)
/// can name what a clone was made from without ever reaching into the clone itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// The catalogue row's `cutterId` (`/Makera-Parity.md` §3.2), NOT the `g_ID` the `.nc` header
    /// carries: the UUID is what a re-sync diffs on, and the `g_ID` is not inherited by a clone.
    pub id: String,
    #[serde(default)]
    pub synced_at: Option<String>,
}

/// A cutter the user's house owns, as stored. The wire shape is {@link ToolLibraryEntry}: `origin`
/// stays on disk because the client's Zod schema does not carry it yet, and `provenance` — the
/// human sentence the panel shows — already says what it was cloned from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTool {
    pub key: String,
    pub tool: Tool,
    /// One sentence for the panel (#311): "your own", "cloned from Makera catalogue … on …".
    pub provenance: String,
    #[serde(default)]
    pub origin: Option<Origin>,
}

/// The ONE shape the workers need (#212, #306): what a key resolves to, and where it came from.
/// This is the shape `GET /api/v1/tools` emits and the only one the client parses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLibraryEntry {
    pub key: String,
    pub tool: Tool,
    pub provenance: String,
}

impl ToolLibraryEntry {
    fn validate(&self) -> Result<(), HouseError> {
        validate_key(&self.key)?;
        self.tool.validate()?;
        if self.provenance.trim().is_empty() {
            return Err(HouseError::BadEntry(
                "the entry says nothing about where its numbers came from".into(),
            ));
        }
        Ok(())
    }
}

impl From<&UserTool> for ToolLibraryEntry {
    fn from(t: &UserTool) -> Self {
        ToolLibraryEntry {
            key: t.key.clone(),
            tool: t.tool.clone(),
            provenance: t.provenance.clone(),
        }
    }
}

/// A catalogue row is served to the client as the same shape as every other tier: the `extras` and
/// the `contentHash` are the sync's bookkeeping and do not go on the wire, where the client's
/// `ToolLibraryEntrySchema` is the only thing that reads.
impl From<&crate::catalogue::CatalogueEntry> for ToolLibraryEntry {
    fn from(e: &crate::catalogue::CatalogueEntry) -> Self {
        ToolLibraryEntry {
            key: e.key.clone(),
            tool: e.tool.clone(),
            provenance: e.provenance.clone(),
        }
    }
}

/// A code printed on a cutter or its packaging (#309): the symbology the scanner named, and the
/// text it decoded to. `symbology` is kept because the same value can arrive as a QR slug
/// (`C1-BIT-BALL-NOSE-1-4`) or as typed text, and only the first is evidence of a label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coded {
    pub symbology: String,
    pub value: String,
}

/// A physical cutter the user owns (#212, #309): the materialised `Tool` snapshot, how many there
/// are, and the codes that identify it.
///
/// The `tool` is MATERIALISED and not a reference to a catalogue row on purpose — possession must
/// not depend on the catalogue surviving a re-sync. A user who cloned a row and then synced a
/// catalogue that dropped it still physically owns the cutter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    /// Ours, minted by the client (`utils/id.ts`). The same code registered twice must not create
    /// two items (#309's invariant), so the *codes* are checked at the door, not this id.
    pub id: String,
    pub tool: Tool,
    #[serde(default)]
    pub origin: Option<Origin>,
    pub quantity: u32,
    #[serde(default)]
    pub codes: Vec<Coded>,
    /// ISO timestamp. The client's clock: this is a record of when the user registered it.
    pub added_at: String,
    #[serde(default)]
    pub notes: Option<String>,
}

impl InventoryItem {
    fn validate(&self) -> Result<(), HouseError> {
        if self.id.trim().is_empty() {
            return Err(HouseError::BadEntry("the item has no id".into()));
        }
        if self.quantity == 0 {
            return Err(HouseError::BadEntry(
                "quantity 0 is not a possession — remove the item instead".into(),
            ));
        }
        self.tool.validate()
    }
}

/// `house.json` — the user's own tiers. A sync (#308) never touches this file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HouseDoc {
    pub kind: String,
    pub schema_version: u32,
    #[serde(default)]
    pub tools: Vec<UserTool>,
    #[serde(default)]
    pub inventory: Vec<InventoryItem>,
}

impl Default for HouseDoc {
    fn default() -> Self {
        HouseDoc {
            kind: HOUSE_KIND.to_string(),
            schema_version: HOUSE_SCHEMA_VERSION,
            tools: Vec::new(),
            inventory: Vec::new(),
        }
    }
}

/// What `GET /api/v1/health` answers (#306's shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub schema_version: u32,
    pub has_catalogue: bool,
    /// How many feed rows the stored catalogue holds (#310). A catalogue synced before the feed tier
    /// existed reports `has_catalogue: true` with `feedRows: 0`, which is exactly the state a re-sync
    /// fixes — so the two numbers answer different questions and a client shows both.
    pub feed_rows: usize,
    pub catalogue_synced_at: Option<String>,
    /// One sentence per document that could not be read. A non-empty list is also why writes are
    /// refused: the store will not overwrite a file it could not understand.
    pub problems: Vec<String>,
}

/// Everything the API can refuse, and why. Mapped to HTTP status codes in `house_api.rs`.
#[derive(Debug, Clone, PartialEq)]
pub enum HouseError {
    /// The key is not one this service may store (un-namespaced, `cat:`, or containing `|`).
    BadKey(String),
    /// The entry itself cannot be served (no name, no provenance, a non-finite number).
    BadEntry(String),
    /// A create against a key that already exists, or a delete of one that does not.
    Conflict(String),
    NotFound(String),
    /// The document on disk could not be read, so writing would destroy it.
    Refused(String),
    Io(String),
}

impl std::fmt::Display for HouseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HouseError::BadKey(m)
            | HouseError::BadEntry(m)
            | HouseError::Conflict(m)
            | HouseError::NotFound(m)
            | HouseError::Refused(m)
            | HouseError::Io(m) => write!(f, "{m}"),
        }
    }
}

/// The key rule, in one place. See the module doc for why each clause exists.
fn validate_key(key: &str) -> Result<(), HouseError> {
    if key.trim().is_empty() {
        return Err(HouseError::BadKey("the key is empty".into()));
    }
    if key.contains('|') {
        return Err(HouseError::BadKey(format!(
            "{key} contains a pipe, which the .nc header's tool line cannot carry"
        )));
    }
    if !key.contains(':') {
        return Err(HouseError::BadKey(format!(
            "{key} is not namespaced: a key this service stores must be `cat:…` or `user:…`, so it \
             can never collide with a built-in like `flat-1.0`"
        )));
    }
    if key.starts_with("cat:") {
        return Err(HouseError::BadKey(format!(
            "{key} is in the catalogue's namespace, which a sync owns"
        )));
    }
    Ok(())
}

/// FNV-1a, 64-bit: a content validator, not a security hash. Written here rather than pulled in as a
/// dependency because the only requirement is "the same bytes give the same string", and an
/// `ETag` that changed without the bytes changing would only cost a 200 where a 304 was possible.
/// `pub(crate)` because the catalogue import (#308) uses the same function for its `contentHash`:
/// one hash in this crate, so "the same bytes" means the same thing wherever it is asked.
pub(crate) fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The HTTP `ETag` for a body: quoted, and derived from the exact bytes that were hashed, so the
/// validator and the representation cannot disagree.
fn etag_for(bytes: &[u8]) -> String {
    format!("\"fnv1a-{}\"", fnv1a_hex(bytes))
}

fn json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, HouseError> {
    serde_json::to_vec(value).map_err(|e| HouseError::Io(format!("could not serialize: {e}")))
}

/// Write `bytes` to `path` atomically: a named sibling temp file, flushed to disk, then renamed over
/// the target. A crash mid-write leaves the temp file behind rather than a half-written document.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), HouseError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, &e))?;
    }
    let mut tmp_os = path.as_os_str().to_os_string();
    tmp_os.push(".tmp");
    let tmp = PathBuf::from(tmp_os);
    {
        let mut f = fs::File::create(&tmp).map_err(|e| io_err(&tmp, &e))?;
        f.write_all(bytes).map_err(|e| io_err(&tmp, &e))?;
        f.sync_all().map_err(|e| io_err(&tmp, &e))?;
    }
    // `std::fs::rename` replaces an existing destination on every platform this ships on (on
    // Windows it is `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), which is what makes this atomic
    // rather than "atomic, except the first time".
    fs::rename(&tmp, path).map_err(|e| io_err(path, &e))
}

fn io_err(path: &Path, e: &std::io::Error) -> HouseError {
    HouseError::Io(format!("{}: {e}", path.display()))
}

/// Read a document, or `Ok(None)` when the file is simply not there yet.
///
/// A file that exists but does not parse is an `Err` with a sentence naming it, never a silent
/// default: the caller keeps that sentence and refuses to write over the file.
fn read_doc<T: for<'de> Deserialize<'de>>(path: &Path, kind: &str) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("{} is not readable JSON: {e}", path.display()))?;
    let file_kind = value.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if file_kind != kind {
        return Err(format!(
            "{} says it is {:?}; this file must be {kind:?}",
            path.display(),
            file_kind
        ));
    }
    let version = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if version != u64::from(HOUSE_SCHEMA_VERSION) {
        return Err(format!(
            "{} is version {version}; this build reads version {HOUSE_SCHEMA_VERSION}",
            path.display()
        ));
    }
    let doc: T = serde_json::from_value(value)
        .map_err(|e| format!("{} does not match its own schema: {e}", path.display()))?;
    Ok(Some(doc))
}

struct Inner {
    house: HouseDoc,
    catalogue: CatalogueDoc,
    /// Why `house.json` could not be read, if it could not. Non-empty ⇒ every write is refused.
    house_problem: Option<String>,
    catalogue_problem: Option<String>,
}

/// The house's data, in memory and on disk. One per process, held in the router's state.
pub struct HouseStore {
    dir: PathBuf,
    /// Where Makera Studio's library is expected to be. Held here rather than resolved per request
    /// so that a sync reads a path the process decided on, not one a caller supplied: the endpoint
    /// takes no arguments, and this is the seam a test points at a fixture (#308).
    studio_db: Option<PathBuf>,
    inner: RwLock<Inner>,
}

impl HouseStore {
    /// Open the store over `dir`, loading whatever is already there.
    ///
    /// Never fails: a missing directory is a house with no tools yet, which is the first run, and a
    /// file that cannot be read becomes a `problem` reported by `/api/v1/health` rather than a
    /// refusal to start. Refusing to start would take the whole app with it — this is the same
    /// process that serves the UI.
    pub fn open(dir: PathBuf) -> HouseStore {
        Self::open_with(dir, crate::catalogue::studio_db_path())
    }

    /// The same, with the vendor database named explicitly — `None` for a platform with no data
    /// directory to look in, and a fixture path in tests.
    pub fn open_with(dir: PathBuf, studio_db: Option<PathBuf>) -> HouseStore {
        let (house, house_problem) = match read_doc::<HouseDoc>(&dir.join(HOUSE_FILE), HOUSE_KIND) {
            Ok(Some(doc)) => (doc, None),
            Ok(None) => (HouseDoc::default(), None),
            Err(e) => {
                log::warn!("house service: {e}");
                (HouseDoc::default(), Some(e))
            }
        };
        let (catalogue, catalogue_problem) =
            match read_doc::<CatalogueDoc>(&dir.join(CATALOGUE_FILE), CATALOGUE_KIND) {
                Ok(Some(doc)) => (doc, None),
                Ok(None) => (CatalogueDoc::default(), None),
                Err(e) => {
                    log::warn!("house service: {e}");
                    (CatalogueDoc::default(), Some(e))
                }
            };
        HouseStore {
            dir,
            studio_db,
            inner: RwLock::new(Inner {
                house,
                catalogue,
                house_problem,
                catalogue_problem,
            }),
        }
    }

    pub async fn health(&self) -> Health {
        let inner = self.inner.read().await;
        Health {
            ok: true,
            schema_version: HOUSE_SCHEMA_VERSION,
            has_catalogue: !inner.catalogue.tools.is_empty(),
            feed_rows: inner.catalogue.feeds.len(),
            catalogue_synced_at: inner.catalogue.synced_at.clone(),
            problems: [&inner.house_problem, &inner.catalogue_problem]
                .iter()
                .filter_map(|p| (*p).clone())
                .collect(),
        }
    }

    /// The list the client pushes into its registry (#305's `setRegistry`), with the `ETag` of the
    /// EXACT bytes returned — the catalogue tier first, then the user's own, since a user's tool is
    /// the one they went out of their way to define.
    pub async fn tools(&self) -> Result<(Vec<u8>, String), HouseError> {
        let inner = self.inner.read().await;
        let mut entries: Vec<ToolLibraryEntry> =
            inner.catalogue.tools.iter().map(ToolLibraryEntry::from).collect();
        entries.extend(inner.house.tools.iter().map(ToolLibraryEntry::from));
        let bytes = json_bytes(&entries)?;
        let etag = etag_for(&bytes);
        Ok((bytes, etag))
    }

    /// Makera's feed matrix (#310), with its `ETag`. A plain array of the vendor's rows, exactly as
    /// the sync read them (`catalogue.rs`): a SECOND document rather than a field on `/tools`,
    /// because it is 1 328 rows against the cutters' 129 and a client that wants only the cutters
    /// should not parse it. An empty array is a catalogue with no starting numbers — a normal answer.
    pub async fn feeds(&self) -> Result<(Vec<u8>, String), HouseError> {
        let inner = self.inner.read().await;
        let bytes = json_bytes(&inner.catalogue.feeds)?;
        let etag = etag_for(&bytes);
        Ok((bytes, etag))
    }

    /// The inventory, with its `ETag`. Ordered by `added_at` so the list a UI renders does not
    /// reshuffle when a write lands somewhere in the middle of the file.
    pub async fn inventory(&self) -> Result<(Vec<u8>, String), HouseError> {
        let inner = self.inner.read().await;
        let mut items = inner.house.inventory.clone();
        items.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.id.cmp(&b.id)));
        let bytes = json_bytes(&items)?;
        let etag = etag_for(&bytes);
        Ok((bytes, etag))
    }

    /// Create a user tool. Refuses a key that already exists — the same discipline #309 needs for a
    /// scanned code, and the reason POST and PATCH are separate at the API rather than one upsert.
    pub async fn create_tool(&self, entry: ToolLibraryEntry) -> Result<(), HouseError> {
        entry.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        if inner.house.tools.iter().any(|t| t.key == entry.key) {
            return Err(HouseError::Conflict(format!(
                "{} is already in the house",
                entry.key
            )));
        }
        let mut next = inner.house.clone();
        next.tools.push(UserTool {
            key: entry.key,
            tool: entry.tool,
            provenance: entry.provenance,
            origin: None,
        });
        self.commit(&mut inner, next)
    }

    /// Replace an existing user tool's definition. `origin` and the key are kept: a clone does not
    /// become a different tool because its geometry was edited, and a re-clone is a new key.
    pub async fn update_tool(&self, entry: ToolLibraryEntry) -> Result<(), HouseError> {
        entry.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        let mut next = inner.house.clone();
        let Some(existing) = next.tools.iter_mut().find(|t| t.key == entry.key) else {
            return Err(HouseError::NotFound(format!(
                "{} is not in the house",
                entry.key
            )));
        };
        existing.tool = entry.tool;
        existing.provenance = entry.provenance;
        self.commit(&mut inner, next)
    }

    pub async fn delete_tool(&self, key: &str) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        let mut next = inner.house.clone();
        let before = next.tools.len();
        next.tools.retain(|t| t.key != key);
        if next.tools.len() == before {
            return Err(HouseError::NotFound(format!("{key} is not in the house")));
        }
        self.commit(&mut inner, next)
    }

    /// Register a cutter. Refuses an id that is already registered; the caller (`onCode`, #309) is
    /// what turns a repeat scan into "quantity + 1" rather than a second item.
    pub async fn create_inventory(&self, item: InventoryItem) -> Result<(), HouseError> {
        item.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        if inner.house.inventory.iter().any(|i| i.id == item.id) {
            return Err(HouseError::Conflict(format!(
                "{} is already registered",
                item.id
            )));
        }
        let mut next = inner.house.clone();
        next.inventory.push(item);
        self.commit(&mut inner, next)
    }

    pub async fn update_inventory(&self, item: InventoryItem) -> Result<(), HouseError> {
        item.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        let mut next = inner.house.clone();
        let Some(existing) = next.inventory.iter_mut().find(|i| i.id == item.id) else {
            return Err(HouseError::NotFound(format!(
                "{} is not registered",
                item.id
            )));
        };
        *existing = item;
        self.commit(&mut inner, next)
    }

    pub async fn delete_inventory(&self, id: &str) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        let mut next = inner.house.clone();
        let before = next.inventory.len();
        next.inventory.retain(|i| i.id != id);
        if next.inventory.len() == before {
            return Err(HouseError::NotFound(format!("{id} is not registered")));
        }
        self.commit(&mut inner, next)
    }

    /// The house document, pretty-printed: what a "my machine" file carries (#247). The catalogue is
    /// NOT in here and cannot be — #212's rule that nothing vendor-derived leaves the machine.
    pub async fn export(&self) -> Result<Vec<u8>, HouseError> {
        let inner = self.inner.read().await;
        serde_json::to_vec_pretty(&inner.house)
            .map_err(|e| HouseError::Io(format!("could not serialize the house: {e}")))
    }

    /// Import Makera's catalogue from Studio's own library, replacing the `cat:` tier wholesale
    /// (#308).
    ///
    /// THE USER'S HOUSE IS NOT TOUCHED. `house.json` is a different file, read and written by other
    /// methods only, so "a re-sync leaves every `user_tool` and `inventory_item` byte-identical" is
    /// structural rather than a promise — and a clone that was materialised out of a catalogue row
    /// survives that row being dropped, because the clone holds its own `Tool` (#212).
    ///
    /// WHAT IT REFUSES. A vendor file that is not there, a row that cannot be served, and an import
    /// that is EMPTY while the stored catalogue has rows: Makera publishes 129 cutters, so an empty
    /// read is a read that went wrong, and replacing a good list with it is the one way this
    /// operation can lose something. A sync that changes nothing is not a failure: it writes the
    /// same rows with a fresh `syncedAt` and reports no additions, removals or changes.
    pub async fn sync_catalogue(&self) -> Result<SyncReport, HouseError> {
        let Some(path) = self.studio_db.clone() else {
            return Err(HouseError::NotFound(
                "this platform has no data directory, so Makera Studio's library cannot be \
                 located"
                    .into(),
            ));
        };
        // The database is read OUTSIDE the lock, and on a blocking thread: `rusqlite` is a
        // synchronous library and a 14 MB copy is not something to hold a `RwLock` across. The read
        // is the slow part and it needs nothing from the store.
        let source = path.clone();
        let imported = tokio::task::spawn_blocking(move || crate::catalogue::read_all(&source))
            .await
            .map_err(|e| HouseError::Io(format!("the catalogue read did not finish: {e}")))?
            .map_err(|e| match e.contains("is not there") {
                true => HouseError::NotFound(e),
                false => HouseError::Refused(e),
            })?;

        let mut inner = self.inner.write().await;
        if imported.entries.is_empty() && !inner.catalogue.tools.is_empty() {
            return Err(HouseError::Refused(format!(
                "{}: no cutters were found in it, and the catalogue already holds rows — refusing \
                 to replace a good list with an empty one",
                path.display()
            )));
        }
        // Everything is checked before anything is written: a sync either replaces the tier whole
        // or leaves it exactly as it was.
        for entry in &imported.entries {
            entry
                .validate()
                .map_err(|e| HouseError::BadEntry(format!("{}: {e}", path.display())))?;
        }

        let change = crate::catalogue::diff(&inner.catalogue.tools, &imported.entries);
        let synced_at = crate::catalogue::now_iso();
        let mut notes = imported.notes;
        if let Some(problem) = inner.catalogue_problem.take() {
            notes.push(format!(
                "the previous catalogue file could not be read ({problem}) — this sync replaced it"
            ));
        }

        let doc = CatalogueDoc {
            synced_at: Some(synced_at.clone()),
            tools: imported.entries,
            feeds: imported.feeds,
            ..CatalogueDoc::default()
        };
        let bytes = serde_json::to_vec_pretty(&doc)
            .map_err(|e| HouseError::Io(format!("could not serialize the catalogue: {e}")))?;
        write_atomic(&self.dir.join(CATALOGUE_FILE), &bytes)?;

        let report = SyncReport {
            source: path.display().to_string(),
            synced_at: Some(synced_at),
            total: doc.tools.len(),
            unchanged: change.unchanged,
            added: change.added,
            removed: change.removed,
            changed: change.changed,
            feed_rows: doc.feeds.len(),
            notes,
        };
        inner.catalogue = doc;
        inner.catalogue_problem = None;
        Ok(report)
    }

    /// Replace the house from an exported document. WHOLE-OR-NOTHING (decision 28): the document is
    /// parsed and version-checked before anything is touched, so a truncated or foreign file is
    /// refused with a reason and the store is left exactly as it was.
    pub async fn import(&self, bytes: &[u8]) -> Result<(), HouseError> {
        let doc: HouseDoc = serde_json::from_slice(bytes)
            .map_err(|e| HouseError::BadEntry(format!("not a Case Maker house file: {e}")))?;
        if doc.kind != HOUSE_KIND {
            return Err(HouseError::BadEntry(format!(
                "this is a {} document, not a house file",
                if doc.kind.is_empty() { "unrecognised" } else { &doc.kind }
            )));
        }
        if doc.schema_version != HOUSE_SCHEMA_VERSION {
            return Err(HouseError::BadEntry(format!(
                "the file is version {}; this build reads version {HOUSE_SCHEMA_VERSION}",
                doc.schema_version
            )));
        }
        for t in &doc.tools {
            validate_key(&t.key)?;
            t.tool.validate()?;
        }
        for i in &doc.inventory {
            i.validate()?;
        }
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        self.commit(&mut inner, doc)
    }

    /// Refuse to write over a document that could not be read.
    fn writable(problem: &Option<String>) -> Result<(), HouseError> {
        match problem {
            Some(p) => Err(HouseError::Refused(format!(
                "{p} — move that file aside (or fix it) and restart the service; nothing here will \
                 overwrite it"
            ))),
            None => Ok(()),
        }
    }

    /// Persist a candidate document, then adopt it in memory. Disk first, so a write that fails
    /// leaves the in-memory house matching the file rather than ahead of it.
    fn commit(&self, inner: &mut Inner, next: HouseDoc) -> Result<(), HouseError> {
        let bytes = serde_json::to_vec_pretty(&next)
            .map_err(|e| HouseError::Io(format!("could not serialize the house: {e}")))?;
        write_atomic(&self.dir.join(HOUSE_FILE), &bytes)?;
        inner.house = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn a_tool(name: &str) -> Tool {
        Tool {
            name: name.to_string(),
            type_text: "Flat End".to_string(),
            shape: ToolShape::Flat,
            diameter: Some(2.0),
            tip_diameter: Some(2.0),
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

    fn store() -> (TempDir, HouseStore) {
        let dir = TempDir::new().unwrap();
        let store = HouseStore::open(dir.path().to_path_buf());
        (dir, store)
    }

    /// A cutter row as a sync would leave it (#308). `catalogue.rs` is what turns a vendor row into
    /// one of these; built by hand here on purpose, because the store must not care where a tier's
    /// rows came from — only that they are shaped like the ones it serves.
    fn a_catalogue_entry(cutter_id: &str) -> crate::catalogue::CatalogueEntry {
        crate::catalogue::CatalogueEntry {
            key: format!("cat:{cutter_id}"),
            tool: a_tool("3.175*12mm Flat End(Metal)"),
            provenance: "Makera catalogue 112111313812".to_string(),
            content_hash: "0f0f0f0f0f0f0f0f".to_string(),
            extras: crate::catalogue::CatalogueExtras {
                cutter_id: cutter_id.to_string(),
                category_id: 1,
                category_name: "Flat End".to_string(),
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn a_fresh_house_is_empty_and_healthy() {
        let (_dir, store) = store();
        let h = store.health().await;
        assert!(h.ok);
        assert_eq!(h.schema_version, HOUSE_SCHEMA_VERSION);
        assert!(!h.has_catalogue);
        assert!(h.catalogue_synced_at.is_none());
        assert!(h.problems.is_empty());
        let (bytes, _) = store.tools().await.unwrap();
        assert_eq!(bytes, b"[]");
    }

    #[tokio::test]
    async fn a_tool_round_trips_through_the_file() {
        let (dir, store) = store();
        store.create_tool(an_entry("user:abc")).await.unwrap();
        // A new store over the same directory sees it, which is the whole point of the file.
        let reopened = HouseStore::open(dir.path().to_path_buf());
        let (bytes, etag) = reopened.tools().await.unwrap();
        let entries: Vec<ToolLibraryEntry> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "user:abc");
        assert_eq!(entries[0].tool.name, "2 mm flat end");
        assert_eq!(etag, etag_for(&bytes));
    }

    #[tokio::test]
    async fn every_tool_field_is_written_even_when_unknown() {
        // The client's `ToolSchema` is `.nullable()`, not `.optional()`: an omitted key fails its
        // parse, so a null must be an explicit null on the wire.
        let (_dir, store) = store();
        store.create_tool(an_entry("user:abc")).await.unwrap();
        let (bytes, _) = store.tools().await.unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let tool = raw[0]["tool"].as_object().unwrap();
        for field in [
            "number",
            "id",
            "name",
            "typeText",
            "shape",
            "handleDiameter",
            "tipDiameter",
            "diameter",
            "cornerRadius",
            "angle",
            "halfAngle",
            "fluteLength",
            "shoulderLength",
            "stickout",
            "centreCutting",
        ] {
            assert!(tool.contains_key(field), "{field} is missing from the wire shape");
        }
        assert!(tool["stickout"].is_null());
        assert!(tool["centreCutting"].is_null());
    }

    #[tokio::test]
    async fn the_etag_tracks_the_content_and_nothing_else() {
        let (_dir, store) = store();
        let (first, etag_a) = store.tools().await.unwrap();
        let (again, etag_b) = store.tools().await.unwrap();
        assert_eq!(etag_a, etag_b, "the same content must keep its validator");
        assert_eq!(first, again);

        store.create_tool(an_entry("user:abc")).await.unwrap();
        let (_, etag_c) = store.tools().await.unwrap();
        assert_ne!(etag_a, etag_c, "a changed list must invalidate the validator");

        // A write that lands the same content keeps the same validator: the etag is over the bytes,
        // not over a revision counter, so a client is never made to re-download an unchanged list.
        store.update_tool(an_entry("user:abc")).await.unwrap();
        let (_, etag_d) = store.tools().await.unwrap();
        assert_eq!(etag_c, etag_d);
    }

    #[tokio::test]
    async fn the_catalogue_is_served_before_the_users_own() {
        let dir = TempDir::new().unwrap();
        // Written by hand here: `HouseStore::sync_catalogue` is what writes it in anger (#308).
        let catalogue = CatalogueDoc {
            synced_at: Some("2026-10-08T12:00:00.000Z".to_string()),
            tools: vec![a_catalogue_entry("019c049a-8169-7a1e-ace2-28e03809ce44")],
            ..CatalogueDoc::default()
        };
        fs::write(
            dir.path().join(CATALOGUE_FILE),
            serde_json::to_vec_pretty(&catalogue).unwrap(),
        )
        .unwrap();

        let store = HouseStore::open(dir.path().to_path_buf());
        store.create_tool(an_entry("user:abc")).await.unwrap();
        let (bytes, _) = store.tools().await.unwrap();
        let entries: Vec<ToolLibraryEntry> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
            vec!["cat:019c049a-8169-7a1e-ace2-28e03809ce44", "user:abc"]
        );
        // The extras and the hash stay on disk: the wire shape is the client's schema, and the
        // sync's bookkeeping is nobody else's business.
        let raw: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(raw[0].get("extras").is_none(), "{raw}");
        assert!(raw[0].get("contentHash").is_none(), "{raw}");
        let h = store.health().await;
        assert!(h.has_catalogue);
        assert_eq!(h.catalogue_synced_at.as_deref(), Some("2026-10-08T12:00:00.000Z"));
    }

    #[tokio::test]
    async fn a_key_the_service_may_not_store_is_refused() {
        let (_dir, store) = store();
        for (key, why) in [
            ("flat-1.0", "a built-in has no namespace"),
            ("", "an empty key"),
            ("user:a|b", "a pipe cannot survive a .nc header"),
            ("cat:112111313812", "the catalogue's namespace belongs to a sync"),
        ] {
            let err = store.create_tool(an_entry(key)).await.unwrap_err();
            match err {
                HouseError::BadKey(m) => assert!(!m.is_empty(), "{why}: a refusal must say why"),
                other => panic!("{key} ({why}) was refused as {other:?}"),
            }
        }
        // And nothing was written for any of them.
        let (bytes, _) = store.tools().await.unwrap();
        assert_eq!(bytes, b"[]");
    }

    #[tokio::test]
    async fn create_refuses_a_duplicate_and_update_refuses_a_stranger() {
        let (_dir, store) = store();
        store.create_tool(an_entry("user:abc")).await.unwrap();
        assert!(matches!(
            store.create_tool(an_entry("user:abc")).await,
            Err(HouseError::Conflict(_))
        ));
        assert!(matches!(
            store.update_tool(an_entry("user:nope")).await,
            Err(HouseError::NotFound(_))
        ));
        assert!(matches!(
            store.delete_tool("user:nope").await,
            Err(HouseError::NotFound(_))
        ));
        // One item, not two: the duplicate POST changed nothing.
        let (bytes, _) = store.tools().await.unwrap();
        assert_eq!(serde_json::from_slice::<Vec<ToolLibraryEntry>>(&bytes).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_entry_that_cannot_be_served_is_refused_at_the_door() {
        let (_dir, store) = store();
        let nameless = ToolLibraryEntry {
            key: "user:abc".to_string(),
            tool: Tool {
                name: "  ".to_string(),
                ..a_tool("x")
            },
            provenance: "typed in by hand".to_string(),
        };
        assert!(matches!(
            store.create_tool(nameless).await,
            Err(HouseError::BadEntry(_))
        ));
        let unsourced = ToolLibraryEntry {
            provenance: String::new(),
            ..an_entry("user:abc")
        };
        assert!(matches!(
            store.create_tool(unsourced).await,
            Err(HouseError::BadEntry(_))
        ));
    }

    #[tokio::test]
    async fn the_inventory_round_trips_and_refuses_a_zero_quantity() {
        let (dir, store) = store();
        store.create_inventory(an_item("inv-1")).await.unwrap();
        assert!(matches!(
            store.create_inventory(an_item("inv-1")).await,
            Err(HouseError::Conflict(_))
        ));
        let mut empty = an_item("inv-2");
        empty.quantity = 0;
        assert!(matches!(
            store.create_inventory(empty).await,
            Err(HouseError::BadEntry(_))
        ));

        let reopened = HouseStore::open(dir.path().to_path_buf());
        let (bytes, etag) = reopened.inventory().await.unwrap();
        let items: Vec<InventoryItem> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].codes[0].value, "C1-BIT-BALL-NOSE-1-4");
        assert_eq!(etag, etag_for(&bytes));

        reopened.update_inventory(an_item("inv-1")).await.unwrap();
        reopened.delete_inventory("inv-1").await.unwrap();
        let (bytes, _) = reopened.inventory().await.unwrap();
        assert_eq!(bytes, b"[]");
    }

    #[tokio::test]
    async fn a_file_that_cannot_be_read_is_preserved_and_writes_are_refused() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(HOUSE_FILE);
        let junk = b"{ this is not json";
        fs::write(&path, junk).unwrap();

        let store = HouseStore::open(dir.path().to_path_buf());
        let h = store.health().await;
        assert_eq!(h.problems.len(), 1);
        assert!(h.problems[0].contains(HOUSE_FILE), "{:?}", h.problems);

        let err = store.create_tool(an_entry("user:abc")).await.unwrap_err();
        assert!(matches!(err, HouseError::Refused(_)));
        // The user's file is byte-for-byte where they left it.
        assert_eq!(fs::read(&path).unwrap(), junk);
    }

    #[tokio::test]
    async fn a_foreign_or_future_document_is_refused_without_touching_the_house() {
        let dir = TempDir::new().unwrap();
        let store = HouseStore::open(dir.path().to_path_buf());
        store.create_tool(an_entry("user:abc")).await.unwrap();
        let before = fs::read(dir.path().join(HOUSE_FILE)).unwrap();

        let mut wrong_kind: serde_json::Value =
            serde_json::from_slice(&store.export().await.unwrap()).unwrap();
        wrong_kind["kind"] = serde_json::json!("casemaker-my-machine");
        assert!(matches!(
            store.import(&serde_json::to_vec(&wrong_kind).unwrap()).await,
            Err(HouseError::BadEntry(_))
        ));

        let mut future = wrong_kind.clone();
        future["kind"] = serde_json::json!(HOUSE_KIND);
        future["schemaVersion"] = serde_json::json!(HOUSE_SCHEMA_VERSION + 1);
        assert!(matches!(
            store.import(&serde_json::to_vec(&future).unwrap()).await,
            Err(HouseError::BadEntry(_))
        ));

        assert!(matches!(
            store.import(b"not json at all").await,
            Err(HouseError::BadEntry(_))
        ));
        assert_eq!(fs::read(dir.path().join(HOUSE_FILE)).unwrap(), before);
    }

    #[tokio::test]
    async fn an_export_import_round_trip_carries_the_house_and_not_the_catalogue() {
        let dir = TempDir::new().unwrap();
        let catalogue = CatalogueDoc {
            synced_at: Some("2026-10-08T12:00:00.000Z".to_string()),
            tools: vec![a_catalogue_entry("019c049a-8169-7a1e-ace2-28e03809ce44")],
            ..CatalogueDoc::default()
        };
        fs::write(
            dir.path().join(CATALOGUE_FILE),
            serde_json::to_vec_pretty(&catalogue).unwrap(),
        )
        .unwrap();
        let store = HouseStore::open(dir.path().to_path_buf());
        store.create_tool(an_entry("user:abc")).await.unwrap();
        store.create_inventory(an_item("inv-1")).await.unwrap();

        let exported = store.export().await.unwrap();
        let text = String::from_utf8(exported.clone()).unwrap();
        assert!(
            !text.contains("019c049a-8169-7a1e-ace2-28e03809ce44"),
            "vendor rows must not leave the machine"
        );

        // Into a house that never saw either tier.
        let other = TempDir::new().unwrap();
        let fresh = HouseStore::open(other.path().to_path_buf());
        fresh.import(&exported).await.unwrap();
        let (bytes, _) = fresh.tools().await.unwrap();
        let entries: Vec<ToolLibraryEntry> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "user:abc");
        let (inv, _) = fresh.inventory().await.unwrap();
        assert_eq!(serde_json::from_slice::<Vec<InventoryItem>>(&inv).unwrap().len(), 1);
    }

    #[test]
    fn an_atomic_write_leaves_no_temp_file_behind() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(HOUSE_FILE);
        write_atomic(&path, b"{\"kind\":\"casemaker-house\"}").unwrap();
        assert!(path.exists());
        assert!(!dir.path().join("house.json.tmp").exists());
        // A second write replaces the first rather than failing on an existing destination — which
        // is the half of this that differs between platforms.
        write_atomic(&path, b"{\"kind\":\"casemaker-house\",\"tools\":[]}").unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            b"{\"kind\":\"casemaker-house\",\"tools\":[]}"
        );
    }

    #[test]
    fn the_validator_is_stable_and_content_sensitive() {
        assert_eq!(etag_for(b"[]"), etag_for(b"[]"));
        assert_ne!(etag_for(b"[]"), etag_for(b"[ ]"));
        assert!(etag_for(b"[]").starts_with('"') && etag_for(b"[]").ends_with('"'));
    }

    // — the catalogue sync (#308) -----------------------------------------------------------------

    /// A store over `dir`, syncing from `db`. The vendor path is a constructor argument rather than
    /// a request parameter, so a test can point at a fixture without the endpoint growing a way to
    /// name an arbitrary file.
    fn store_syncing(dir: &TempDir, db: &std::path::Path) -> HouseStore {
        HouseStore::open_with(dir.path().to_path_buf(), Some(db.to_path_buf()))
    }

    fn a_library(dir: &TempDir) -> std::path::PathBuf {
        let path = crate::catalogue::fixture::temp_db(dir.path());
        let conn = crate::catalogue::fixture::db(&path);
        crate::catalogue::fixture::put(
            &conn,
            &crate::catalogue::fixture::Cutter {
                diameter: Some(3.175),
                tip: Some(3.175),
                ..crate::catalogue::fixture::Cutter::new("3.175*12mm Flat End(Metal)", 1)
            },
        );
        crate::catalogue::fixture::put(
            &conn,
            &crate::catalogue::fixture::Cutter {
                diameter: Some(3.175),
                max_diameter: Some(1.0),
                corner: Some(0.5),
                ..crate::catalogue::fixture::Cutter::new("3.175*1*3mm Ball Nose(Metal)", 0)
            },
        );
        path
    }

    #[tokio::test]
    async fn a_sync_imports_the_catalogue_and_leaves_the_house_byte_identical() {
        let dir = TempDir::new().unwrap();
        let db = a_library(&dir);
        let store = store_syncing(&dir, &db);
        store.create_tool(an_entry("user:abc")).await.unwrap();
        store.create_inventory(an_item("inv-1")).await.unwrap();
        let house_before = fs::read(dir.path().join(HOUSE_FILE)).unwrap();

        let report = store.sync_catalogue().await.unwrap();
        assert_eq!(report.total, 2);
        assert_eq!(report.added.len(), 2);
        assert_eq!(report.removed.len(), 0);
        assert_eq!(report.changed.len(), 0);
        assert_eq!(report.unchanged, 0);
        assert_eq!(report.source, db.display().to_string());
        assert!(report.synced_at.as_deref().unwrap().ends_with('Z'));
        assert!(report.notes.is_empty(), "{:?}", report.notes);

        // The acceptance criterion, checked as bytes rather than as intent: the user's own file is
        // not rewritten by a sync — not reformatted, not touched at all.
        assert_eq!(fs::read(dir.path().join(HOUSE_FILE)).unwrap(), house_before);

        // And the tiers are served together, catalogue first, in the vendor's order.
        let (bytes, _) = store.tools().await.unwrap();
        let entries: Vec<ToolLibraryEntry> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries[0].key.starts_with("cat:"), "{}", entries[0].key);
        assert_eq!(entries[2].key, "user:abc");
        assert_eq!(entries[0].tool.name, "3.175*1*3mm Ball Nose(Metal)");

        let h = store.health().await;
        assert!(h.has_catalogue);
        assert!(h.problems.is_empty(), "{:?}", h.problems);
        assert_eq!(h.catalogue_synced_at, report.synced_at);
        // The file is the source of truth across a restart, as every other write here is.
        let reopened = store_syncing(&dir, &db);
        assert!(reopened.health().await.has_catalogue);
    }

    #[tokio::test]
    async fn a_second_sync_changes_nothing_and_says_so() {
        let dir = TempDir::new().unwrap();
        let db = a_library(&dir);
        let store = store_syncing(&dir, &db);
        store.sync_catalogue().await.unwrap();
        let (served, etag) = store.tools().await.unwrap();

        let again = store.sync_catalogue().await.unwrap();
        assert_eq!(again.added.len(), 0);
        assert_eq!(again.removed.len(), 0);
        assert_eq!(again.changed.len(), 0);
        assert_eq!(again.unchanged, again.total);
        // Idempotent where it matters: what the client gets back is the same list with the same
        // validator, so no picker is made to re-read anything.
        let (served_again, etag_again) = store.tools().await.unwrap();
        assert_eq!(served, served_again);
        assert_eq!(etag, etag_again);
    }

    #[tokio::test]
    async fn a_sync_replaces_a_catalogue_file_that_cannot_be_read() {
        // The exception to the house's preserve-never-overwrite rule, and the reason for it: the
        // catalogue's only copy is Makera's database, so the sync is the recovery. Refusing would
        // leave a corrupt file as a permanent block on the one operation that can heal it.
        let dir = TempDir::new().unwrap();
        let db = a_library(&dir);
        fs::write(dir.path().join(CATALOGUE_FILE), b"{ this is not json").unwrap();
        let store = store_syncing(&dir, &db);
        assert_eq!(store.health().await.problems.len(), 1);

        let report = store.sync_catalogue().await.unwrap();
        assert_eq!(report.total, 2);
        assert!(
            report.notes.iter().any(|n| n.contains("could not be read")),
            "{:?}",
            report.notes
        );
        assert!(store.health().await.problems.is_empty());
        assert!(store.health().await.has_catalogue);
    }

    #[tokio::test]
    async fn a_sync_that_would_lose_the_catalogue_is_refused() {
        let dir = TempDir::new().unwrap();
        let db = a_library(&dir);
        let store = store_syncing(&dir, &db);
        store.sync_catalogue().await.unwrap();
        let before = fs::read(dir.path().join(CATALOGUE_FILE)).unwrap();

        // A well-formed database with no cutters in it: an import of nothing, over a catalogue that
        // has rows. Makera publishes 129 of them, so this is a read that went wrong.
        let empty_dir = TempDir::new().unwrap();
        let empty = crate::catalogue::fixture::temp_db(empty_dir.path());
        crate::catalogue::fixture::db(&empty);
        let store = store_syncing(&dir, &empty);
        let err = store.sync_catalogue().await.unwrap_err();
        assert!(matches!(err, HouseError::Refused(_)), "{err:?}");
        assert!(err.to_string().contains("no cutters"), "{err}");
        assert_eq!(fs::read(dir.path().join(CATALOGUE_FILE)).unwrap(), before);
        assert!(store.health().await.has_catalogue, "the old rows are still served");
    }

    #[tokio::test]
    async fn a_row_that_cannot_be_served_refuses_the_whole_sync() {
        let dir = TempDir::new().unwrap();
        let db = a_library(&dir);
        let store = store_syncing(&dir, &db);
        store.sync_catalogue().await.unwrap();
        let before = fs::read(dir.path().join(CATALOGUE_FILE)).unwrap();

        // A row with no name: `ToolSchema` would refuse it at the client, so it is refused here,
        // and refusing it means the sync imports nothing rather than importing a cut-down list.
        let other = TempDir::new().unwrap();
        let db = crate::catalogue::fixture::temp_db(other.path());
        let conn = crate::catalogue::fixture::db(&db);
        crate::catalogue::fixture::put(
            &conn,
            &crate::catalogue::fixture::Cutter {
                diameter: Some(3.175),
                ..crate::catalogue::fixture::Cutter::new("   ", 1)
            },
        );
        drop(conn);

        let store = store_syncing(&dir, &db);
        let err = store.sync_catalogue().await.unwrap_err();
        assert!(matches!(err, HouseError::BadEntry(_)), "{err:?}");
        assert!(err.to_string().contains("no name"), "{err}");
        assert_eq!(fs::read(dir.path().join(CATALOGUE_FILE)).unwrap(), before);
    }

    #[tokio::test]
    async fn a_sync_with_nowhere_to_read_from_says_so() {
        let dir = TempDir::new().unwrap();
        let store = HouseStore::open_with(dir.path().to_path_buf(), None);
        let err = store.sync_catalogue().await.unwrap_err();
        assert!(matches!(err, HouseError::NotFound(_)), "{err:?}");

        let missing = dir.path().join("nowhere.db");
        let store = HouseStore::open_with(dir.path().to_path_buf(), Some(missing));
        let err = store.sync_catalogue().await.unwrap_err();
        assert!(matches!(err, HouseError::NotFound(_)), "{err:?}");
        assert!(err.to_string().contains("nowhere.db"), "{err}");
    }
}
