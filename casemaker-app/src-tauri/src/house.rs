// The house service's data and its file (#306, tracking #212).
//
// WHAT THIS IS. The app's embedded axum server (`server.rs`) already serves the web bundle and is
// the process that talks to the Z1. This module is what it now serves on top of that: the house's
// own cutters and inventory, kept as versioned JSON on disk, with the HTTP API as the contract
// rather than the file. `house_api.rs` is the HTTP half; nothing here knows about axum.
//
// WHY JSON AND NOT SQLITE. Scale is 129 catalogue cutters and 1 328 feed rows — a few hundred KB,
// served from memory, needing no index and no join. Every client funnels through this one process,
// so a `tokio::sync::RwLock` plus an atomic temp-write-and-rename gives what is actually required
// *within it*, and a browser can never open the file — but a second INSTANCE of the desktop app can,
// which is a different problem with its own answer in the next paragraph. And there is
// exactly ONE shape authority: the client Zod-parses the JSON (`ToolLibrarySchema` already refuses
// duplicate keys), where SQLite would put the shape in Rust DDL, serde and TS Zod at once — with no
// migration runner anywhere in this project. The API is the contract, not the file: if the data
// grows, the same endpoints can be backed by SQLite without the client changing.
//
// A SECOND PROCESS, AND A SECOND PERSON (#321). A browser on the LAN cannot open `house.json`, but
// two instances of the desktop app can, and `server.rs` used to make that a first-class case by
// falling back to an ephemeral port when the configured one was taken — so the second instance kept
// its own memory copy and wrote it through a temp file with a FIXED name, and the two quietly
// overwrote each other. Three things now hold, three different mechanisms:
//
//   * ONE HOUSE, ONE SERVING PROCESS. `HouseLock` takes an exclusive lock on `house.lock` beside the
//     documents for as long as the process serves, and `lib.rs` refuses to launch a second instance
//     rather than binding another port. `server::start` takes `&HouseLock`, so "this process holds
//     the house" is a requirement of serving it the compiler enforces, not a promise in a comment.
//   * A WRITE BASED ON A STALE READING IS REFUSED. `PATCH` and `DELETE` carry `If-Match` with the
//     `ETag` of the list the client last read, so two people editing one cutter get a 412 instead of
//     last-writer-wins. This is NOT covered by the lock: three browsers against ONE process are the
//     ordinary LAN case, and none of them is a second process.
//   * THE TEMP FILE A WRITE USES IS ITS OWN. Its name carries the pid and a counter, so two writers
//     cannot rename each other's bytes over the document.
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
// A KEY THIS SERVICE STORES IS EXACTLY `user:<something>` (#319). That namespace is the only one it
// owns: `cat:` belongs to a sync (#308), `inv:` to the inventory's ids and a bare key to the
// built-ins (`toolRegistry.ts`), so nothing else may be stored here — which is also what keeps
// `flat-1.0` out of the house file. A key is also refused if it carries `|` or any control
// character (neither survives `;@CM|TOOL|key=…`, #305 design point 3, `/Fabrication.md` §2), or if
// it has whitespace at either end. Every one of those is refused at the door rather than sanitised,
// so a bad key is a visible 4xx and not a silent rename.
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

use crate::catalogue::{CatalogueDoc, SyncNote, SyncReport, SyncSummary, CATALOGUE_KIND};
use crate::etag::etag_for;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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

/// The lock file beside the two documents (#321).
const LOCK_FILE: &str = "house.lock";

/// An exclusive lock on the house directory, held for as long as this process serves the house
/// (#321).
///
/// WHY IT EXISTS. Two instances of the desktop app used to be able to run at once: the second could
/// not have the configured port (`server.rs` falls back to an ephemeral one) and opened the same
/// `house.json` with no lock and no reload, so each served its own memory and each save overwrote
/// the other's — a change saved in one quietly gone after the next save in the other. `lib.rs` asks
/// for this lock before starting the server and refuses to launch without it, and `server::start`
/// takes `&HouseLock`, so serving the house without holding it does not compile.
///
/// THE LOCK, NOT THE FILE, IS THE TRUTH. `try_lock` asks the operating system whether anyone holds
/// it, and the OS releases a lock when its holder dies — killed, crashed, or exited, which a pid
/// file cannot tell apart from a live process. So a `house.lock` left behind by a crash blocks
/// nobody and needs no clean-up. Nothing here ever DELETES the file either: unlinking it while
/// another process held a lock on it would let a third create a fresh file and lock *that*, and two
/// processes would be serving one house again. It is created once and stays, empty — content would
/// only be a second, staleable answer to a question the lock already answers.
/// The `Debug` is for the tests: `unwrap_err` needs the `Ok` side printable, and a lock that refuses
/// to be printed is a lock nobody can assert on.
#[derive(Debug)]
pub struct HouseLock {
    /// The lock lives in the open file, so this is released by dropping it. Never read.
    _file: fs::File,
    /// The directory that was locked. Carried so that `server::start`, which takes this as proof,
    /// serves the house the lock is actually on rather than looking the directory up a second time.
    dir: PathBuf,
}

impl HouseLock {
    /// Take the house directory's lock, or return the sentence saying who has it.
    ///
    /// The `Err` is written for the user and is what `lib.rs` shows: another Case Maker is already
    /// serving this house, and the answer is to use that window rather than to force this one in.
    pub fn acquire(dir: &Path) -> Result<HouseLock, String> {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = dir.join(LOCK_FILE);
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        match file.try_lock() {
            Ok(()) => Ok(HouseLock {
                _file: file,
                dir: dir.to_path_buf(),
            }),
            Err(std::fs::TryLockError::WouldBlock) => Err(format!(
                "Case Maker is already running against this house ({}). Use that window — close it \
                 first if you meant to start a fresh one",
                dir.display()
            )),
            Err(std::fs::TryLockError::Error(e)) => Err(format!("{}: {e}", path.display())),
        }
    }

    /// The house directory this lock is held on.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    /// The catalogue row's `cutterId` (`/Makera-Parity.md` §3.2), NOT the `g_ID` the `.nc` header
    /// carries: the UUID is what a re-sync diffs on, and the `g_ID` is not inherited by a clone.
    pub id: String,
    #[serde(default)]
    pub synced_at: Option<String>,
}

impl Origin {
    /// An origin is a claim about WHICH catalogue row this came from, so an empty id claims a
    /// provenance it cannot name (#320). It is not on the wire — the panel reads `provenance` — but
    /// an inventory item carries one into `GET /api/v1/inventory`, where the client's
    /// `OriginSchema` refuses `id: ''` exactly as this does.
    fn validate(&self) -> Result<(), HouseError> {
        if self.id.trim().is_empty() {
            return Err(HouseError::BadEntry(
                "the origin names no catalogue row".into(),
            ));
        }
        Ok(())
    }
}

/// A cutter the user's house owns, as stored. The wire shape is {@link ToolLibraryEntry}: `origin`
/// stays on disk because the client's Zod schema does not carry it yet, and `provenance` — the
/// human sentence the panel shows — already says what it was cloned from.
///
/// UNKNOWN KEYS ARE REFUSED, here and on every struct `house.json` is made of (#339). The file is
/// the user's and is hand-editable, and a misspelled optional key (`orgin`) would otherwise parse
/// clean and be dropped by the next `commit`'s rewrite — a hand edit lost with no `problem` to say
/// so, which is the failure shape #320 is about. `CatalogueDoc` stays lenient on purpose: it is
/// machine-written and a sync replaces it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserTool {
    pub key: String,
    pub tool: Tool,
    /// One sentence for the panel (#311): "your own", "cloned from Makera catalogue … on …".
    pub provenance: String,
    #[serde(default)]
    pub origin: Option<Origin>,
}

impl UserTool {
    /// The entry that goes on the wire, plus the `origin` that stays on disk. Both are checked: the
    /// entry because `/tools` serves it, the origin because a document that carries a half-written
    /// one is a document this service should not adopt (#320).
    fn validate(&self) -> Result<(), HouseError> {
        ToolLibraryEntry::from(self).validate()?;
        if let Some(origin) = &self.origin {
            origin.validate()?;
        }
        Ok(())
    }
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryItem {
    /// Ours, minted by the client (`utils/id.ts`). Unique, and checked here: a document with the
    /// same id twice is two rows for one possession. The **codes** are checked for uniqueness too
    /// — across the whole inventory, not just within the item (#320) — because `code → the item` is
    /// the door (#309) and it is only a function if a printed code names one cutter.
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
    /// Everything true of the item ON ITS OWN. What needs the rest of the document — a code another
    /// item already carries, an id that is already registered — is checked by the caller, which is
    /// the only place that can see it (`HouseStore::no_code_clash`, `HouseDoc::validate`).
    fn validate(&self) -> Result<(), HouseError> {
        if self.id.trim().is_empty() {
            return Err(HouseError::BadEntry("the item has no id".into()));
        }
        if self.quantity == 0 {
            return Err(HouseError::BadEntry(
                "quantity 0 is not a possession — remove the item instead".into(),
            ));
        }
        if self.added_at.trim().is_empty() {
            return Err(HouseError::BadEntry(
                "the item does not say when it was registered".into(),
            ));
        }
        if let Some(origin) = &self.origin {
            origin.validate()?;
        }
        // A code is evidence of what this cutter is: an empty one identifies nothing, and the same
        // value twice on one item is one code written twice.
        let mut seen = HashSet::new();
        for c in &self.codes {
            if c.value.trim().is_empty() {
                return Err(HouseError::BadEntry(format!(
                    "{} carries a code with no value in it",
                    self.id
                )));
            }
            if !seen.insert(c.value.as_str()) {
                return Err(HouseError::BadEntry(format!(
                    "{} carries the code {} twice",
                    self.id, c.value
                )));
            }
        }
        self.tool.validate()
    }
}

/// The code on `item` that another item in `inventory` already carries, if any (#309's invariant,
/// stated once in #320). `None` when the item is the only holder, which is the normal case.
///
/// A CREATE has no entry in the list yet, so every item is "another"; an UPDATE has one, and
/// `id` is what excludes the item's own previous codes from clashing with its new ones.
fn clashing_code<'a>(inventory: &'a [InventoryItem], item: &'a InventoryItem) -> Option<&'a str> {
    item.codes.iter().map(|c| c.value.as_str()).find(|value| {
        inventory
            .iter()
            .any(|other| other.id != item.id && other.codes.iter().any(|c| c.value == *value))
    })
}

/// `house.json` — the user's own tiers. A sync (#308) never touches this file. Unknown keys are
/// refused (see `UserTool`), and this is also the document `/api/v1/import` accepts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

impl HouseDoc {
    /// Everything that must hold of the DOCUMENT, not of one row (#320). Two callers, and they are
    /// the two doors a whole document comes through: `import` (a user's file) and `load` (the file
    /// this service reads at startup). Both must run it, because a house the service accepts and the
    /// client refuses is the defect: `GET /tools` would answer a body `ToolLibrarySchema` rejects,
    /// and #306's rule then makes the WHOLE house read `absent` — the catalogue tier with it — while
    /// `/health` still says ok, and nothing names what caused it.
    ///
    /// So this is the client's own contract, restated where the data is written: every tool is a
    /// full {@link ToolLibraryEntry} (key, tool, provenance), keys are unique, and no two inventory
    /// items share an id or a code.
    fn validate(&self) -> Result<(), HouseError> {
        let mut keys = HashSet::new();
        for t in &self.tools {
            // The entry is the thing that goes on the wire, so the entry is what is validated —
            // plus the `origin`, which `ToolLibraryEntry` does not carry.
            t.validate()?;
            if !keys.insert(t.key.as_str()) {
                return Err(HouseError::BadEntry(format!(
                    "{} appears twice in the tool list: one key, one cutter",
                    t.key
                )));
            }
        }
        let mut ids = HashSet::new();
        let mut codes = HashSet::new();
        for i in &self.inventory {
            i.validate()?;
            if !ids.insert(i.id.as_str()) {
                return Err(HouseError::BadEntry(format!(
                    "{} is registered twice: one id, one possession",
                    i.id
                )));
            }
            for c in &i.codes {
                if !codes.insert(c.value.as_str()) {
                    return Err(HouseError::BadEntry(format!(
                        "the code {} is on more than one cutter: the code is what the inventory is \
                         looked up by, so it names one",
                        c.value
                    )));
                }
            }
        }
        Ok(())
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
    /// What the last sync came to (#328): its counts and its notes, kept in `catalogue.json` so the
    /// desktop and a LAN browser read the same answer after a restart. `None` until the first sync,
    /// and for a catalogue file written before the field existed.
    pub last_sync: Option<SyncSummary>,
    /// One sentence per document that could not be read. A non-empty list is also why writes are
    /// refused: the store will not overwrite a file it could not understand.
    pub problems: Vec<String>,
}

/// Everything the API can refuse, and why. Mapped to HTTP status codes in `house_api.rs`.
#[derive(Debug, Clone, PartialEq)]
pub enum HouseError {
    /// The key is not one this service may store (not exactly `user:<something>`, or carrying `|`,
    /// a control character or edge whitespace — `validate_key`).
    BadKey(String),
    /// The entry itself cannot be served (no name, no provenance, a non-finite number).
    BadEntry(String),
    /// A create against a key that already exists, or a delete of one that does not.
    Conflict(String),
    NotFound(String),
    /// A guarded write arrived with no `If-Match` (#321): the service cannot tell the client's copy
    /// of the list from every other client's, so it will not guess which one is meant.
    PreconditionRequired(String),
    /// ...and the version it named is not the one being served, so somebody else wrote first (#321).
    StalePrecondition(String),
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
            | HouseError::PreconditionRequired(m)
            | HouseError::StalePrecondition(m)
            | HouseError::Refused(m)
            | HouseError::Io(m) => write!(f, "{m}"),
        }
    }
}

/// The key rule, in one place. See the module doc for why each clause exists.
///
/// EXACTLY `user:`, AND NOTHING ELSE (#319). This service stores ONE namespace: the user's own
/// tools. `cat:` belongs to a sync (#308), `inv:` to the inventory's ids (`toolRegistry.ts` mints
/// them) and a bare key to the built-ins, so anything that is not `user:` is refused rather than
/// stored in a namespace something else owns — and the comparison is on the prefix, so `Cat:1`,
/// `CAT:1` and `cat:1` are one refusal rather than one refusal and two stowaways. The local part
/// must be non-empty: `user:` names no cutter.
///
/// WHAT EACH REFUSAL IS FOR. `|` and any control character cannot survive `;@CM|TOOL|key=…` — the
/// pipe ends the field and a newline ends the comment, which would let a stored key inject a line
/// into a job's `.nc` (#305 design point 3). Edge whitespace is refused rather than trimmed,
/// because `user:abc ` and `user:abc` are two keys to a `HashMap` and one cutter to a human, and a
/// silent rename is the thing this module refuses to do anywhere. Nothing here is normalised: a key
/// is stored exactly as it was accepted, or not at all.
fn validate_key(key: &str) -> Result<(), HouseError> {
    if key.trim().is_empty() {
        return Err(HouseError::BadKey("the key is empty".into()));
    }
    if key != key.trim() {
        return Err(HouseError::BadKey(format!(
            "{key:?} has whitespace at one end: it would be stored invisibly, so it is refused \
             rather than trimmed"
        )));
    }
    if let Some(c) = key.chars().find(|c| c.is_control()) {
        return Err(HouseError::BadKey(format!(
            "{key:?} contains the control character {:?}, which ends the .nc header's tool comment \
             — a stored key with one in it could inject a line into a job's program",
            c.escape_default().to_string()
        )));
    }
    if key.contains('|') {
        return Err(HouseError::BadKey(format!(
            "{key} contains a pipe, which the .nc header's tool line cannot carry"
        )));
    }
    let Some(local) = key.strip_prefix("user:") else {
        return Err(HouseError::BadKey(format!(
            "{key} is not in the `user:` namespace, which is the only one this service stores: \
             `cat:` belongs to a sync, `inv:` to the inventory, and a bare key like `flat-1.0` to \
             the built-ins"
        )));
    };
    if local.is_empty() {
        return Err(HouseError::BadKey(format!(
            "{key} names nothing after the namespace"
        )));
    }
    Ok(())
}

fn json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, HouseError> {
    serde_json::to_vec(value).map_err(|e| HouseError::Io(format!("could not serialize: {e}")))
}

/// The `/tools` body: the catalogue tier first, then the user's own, since a user's tool is the one
/// they went out of their way to define.
///
/// A free function over `&Inner` rather than a method (#321), because a guarded write needs this
/// list's validator WHILE it holds the write guard — and a method would take a second lock on an
/// `RwLock` already held by the same task, which is a deadlock rather than a syntax error.
fn tools_bytes(inner: &Inner) -> Result<Vec<u8>, HouseError> {
    let mut entries: Vec<ToolLibraryEntry> =
        inner.catalogue.tools.iter().map(ToolLibraryEntry::from).collect();
    entries.extend(inner.house.tools.iter().map(ToolLibraryEntry::from));
    json_bytes(&entries)
}

/// The `/inventory` body, ordered by `added_at` so a list a UI renders does not reshuffle when a
/// write lands somewhere in the middle of the file. Same free-function rule as `tools_bytes`.
fn inventory_bytes(inner: &Inner) -> Result<Vec<u8>, HouseError> {
    let mut items = inner.house.inventory.clone();
    items.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.id.cmp(&b.id)));
    json_bytes(&items)
}

/// The `If-Match` precondition (#321), evaluated BEFORE the method changes anything — RFC 9110
/// §13.2.2's order, and the only order that makes such a check mean something.
///
/// REQUIRED, not optional. A guarded write that may omit its guard is last-writer-wins with extra
/// steps: the client that forgot the header would be the one quietly discarding another's edit,
/// which is the whole case this is for. `*` means "some current version", as the header does — it
/// is not a way to opt out, because the thing being written still has to be there.
fn check_precondition(current: &str, if_match: Option<&str>, what: &str) -> Result<(), HouseError> {
    match if_match {
        Some(given) if given == "*" || given == current => Ok(()),
        Some(_) => Err(HouseError::StalePrecondition(format!(
            "{what} changed since you read it, so this save was based on a version that is no \
             longer there — reload and make the change again"
        ))),
        None => Err(HouseError::PreconditionRequired(format!(
            "this save did not say which version of {what} it was based on, so the service cannot \
             check it against another window's — reload and save again"
        ))),
    }
}

/// Distinguishes the temp files of one process's writes from each other, and from every other
/// process's (`write_atomic`, #321).
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// The sibling temp file `write_atomic` writes through: `<name>.<pid>-<n>.tmp` (#321).
///
/// NOT A FIXED NAME. `house.json.tmp` was the same string for every writer on the machine, so two
/// writers could each create it, each write their own bytes, and each rename it — the loser's
/// `rename` moved a file holding the WINNER's bytes over the document, and then both processes went
/// on believing their own copy was what landed. The pid and a per-process counter make the name
/// unreachable by anyone else; `rename` over the document is still the atomic step, and it is still
/// the only step the two writers contend on.
fn scratch_sibling(path: &Path) -> PathBuf {
    let n = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".{}-{n}.tmp", std::process::id()));
    path.with_file_name(name)
}

/// Write `bytes` to `path` atomically: a sibling temp file of this writer's own, flushed to disk,
/// then renamed over the target. A crash mid-write leaves the temp file behind rather than a
/// half-written document.
///
/// THE NAME IS UNIQUE PER WRITER (#321) — see `scratch_sibling` — and the file is flushed before the
/// rename, so a reader of `path` sees the old document or the new one and never a mixture. That
/// temp file is never swept up afterwards: a crashed write leaves one dead file named after the pid
/// that died, which nothing will ever read or reuse. Leaving a stray file is the cheap half of that
/// trade; deleting a live temp file out from under another writer is the expensive half.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), HouseError> {
    let dir = path.parent();
    if let Some(parent) = dir {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, &e))?;
    }
    let tmp = scratch_sibling(path);
    {
        let mut f = fs::File::create(&tmp).map_err(|e| io_err(&tmp, &e))?;
        f.write_all(bytes).map_err(|e| io_err(&tmp, &e))?;
        f.sync_all().map_err(|e| io_err(&tmp, &e))?;
    }
    // `std::fs::rename` replaces an existing destination on every platform this ships on (on
    // Windows it is `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), which is what makes this atomic
    // rather than "atomic, except the first time".
    fs::rename(&tmp, path).map_err(|e| io_err(path, &e))?;
    sync_dir(dir)
}

/// Flush the DIRECTORY entry the rename just changed, so a crash in the next few milliseconds cannot
/// bring the previous document back while the client was told the write succeeded (#321).
///
/// Unix only, and deliberately not fatal. On Windows a directory cannot be opened as a file at all
/// and `std` has no way to ask `MoveFileEx` for `MOVEFILE_WRITE_THROUGH`, so the ordering the rename
/// itself provides is what that platform has — said here rather than silently skipped.
///
/// A FAILURE IS REPORTED, NOT RETURNED. By the time this runs the bytes are on disk under the right
/// name, so failing the call would leave the in-memory house BEHIND the file — which is the state
/// that loses a write — in exchange for a durability guarantee that is only about the crash window.
fn sync_dir(dir: Option<&Path>) -> Result<(), HouseError> {
    #[cfg(unix)]
    if let Some(d) = dir {
        if let Err(e) = fs::File::open(d).and_then(|f| f.sync_all()) {
            log::warn!("house service: could not flush {}: {e}", d.display());
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
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
        let house_path = dir.join(HOUSE_FILE);
        let (house, house_problem) = match read_doc::<HouseDoc>(&house_path, HOUSE_KIND) {
            // Parsing is not enough (#320): a hand-edited `house.json` can parse and still hold a
            // duplicate key or a tool the client refuses, and serving it is what makes the whole
            // house read `absent` on the other side. A document that fails its own rules is treated
            // exactly like one that fails to parse — the reason goes in `/health`, the user's file
            // is left alone, and every write is refused until it is dealt with by hand.
            Ok(Some(doc)) => match doc.validate() {
                Ok(()) => (doc, None),
                Err(e) => {
                    let why = format!("{} cannot be served: {e}", house_path.display());
                    log::warn!("house service: {why}");
                    (HouseDoc::default(), Some(why))
                }
            },
            Ok(None) => (HouseDoc::default(), None),
            Err(e) => {
                log::warn!("house service: {e}");
                (HouseDoc::default(), Some(e))
            }
        };
        let catalogue_path = dir.join(CATALOGUE_FILE);
        let (catalogue, catalogue_problem) =
            match read_doc::<CatalogueDoc>(&catalogue_path, CATALOGUE_KIND) {
                // The same rule as the house, one tier down (#339): a parsed entry is not a servable
                // one. A corrupted row with a non-`cat:` key would go out on `/tools`, the client's
                // `isToolKey` would refuse the WHOLE list, and the house would read absent while
                // `/health` said ok. So the tier is empty and the reason is in `/health` — which a
                // sync heals, since the catalogue's only copy is the vendor's database.
                Ok(Some(doc)) => match doc.tools.iter().try_for_each(|e| e.validate()) {
                    Ok(()) => (doc, None),
                    Err(e) => {
                        let why = format!("{} cannot be served: {e}", catalogue_path.display());
                        log::warn!("house service: {why}");
                        (CatalogueDoc::default(), Some(why))
                    }
                },
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
            last_sync: inner.catalogue.last_sync.clone(),
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
        let bytes = tools_bytes(&inner)?;
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
        let bytes = inventory_bytes(&inner)?;
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
    ///
    /// GUARDED (#321). `if_match` is the `ETag` the client read the tool list with, and a save based
    /// on a version that is no longer served is REFUSED — 412 — rather than winning silently.
    /// REQUIRED: `None` is refused too, because a caller that omits it is the one who would otherwise
    /// discard another window's edit. See `check_precondition`.
    pub async fn update_tool(
        &self,
        entry: ToolLibraryEntry,
        if_match: Option<&str>,
    ) -> Result<(), HouseError> {
        entry.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        check_precondition(&etag_for(&tools_bytes(&inner)?), if_match, "the tool list")?;
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

    /// Remove a user tool. Guarded on the tool list's `ETag`, exactly as `update_tool` is (#321).
    pub async fn delete_tool(&self, key: &str, if_match: Option<&str>) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        check_precondition(&etag_for(&tools_bytes(&inner)?), if_match, "the tool list")?;
        let mut next = inner.house.clone();
        let before = next.tools.len();
        next.tools.retain(|t| t.key != key);
        if next.tools.len() == before {
            return Err(HouseError::NotFound(format!("{key} is not in the house")));
        }
        self.commit(&mut inner, next)
    }

    /// Register a cutter. Refuses an id that is already registered, and a code another item already
    /// carries — the invariant #309 leans on ("scan it again" resolves a code to ONE item and offers
    /// quantity + 1), enforced here rather than only in the panel, so an import, a second window or
    /// a buggy caller cannot create the ambiguity the panel is built to avoid.
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
        if let Some(code) = clashing_code(&inner.house.inventory, &item) {
            return Err(HouseError::Conflict(format!(
                "{code} is already on another cutter — change that one's quantity instead of \
                 registering a second"
            )));
        }
        let mut next = inner.house.clone();
        next.inventory.push(item);
        self.commit(&mut inner, next)
    }

    /// Change a possession: its count, its notes, or which codes identify it.
    ///
    /// GUARDED (#321) on the INVENTORY list's `ETag` — a different document from the tool list, so an
    /// edit to a cutter's count is not invalidated by somebody re-measuring a definition.
    pub async fn update_inventory(
        &self,
        item: InventoryItem,
        if_match: Option<&str>,
    ) -> Result<(), HouseError> {
        item.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        check_precondition(&etag_for(&inventory_bytes(&inner)?), if_match, "the inventory")?;
        // Existence first: an id nobody registered is a NOT FOUND whatever codes it carries.
        if !inner.house.inventory.iter().any(|i| i.id == item.id) {
            return Err(HouseError::NotFound(format!(
                "{} is not registered",
                item.id
            )));
        }
        if let Some(code) = clashing_code(&inner.house.inventory, &item) {
            return Err(HouseError::Conflict(format!(
                "{code} is already on another cutter"
            )));
        }
        let mut next = inner.house.clone();
        let existing = next
            .inventory
            .iter_mut()
            .find(|i| i.id == item.id)
            .expect("the id was just found");
        *existing = item;
        self.commit(&mut inner, next)
    }

    /// Take a cutter out of the inventory. Guarded on the inventory's `ETag`, as `update_inventory`
    /// is (#321).
    pub async fn delete_inventory(&self, id: &str, if_match: Option<&str>) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.house_problem)?;
        check_precondition(&etag_for(&inventory_bytes(&inner)?), if_match, "the inventory")?;
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
    /// WHAT IT REFUSES. A vendor file that is not there, a row that cannot be served, a FEED query
    /// that fails for any reason other than the table being absent (#326: the reader answers that
    /// case with an empty matrix and no note, and refuses everything else rather than emptying 1 328
    /// starting numbers with a clean report), and an import that is EMPTY while the stored catalogue
    /// has rows: Makera publishes 129 cutters, so an empty read is a read that went wrong, and
    /// replacing a good list with it is the one way this operation can lose something. A sync that
    /// changes nothing is not a failure: it writes the same rows with a fresh `syncedAt` and reports
    /// no additions, removals or changes.
    ///
    /// AND THE STORE IS ONLY TOUCHED ONCE THE WRITE HAS LANDED. The in-memory catalogue and the
    /// `catalogue_problem` it clears are both updated after `write_atomic` returns (#326): a sync
    /// whose write fails leaves the store exactly as it was, problem included.
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
        // READ, not taken (#326). Clearing the problem here would make it conditional on the write
        // below succeeding, and it does not always: a `take()` before `write_atomic` means a sync
        // whose write FAILS reports no problem while `catalogue.json` is still unreadable, and the
        // next successful sync loses the note about the file it replaced.
        if let Some(problem) = inner.catalogue_problem.as_deref() {
            // A LOSS (#328): whatever that file held is gone, and this sync's rows are what replaced it.
            notes.push(SyncNote::loss(format!(
                "the previous catalogue file could not be read ({problem}) — this sync replaced it"
            )));
        }
        // The same loss one tier down, and a NOTE rather than a refusal (#326). An import that
        // arrives with no feed rows while the stored catalogue has some is either a vendor database
        // that never held them or one whose rows were all dropped — and unlike an empty list of
        // cutters, which leaves nothing to cut with and is refused above, an empty feed matrix is a
        // fall-back to the app's starting table. So it is said and no more: the sync still lands,
        // because stopping here would block the one operation that can heal a bad catalogue file.
        if imported.feeds.is_empty() && !inner.catalogue.feeds.is_empty() {
            // The one feed note that is a LOSS (#328): a matrix that had rows and now has none. A
            // large drop that leaves some is `catalogue.rs`'s information note, however large.
            notes.push(SyncNote::loss(format!(
                "it holds no feed rows, and the catalogue already has {} — this sync emptied the \
                 feed matrix, so every starting number is now the app's own",
                inner.catalogue.feeds.len()
            )));
        }

        let report = SyncReport {
            source: path.display().to_string(),
            synced_at: Some(synced_at.clone()),
            total: imported.entries.len(),
            unchanged: change.unchanged,
            added: change.added,
            removed: change.removed,
            changed: change.changed,
            feed_rows: imported.feeds.len(),
            notes,
        };
        let doc = CatalogueDoc {
            synced_at: Some(synced_at),
            tools: imported.entries,
            feeds: imported.feeds,
            // The report's counts and notes outlive this response (#328): written beside the rows
            // so a restart, or a second client, still has what the sync said.
            last_sync: Some(SyncSummary::from(&report)),
            ..CatalogueDoc::default()
        };
        let bytes = serde_json::to_vec_pretty(&doc)
            .map_err(|e| HouseError::Io(format!("could not serialize the catalogue: {e}")))?;
        write_atomic(&self.dir.join(CATALOGUE_FILE), &bytes)?;

        inner.catalogue = doc;
        inner.catalogue_problem = None;
        Ok(report)
    }

    /// Replace the house from an exported document. WHOLE-OR-NOTHING (decision 28): the document is
    /// parsed, version-checked and VALIDATED before anything is touched, so a truncated, foreign or
    /// self-contradictory file is refused with a reason and the store is left exactly as it was.
    ///
    /// THE VALIDATION IS THE CLIENT'S, NOT A LOOSER ONE (#320). An import this service accepts must
    /// be one the app can read back, so the whole document is held to `HouseDoc::validate` — every
    /// tool through the full entry rule, unique keys, unique inventory ids and codes — rather than
    /// to the two hand-picked checks this once ran. Accepting a document the client refuses is how
    /// the house reads `absent` with `/health` still saying ok, and nothing naming the import.
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
        doc.validate()?;
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
            // The code is derived from the id ON PURPOSE: a code names one cutter (#320), so a
            // helper that handed every item the same code would be a fixture that cannot exist.
            codes: vec![Coded {
                symbology: "qr_code".to_string(),
                value: format!("C1-BIT-{}", id.to_uppercase()),
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
        store
            .update_tool(an_entry("user:abc"), Some(&etag_c))
            .await
            .unwrap();
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
            // #319 — the rows the namespace rule used to let through. `Cat:1` is the one the
            // case-sensitive `starts_with("cat:")` accepted, and the newline is the injection.
            ("Cat:1", "the catalogue namespace, by case"),
            ("CAT:1", "the catalogue namespace, shouting"),
            ("cal:1", "no namespace this service knows"),
            ("flat:1.0", "a colon in a namespace nobody owns"),
            (":", "a namespace with nothing on either side"),
            ("user:", "the namespace with no name after it"),
            (" user:x ", "whitespace at both ends, refused rather than trimmed"),
            ("user:x ", "whitespace at the end"),
            ("user:a\nG0 Z-50", "a newline, which ends the .nc header's comment line"),
            ("user:a\r\nG0 Z-50", "CRLF, the same thing on another platform"),
            ("user:a\tb", "a tab"),
            ("inv:1a2b3c", "the inventory mints `inv:` keys, not this service"),
        ] {
            let err = store.create_tool(an_entry(key)).await.unwrap_err();
            match err {
                HouseError::BadKey(m) => assert!(!m.is_empty(), "{why}: a refusal must say why"),
                other => panic!("{key:?} ({why}) was refused as {other:?}"),
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
        // The stranger cases carry the CURRENT validator, so what they get back is about the key
        // being absent and not about a stale read (#321). `*` is the header's "some version".
        let (_, etag) = store.tools().await.unwrap();
        assert!(matches!(
            store.create_tool(an_entry("user:abc")).await,
            Err(HouseError::Conflict(_))
        ));
        assert!(matches!(
            store.update_tool(an_entry("user:nope"), Some(&etag)).await,
            Err(HouseError::NotFound(_))
        ));
        assert!(matches!(
            store.delete_tool("user:nope", Some(&etag)).await,
            Err(HouseError::NotFound(_))
        ));
        assert!(matches!(
            store.delete_tool("user:nope", Some("*")).await,
            Err(HouseError::NotFound(_))
        ));
        // One item, not two: the duplicate POST changed nothing.
        let (bytes, _) = store.tools().await.unwrap();
        assert_eq!(serde_json::from_slice::<Vec<ToolLibraryEntry>>(&bytes).unwrap().len(), 1);
    }

    /// A guarded write with no validator, and one whose validator is no longer the served list
    /// (#321). Both must leave the house exactly as it was: the guard exists to stop the write, and
    /// a guard that refuses after the fact would be worse than none.
    #[tokio::test]
    async fn a_guarded_write_that_cannot_be_checked_is_refused_and_changes_nothing() {
        let (_dir, store) = store();
        store.create_tool(an_entry("user:abc")).await.unwrap();
        let (before, etag) = store.tools().await.unwrap();

        assert!(matches!(
            store.update_tool(an_entry("user:abc"), None).await,
            Err(HouseError::PreconditionRequired(_))
        ));
        assert!(matches!(
            store.delete_tool("user:abc", None).await,
            Err(HouseError::PreconditionRequired(_))
        ));

        // Somebody else writes. The validator the first client holds is now a version that is gone.
        store
            .update_tool(
                ToolLibraryEntry {
                    provenance: "calipers, 2026-10-09".to_string(),
                    ..an_entry("user:abc")
                },
                Some(&etag),
            )
            .await
            .unwrap();
        assert!(matches!(
            store.update_tool(an_entry("user:abc"), Some(&etag)).await,
            Err(HouseError::StalePrecondition(_))
        ));
        assert!(matches!(
            store.delete_tool("user:abc", Some(&etag)).await,
            Err(HouseError::StalePrecondition(_))
        ));
        // The stale write lost: the house holds the OTHER one's edit, and the count is unchanged.
        let (after, fresh) = store.tools().await.unwrap();
        assert_ne!(before, after);
        assert_ne!(etag, fresh);
        let entries: Vec<ToolLibraryEntry> = serde_json::from_slice(&after).unwrap();
        assert_eq!(entries[0].provenance, "calipers, 2026-10-09");

        // And the refused write was refused BEFORE anything moved: the etag it could not match is
        // still the etag being served.
        assert!(matches!(
            store.update_tool(an_entry("user:abc"), Some(&etag)).await,
            Err(HouseError::StalePrecondition(_))
        ));
    }

    /// The inventory guards on the INVENTORY's validator, not the tool list's (#321): the two
    /// documents are read, cached and edited separately, so a re-measured definition must not
    /// invalidate an edit to a cutter's count — and vice versa.
    #[tokio::test]
    async fn the_two_lists_guard_separately() {
        let (_dir, store) = store();
        store.create_tool(an_entry("user:abc")).await.unwrap();
        store.create_inventory(an_item("inv-1")).await.unwrap();
        let (_, tools) = store.tools().await.unwrap();
        let (_, inventory) = store.inventory().await.unwrap();
        assert_ne!(tools, inventory);

        // A tool write moves the tool list's validator and leaves the inventory's alone...
        store.create_tool(an_entry("user:def")).await.unwrap();
        let (_, tools_after) = store.tools().await.unwrap();
        let (_, inventory_after) = store.inventory().await.unwrap();
        assert_ne!(tools, tools_after);
        assert_eq!(inventory, inventory_after);

        // ...so an inventory write carrying the validator it read still succeeds afterwards.
        let mut more = an_item("inv-1");
        more.quantity = 3;
        store
            .update_inventory(more, Some(&inventory))
            .await
            .unwrap();
        // And the stale tool-list validator is refused for a tool write, as its own list moved too.
        assert!(matches!(
            store.update_tool(an_entry("user:abc"), Some(&tools)).await,
            Err(HouseError::StalePrecondition(_))
        ));
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
        assert_eq!(items[0].codes[0].value, "C1-BIT-INV-1");
        assert_eq!(etag, etag_for(&bytes));

        // Each guarded write carries the validator as it stands NOW — the update moves it, so the
        // delete reads it again rather than reusing the one the update consumed (#321).
        reopened.update_inventory(an_item("inv-1"), Some(&etag)).await.unwrap();
        let (_, served) = reopened.inventory().await.unwrap();
        reopened.delete_inventory("inv-1", Some(&served)).await.unwrap();
        let (bytes, _) = reopened.inventory().await.unwrap();
        assert_eq!(bytes, b"[]");
    }

    // #309's invariant, enforced where it cannot be bypassed (#320): the panel resolves a code to
    // ONE item and offers quantity + 1, which only means anything if a code names one cutter.
    #[tokio::test]
    async fn a_code_names_one_cutter() {
        let (_dir, store) = store();
        store.create_inventory(an_item("inv-1")).await.unwrap();

        let mut twin = an_item("inv-2");
        twin.codes[0].value = "C1-BIT-INV-1".to_string();
        let err = store.create_inventory(twin).await.unwrap_err();
        assert!(matches!(err, HouseError::Conflict(_)), "{err:?}");
        assert!(err.to_string().contains("C1-BIT-INV-1"), "{err}");

        // An UPDATE is held to the same rule, and the item's own codes are not a clash with itself.
        let mut mine = an_item("inv-1");
        mine.codes.push(Coded {
            symbology: "data_matrix".to_string(),
            value: "112111313812".to_string(),
        });
        let (_, guard) = store.inventory().await.unwrap();
        store.update_inventory(mine.clone(), Some(&guard)).await.unwrap();
        store.create_inventory(an_item("inv-3")).await.unwrap();
        let (_, guard) = store.inventory().await.unwrap();
        let mut theirs = an_item("inv-3");
        theirs.codes = mine.codes.clone();
        assert!(matches!(
            store.update_inventory(theirs, Some(&guard)).await,
            Err(HouseError::Conflict(_))
        ));

        // Two items exist, and neither write that clashed went through.
        let (bytes, _) = store.inventory().await.unwrap();
        let items: Vec<InventoryItem> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].codes.len(), 2);
    }

    // One code twice on ONE item is one code written twice, and a code with nothing in it names
    // nothing at all.
    #[tokio::test]
    async fn an_item_refuses_a_repeated_code_and_an_empty_one() {
        let (_dir, store) = store();
        let mut twice = an_item("inv-1");
        twice.codes.push(twice.codes[0].clone());
        assert!(matches!(
            store.create_inventory(twice).await,
            Err(HouseError::BadEntry(_))
        ));

        let mut blank = an_item("inv-2");
        blank.codes[0].value = "  ".to_string();
        assert!(matches!(
            store.create_inventory(blank).await,
            Err(HouseError::BadEntry(_))
        ));

        // An item that does not say when it was registered is one the client refuses (`addedAt` is
        // `min(1)`), so it is refused here — the same contract on both sides (#320).
        let mut undated = an_item("inv-3");
        undated.added_at = String::new();
        assert!(matches!(
            store.create_inventory(undated).await,
            Err(HouseError::BadEntry(_))
        ));

        let mut unnamed_origin = an_item("inv-4");
        unnamed_origin.origin = Some(Origin {
            id: String::new(),
            synced_at: None,
        });
        assert!(matches!(
            store.create_inventory(unnamed_origin).await,
            Err(HouseError::BadEntry(_))
        ));

        let (bytes, _) = store.inventory().await.unwrap();
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

    // — one document, two implementations (#320) ---------------------------------------------------

    /// The document BOTH sides read: `tests/unit/fixtures/house-doc.json`. Hand-written and
    /// synthetic on purpose — nothing vendor-derived is committed (`/Fabrication.md` §3, #186) — and
    /// the specimen the contract is checked against: this module must accept and serve it, and
    /// `tests/unit/houseContract.spec.ts` must parse what it serves.
    fn house_fixture() -> Vec<u8> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/unit/fixtures/house-doc.json");
        fs::read(&path).unwrap_or_else(|e| panic!("{} should be readable: {e}", path.display()))
    }

    #[tokio::test]
    async fn the_shared_house_fixture_is_accepted_and_served_whole() {
        let (dir, store) = store();
        store.import(&house_fixture()).await.unwrap();

        let (tools, _) = store.tools().await.unwrap();
        let entries: Vec<ToolLibraryEntry> = serde_json::from_slice(&tools).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
            ["user:1a2b3c4d5e", "user:6f7a8b9c0d"]
        );
        assert_eq!(entries[1].tool.name, "3.175*12mm Flat End(Metal) (clone)");
        // `origin` is the house's own bookkeeping and does not go on the wire — the wire shape is
        // `ToolLibraryEntry`, which the client's schema is written to.
        let raw: Vec<serde_json::Value> = serde_json::from_slice(&tools).unwrap();
        assert!(raw.iter().all(|e| e.get("origin").is_none()), "{tools:?}");

        let (inv, _) = store.inventory().await.unwrap();
        let items: Vec<InventoryItem> = serde_json::from_slice(&inv).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].quantity, 2);
        assert_eq!(items[0].codes[0].value, "C1-BIT-BALL-NOSE-1-4");

        // And the service would accept back what it exports: the fixture is a document, not a
        // body shaped for one endpoint.
        let exported = store.export().await.unwrap();
        let other = TempDir::new().unwrap();
        HouseStore::open(other.path().to_path_buf())
            .import(&exported)
            .await
            .unwrap();
        let reopened = fs::read_to_string(dir.path().join(HOUSE_FILE)).unwrap();
        assert!(reopened.contains("C1-BIT-BALL-NOSE-1-4"), "{reopened}");
        assert!(reopened.contains("user:6f7a8b9c0d"), "{reopened}");
    }

    /// The fixture with exactly one thing broken in it. The mutation is the point: each case below
    /// is a document this service used to accept and the client refused, which is how the whole
    /// house came to read `absent` with `/health` still saying ok (#320).
    fn broken_fixture(break_it: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let mut doc: serde_json::Value = serde_json::from_slice(&house_fixture()).unwrap();
        break_it(&mut doc);
        serde_json::to_vec(&doc).unwrap()
    }

    #[tokio::test]
    async fn an_import_the_client_would_refuse_is_refused_here() {
        let (dir, store) = store();
        let cases: Vec<(&str, Box<dyn FnOnce(&mut serde_json::Value)>)> = vec![
            (
                "one key, two rows (`ToolLibrarySchema` refuses a duplicate)",
                Box::new(|d| d["tools"][1]["key"] = d["tools"][0]["key"].clone()),
            ),
            (
                "a tool with no provenance (`provenance` is `min(1)`)",
                Box::new(|d| d["tools"][0]["provenance"] = serde_json::json!("")),
            ),
            (
                "a key outside the `user:` namespace (`validate_key`)",
                Box::new(|d| d["tools"][0]["key"] = serde_json::json!("cat:1a2b3c4d5e")),
            ),
            (
                "one id, two possession rows",
                Box::new(|d| {
                    let first = d["inventory"][0].clone();
                    d["inventory"].as_array_mut().unwrap().push(first);
                }),
            ),
            (
                "one code on two cutters — `code → the item` must be a function",
                Box::new(|d| {
                    let mut second = d["inventory"][0].clone();
                    second["id"] = serde_json::json!("inv-9z8y7x");
                    d["inventory"].as_array_mut().unwrap().push(second);
                }),
            ),
            (
                "an item that does not say when it was registered (`addedAt` is `min(1)`)",
                Box::new(|d| d["inventory"][0]["addedAt"] = serde_json::json!("")),
            ),
            (
                "an origin naming no catalogue row (`OriginSchema.id` is `min(1)`)",
                Box::new(|d| d["inventory"][0]["origin"]["id"] = serde_json::json!("")),
            ),
        ];
        for (why, break_it) in cases {
            let err = store.import(&broken_fixture(break_it)).await.unwrap_err();
            // Either refusal is a 400 to the caller; which one depends on whether the broken thing
            // is the key or the document around it.
            assert!(
                matches!(err, HouseError::BadKey(_) | HouseError::BadEntry(_)),
                "{why} was refused as {err:?}"
            );
            assert!(!err.to_string().is_empty(), "{why}: a refusal must say why");
            // WHOLE-OR-NOTHING: the store is still the empty house it started as.
            assert_eq!(store.tools().await.unwrap().0, b"[]", "{why}");
            assert_eq!(store.health().await.problems, Vec::<String>::new(), "{why}");
        }
        assert!(!dir.path().join(HOUSE_FILE).exists(), "nothing was written");
    }

    #[tokio::test]
    async fn a_house_file_with_a_key_this_build_does_not_know_is_refused_and_the_key_named() {
        // #339. A hand-edited `house.json` with a misspelled optional key (`orgin`) used to load
        // clean, and the next commit rewrote the file without it: a hand edit lost with no
        // `problem` to say so. Now it is refused like any other unreadable file — and the refusal
        // names the key, because "does not match its own schema" alone sends the user reading the
        // whole file. Every struct the document is made of is strict, so the key is caught at
        // whichever depth it was mistyped.
        let cases: Vec<(&str, Box<dyn FnOnce(&mut serde_json::Value)>)> = vec![
            ("orgin", Box::new(|d| d["tools"][0]["orgin"] = serde_json::json!({ "id": "x" }))),
            ("inventry", Box::new(|d| d["inventry"] = serde_json::json!([]))),
            ("qty", Box::new(|d| d["inventory"][0]["qty"] = serde_json::json!(2))),
            ("symbolgy", Box::new(|d| d["inventory"][0]["codes"][0]["symbolgy"] = serde_json::json!("qr"))),
            (
                "syncedOn",
                Box::new(|d| {
                    d["tools"][0]["origin"] = serde_json::json!({ "id": "x", "syncedOn": "2026" })
                }),
            ),
        ];
        for (key, break_it) in cases {
            let dir = TempDir::new().unwrap();
            let doc = broken_fixture(break_it);
            fs::write(dir.path().join(HOUSE_FILE), &doc).unwrap();
            let loaded = HouseStore::open(dir.path().to_path_buf());
            let h = loaded.health().await;
            assert_eq!(h.problems.len(), 1, "{key}: {:?}", h.problems);
            assert!(h.problems[0].contains(HOUSE_FILE), "{key}: {:?}", h.problems);
            assert!(h.problems[0].contains(key), "the key must be named: {:?}", h.problems);
            assert_eq!(loaded.tools().await.unwrap().0, b"[]", "{key}");
            assert!(matches!(
                loaded.create_tool(an_entry("user:abc")).await,
                Err(HouseError::Refused(_))
            ));
            // The user's bytes are exactly where they were: nothing rewrote the file.
            assert_eq!(fs::read(dir.path().join(HOUSE_FILE)).unwrap(), doc, "{key}");

            // The same document through the other door (#339): `/import` takes a house file too.
            let (_dir, fresh) = store();
            let err = fresh.import(&doc).await.unwrap_err();
            assert!(matches!(err, HouseError::BadEntry(_)), "{key}: {err:?}");
            assert!(err.to_string().contains(key), "{key}: {err}");
        }
    }

    #[tokio::test]
    async fn a_house_file_that_fails_its_own_rules_is_a_problem_and_not_a_served_house() {
        // The hand-edited case: it parses, and it is still a document the client would refuse. It
        // must be reported like any other unreadable file — reason in `/health`, nothing served,
        // every write refused, and the user's bytes left exactly where they are (#320).
        let dir = TempDir::new().unwrap();
        let doc = broken_fixture(|d| d["tools"][1]["key"] = d["tools"][0]["key"].clone());
        fs::write(dir.path().join(HOUSE_FILE), &doc).unwrap();

        let store = HouseStore::open(dir.path().to_path_buf());
        let h = store.health().await;
        assert_eq!(h.problems.len(), 1);
        assert!(h.problems[0].contains(HOUSE_FILE), "{:?}", h.problems);
        assert!(h.problems[0].contains("user:1a2b3c4d5e"), "{:?}", h.problems);
        // Not served: the client would refuse the body, so nothing gets one.
        assert_eq!(store.tools().await.unwrap().0, b"[]");
        assert!(matches!(
            store.create_tool(an_entry("user:abc")).await,
            Err(HouseError::Refused(_))
        ));
        assert_eq!(fs::read(dir.path().join(HOUSE_FILE)).unwrap(), doc);
    }

    /// No write leaves anything but the document behind (#321). The scan is over the DIRECTORY, not
    /// over a guessed name: the old form checked for a literal `house.json.tmp` and would have passed
    /// while each writer scattered its own leftovers through the house.
    #[test]
    fn an_atomic_write_leaves_no_temp_file_behind() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(HOUSE_FILE);
        write_atomic(&path, b"{\"kind\":\"casemaker-house\"}").unwrap();
        assert!(path.exists());
        // A second write replaces the first rather than failing on an existing destination — which
        // is the half of this that differs between platforms.
        write_atomic(&path, b"{\"kind\":\"casemaker-house\",\"tools\":[]}").unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            b"{\"kind\":\"casemaker-house\",\"tools\":[]}"
        );
        let leftovers: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != HOUSE_FILE)
            .collect();
        assert!(leftovers.is_empty(), "the temp files were left behind: {leftovers:?}");
    }

    /// Two writers (or two writes by one writer) must never aim at the same temp path (#321). If they
    /// did, the loser's rename would publish the winner's half-written bytes — the exact torn copy
    /// the whole atomic write exists to prevent.
    #[test]
    fn a_scratch_name_is_never_reused_and_never_the_destination() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(HOUSE_FILE);
        let a = scratch_sibling(&path);
        let b = scratch_sibling(&path);
        assert_ne!(a, b, "two writers were handed the same name");
        assert_ne!(a, path);
        assert_ne!(b, path);
        // A sibling, not a path in the system temp directory or anywhere else: a rename is only
        // atomic within one filesystem.
        for p in [&a, &b] {
            assert_eq!(p.parent(), path.parent());
            assert!(p.file_name().unwrap().to_string_lossy().starts_with("house.json."));
        }
    }

    /// ONE HOUSE, ONE PROCESS (#321). The lock is the thing `server::start` takes as proof, so what it
    /// must guarantee is exactly: a second holder cannot get it while the first lives, and it is free
    /// again the moment the first is dropped.
    #[test]
    fn the_house_lock_admits_one_holder_and_frees_on_drop() {
        let dir = TempDir::new().unwrap();
        // A house directory that does not exist yet is created rather than refused: the first launch
        // is precisely the launch that has no house.
        let nested = dir.path().join("house");
        let first = HouseLock::acquire(&nested).unwrap();
        assert_eq!(first.dir(), nested.as_path());
        assert!(nested.join(LOCK_FILE).exists());

        let second = HouseLock::acquire(&nested).unwrap_err();
        assert!(second.contains("already running"), "{second}");
        assert!(second.contains(&nested.display().to_string()), "{second}");

        drop(first);
        // The file is still there — nothing unlinks it — and the lock over it is free again. This is
        // why the file's mere existence is never treated as "a process is running".
        let third = HouseLock::acquire(&nested).unwrap();
        assert_eq!(third.dir(), nested.as_path());
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
        let note = report
            .notes
            .iter()
            .find(|n| n.text.contains("could not be read"))
            .unwrap_or_else(|| panic!("{:?}", report.notes));
        // A replaced file is a LOSS (#328): whatever it held is not coming back from this sync.
        assert_eq!(note.kind, crate::catalogue::SyncNoteKind::Loss);
        assert!(store.health().await.problems.is_empty());
        assert!(store.health().await.has_catalogue);
    }

    #[tokio::test]
    async fn the_last_sync_outlives_the_response_and_a_restart() {
        // #328. The report is one response; its counts and notes are kept in `catalogue.json` so a
        // restart — or a second client on the LAN — reads the same last sync from `/health`.
        let dir = TempDir::new().unwrap();
        let db = a_library(&dir);
        fs::write(dir.path().join(CATALOGUE_FILE), b"{ this is not json").unwrap();
        let store = store_syncing(&dir, &db);
        let report = store.sync_catalogue().await.unwrap();
        assert_eq!(report.notes.len(), 1, "{:?}", report.notes);

        let expected = SyncSummary {
            synced_at: report.synced_at.clone(),
            source: report.source.clone(),
            total: report.total,
            feed_rows: report.feed_rows,
            notes: report.notes.clone(),
        };
        assert_eq!(store.health().await.last_sync, Some(expected.clone()));

        // Round-tripped through the file, not just held in memory.
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join(CATALOGUE_FILE)).unwrap()).unwrap();
        assert_eq!(raw["lastSync"]["notes"][0]["kind"], serde_json::json!("loss"), "{raw:#}");
        assert!(raw["lastSync"].get("added").is_none(), "the diff lists are not stored: {raw:#}");
        let reopened = store_syncing(&dir, &db);
        assert_eq!(reopened.health().await.last_sync, Some(expected));

        // A second sync REPLACES it, notes included: the record is of the last sync, not of all.
        let again = store.sync_catalogue().await.unwrap();
        assert!(again.notes.is_empty(), "{:?}", again.notes);
        let h = store.health().await;
        assert_eq!(h.last_sync.as_ref().map(|s| s.notes.len()), Some(0));
        assert_eq!(h.last_sync.as_ref().and_then(|s| s.synced_at.clone()), again.synced_at);
    }

    #[tokio::test]
    async fn a_catalogue_file_from_before_last_sync_still_parses() {
        // #328, the other direction: `catalogue.json` written by a build that had no `lastSync` is
        // a catalogue whose last sync went unrecorded, not a problem (#320 is about shape, not
        // absence). Written by hand, because a `CatalogueDoc` of this build would write the key.
        let dir = TempDir::new().unwrap();
        let entry = a_catalogue_entry("019c049a-8169-7a1e-ace2-28e03809ce44");
        let doc = serde_json::json!({
            "kind": CATALOGUE_KIND,
            "schemaVersion": HOUSE_SCHEMA_VERSION,
            "syncedAt": "2026-10-08T12:00:00.000Z",
            "tools": [entry],
            "feeds": [],
        });
        fs::write(dir.path().join(CATALOGUE_FILE), serde_json::to_vec(&doc).unwrap()).unwrap();

        let store = HouseStore::open(dir.path().to_path_buf());
        let h = store.health().await;
        assert!(h.problems.is_empty(), "{:?}", h.problems);
        assert!(h.has_catalogue);
        assert_eq!(h.last_sync, None);
    }

    #[tokio::test]
    async fn a_catalogue_file_whose_entries_cannot_be_served_is_a_problem_and_an_empty_tier() {
        // #339. A parsed catalogue is not a servable one: an entry with a non-`cat:` key would go
        // out on `/tools`, the client would refuse the whole list, and the house would read absent
        // while `/health` said ok. The tier is empty instead, the reason is in `/health`, and the
        // user's own tools are still served — the house file was never the problem.
        let dir = TempDir::new().unwrap();
        let mut bad = a_catalogue_entry("019c049a-8169-7a1e-ace2-28e03809ce44");
        bad.key = "user:019c049a-8169-7a1e-ace2-28e03809ce44".to_string();
        let catalogue = CatalogueDoc {
            synced_at: Some("2026-10-08T12:00:00.000Z".to_string()),
            tools: vec![a_catalogue_entry("019c049a-8169-7a1e-ace2-28e03809ce45"), bad],
            ..CatalogueDoc::default()
        };
        fs::write(
            dir.path().join(CATALOGUE_FILE),
            serde_json::to_vec_pretty(&catalogue).unwrap(),
        )
        .unwrap();

        let store = HouseStore::open(dir.path().to_path_buf());
        let h = store.health().await;
        assert_eq!(h.problems.len(), 1, "{:?}", h.problems);
        assert!(h.problems[0].contains(CATALOGUE_FILE), "{:?}", h.problems);
        assert!(!h.has_catalogue, "a refused tier is an empty one, not a half-served one");
        store.create_tool(an_entry("user:abc")).await.unwrap();
        let (bytes, _) = store.tools().await.unwrap();
        let entries: Vec<ToolLibraryEntry> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
            vec!["user:abc"]
        );
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

    #[tokio::test]
    async fn a_feeds_query_that_fails_refuses_the_sync_and_leaves_the_matrix_alone() {
        // #326, at the store's edge: the reader's refusal has to travel as a REFUSAL, and the matrix
        // already stored has to survive it. Before the fix this sync SUCCEEDED — a renamed column
        // made the prepare fail, the failure was read as "no feeds table", and 1 328 starting numbers
        // became an empty array with a clean report.
        use crate::catalogue::fixture::{material, put_feed, Feed};

        let dir = TempDir::new().unwrap();
        let db = a_library(&dir);
        let conn = rusqlite::Connection::open(&db).unwrap();
        material(&conn, "mat-1", "Hardwood");
        let cutter_id: String = conn
            .query_row("SELECT cutterId FROM t_MakeraCutterList LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        put_feed(
            &conn,
            &Feed {
                id: "prop-1".to_string(),
                material_id: "mat-1".to_string(),
                cutter_id,
                rpm: Some(12_000),
                feed: Some(900),
                plunge: Some(300.0),
                step_down: Some(1.2),
            },
        );
        drop(conn);

        let store = store_syncing(&dir, &db);
        let report = store.sync_catalogue().await.unwrap();
        assert_eq!(report.feed_rows, 1);

        // Studio updates itself and renames a column this build reads.
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "ALTER TABLE t_MakeraCutterProperties RENAME COLUMN plungeFeedRate TO plungeFeed_new",
            [],
        )
        .unwrap();
        drop(conn);

        let err = store.sync_catalogue().await.unwrap_err();
        assert!(matches!(err, HouseError::Refused(_)), "{err:?}");
        assert!(err.to_string().contains("plungeFeedRate"), "{err}");
        assert_eq!(
            store.health().await.feed_rows,
            1,
            "a refused sync must not empty the matrix it refused over"
        );
    }

    #[tokio::test]
    async fn a_write_that_fails_leaves_the_problem_it_would_have_cleared() {
        // #326: `catalogue_problem` was `take()`n before `write_atomic`, so a sync whose write failed
        // cleared the one thing telling the user their catalogue file could not be read — and the
        // next successful sync lost the note about the file it replaced.
        let dir = TempDir::new().unwrap();
        let db = a_library(&dir);
        fs::write(dir.path().join(CATALOGUE_FILE), b"{ this is not json").unwrap();
        let store = store_syncing(&dir, &db);
        assert_eq!(store.health().await.problems.len(), 1);

        // The destination cannot be replaced: a directory stands where the file was.
        fs::remove_file(dir.path().join(CATALOGUE_FILE)).unwrap();
        fs::create_dir(dir.path().join(CATALOGUE_FILE)).unwrap();

        let err = store.sync_catalogue().await.unwrap_err();
        assert!(matches!(err, HouseError::Io(_)), "{err:?}");

        let h = store.health().await;
        assert_eq!(
            h.problems.len(),
            1,
            "the problem must survive a write that never landed: {:?}",
            h.problems
        );
    }

    #[tokio::test]
    async fn a_sync_that_empties_the_feed_matrix_says_so() {
        // #326, the note half. The tools guard refuses an empty import because an empty list of
        // cutters leaves nothing to cut with; an empty FEED matrix only costs the starting numbers,
        // so the sync lands and the loss is named. The distinction matters because this sync is also
        // the only way to replace a catalogue file that cannot be read.
        use crate::catalogue::fixture::{material, put_feed, Feed};

        let dir = TempDir::new().unwrap();
        let full = a_library(&dir);
        let conn = rusqlite::Connection::open(&full).unwrap();
        material(&conn, "mat-1", "Hardwood");
        let cutter_id: String = conn
            .query_row("SELECT cutterId FROM t_MakeraCutterList LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        put_feed(
            &conn,
            &Feed {
                id: "prop-1".to_string(),
                material_id: "mat-1".to_string(),
                cutter_id,
                rpm: Some(12_000),
                feed: Some(900),
                plunge: Some(300.0),
                step_down: Some(1.2),
            },
        );
        drop(conn);

        let store = store_syncing(&dir, &full);
        assert_eq!(store.sync_catalogue().await.unwrap().feed_rows, 1);

        // A Studio build that never held feeds: the tool tier is intact and the matrix is gone.
        let other = TempDir::new().unwrap();
        let bare = a_library(&other);
        rusqlite::Connection::open(&bare)
            .unwrap()
            .execute("DROP TABLE t_MakeraCutterProperties", [])
            .unwrap();

        let store = store_syncing(&dir, &bare);
        let report = store.sync_catalogue().await.unwrap();
        assert_eq!(report.feed_rows, 0);
        assert_eq!(report.notes.len(), 1, "{:?}", report.notes);
        assert!(
            report.notes[0].text.contains("emptied the feed matrix"),
            "{:?}",
            report.notes
        );
        // An emptied matrix is the one feed note that is a LOSS (#328), and it is kept with the
        // catalogue so `/health` still says so after a restart.
        assert_eq!(report.notes[0].kind, crate::catalogue::SyncNoteKind::Loss);
        let kept = store_syncing(&dir, &bare).health().await.last_sync.unwrap();
        assert_eq!(kept.notes, report.notes);
        assert_eq!(kept.feed_rows, 0);
        // A FIRST sync over a DB with no feed table says nothing, because nothing was lost.
        let fresh = TempDir::new().unwrap();
        let store = store_syncing(&fresh, &bare);
        let first = store.sync_catalogue().await.unwrap();
        assert_eq!(first.feed_rows, 0);
        assert!(first.notes.is_empty(), "{:?}", first.notes);
    }
}
