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
// SINCE #412 THE USER'S DOCUMENT IS `location.json`, NOT `house.json`. The two user tiers moved into
// the location (`location.rs`, decision Q2) beside the machine records; this store keeps that
// document, serves `/tools` and `/inventory` from it byte-for-byte as before, and migrates a
// `house.json` into it once, on open, leaving the old file where it was. Wherever this file says
// "the house file" below, the location is what is now written; the rules are unchanged.
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
use crate::feeds::FeedRow;
use crate::stock::StockItem;
use crate::location::{
    LocationDoc, MachineRecord, LOCATION_FILE, LOCATION_KIND, LOCATION_SCHEMA_VERSION,
};
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
/// not have the configured port (`server.rs` fell back to an ephemeral one) and opened the same
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
/// `ToolLibraryEntrySchema` is the only thing that reads. The one exception is `metalDuty`, which
/// `tools_bytes` adds beside the entry (#398, `ServedEntry`).
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
    /// The copies the operator has described (#415): condition, where each is. At most `quantity`;
    /// a copy with no entry has no condition set and is in its box (`tool_copy.rs`).
    ///
    /// LEFT OUT OF THE JSON WHEN EMPTY, unlike every other field here (#415 review): an item that
    /// describes no copies and states no fits is then byte-for-byte what it was before #415, so an
    /// export of such an inventory still imports into an older build. An item that DOES carry either
    /// is refused by an older build (`deny_unknown_fields`) — that break is the honest one: the older
    /// build would otherwise drop the conditions on its next write.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub copies: Vec<crate::tool_copy::ToolCopy>,
    /// The machines this cutter's shank fits a collet of (#415), by machine id. `None` is "not
    /// stated", which is a different answer from "fits none" (`Some([])`). Left out when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collet_fits: Option<Vec<String>>,
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
        crate::tool_copy::validate_copies(&self.id, self.quantity, &self.copies, self.collet_fits.as_deref())?;
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
    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        validate_tiers(&self.tools, &self.inventory)
    }
}

/// The house document's rule, over the two tiers wherever they are kept (#412): `house.json` used
/// to be the only place, and `location.json` now holds the same two lists under exactly this rule.
pub(crate) fn validate_tiers(tools: &[UserTool], inventory: &[InventoryItem]) -> Result<(), HouseError> {
    let mut keys = HashSet::new();
    for t in tools {
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
    for i in inventory {
        i.validate()?;
        if let Some(m) = crate::tool_copy::machine_clash(inventory, i) {
            return Err(HouseError::BadEntry(format!(
                "two cutters both have a copy in machine {m} — a spindle holds one cutter"
            )));
        }
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

/// What `GET /api/v1/health` answers (#306's shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub schema_version: u32,
    /// #566 — the build this service IS, as `build.rs` stamped it at compile time:
    /// `git describe --tags --always --dirty` (`v1.0.0-825-gbea18572`, `…-dirty`), or `unknown`
    /// when it was compiled without git. The crate version cannot answer this — every build reads
    /// 1.0.0 — and an installed `.deb` has no other way to say which commit it came from.
    /// Defaulted so this build's `Health` still deserialises a report written before the field.
    #[serde(default = "unknown_build")]
    pub build: String,
    pub has_catalogue: bool,
    /// How many feed rows the stored catalogue holds (#310). A catalogue synced before the feed tier
    /// existed reports `has_catalogue: true` with `feedRows: 0`, which is exactly the state a re-sync
    /// fixes — so the two numbers answer different questions and a client shows both.
    pub feed_rows: usize,
    /// How many vendor stock sizes the stored catalogue holds (#446). The same shape of answer as
    /// `feed_rows`: a catalogue synced before the sizes were read reports 0 until a re-sync, and the
    /// two counts answer different questions.
    #[serde(default)]
    pub material_spec_rows: usize,
    pub catalogue_synced_at: Option<String>,
    /// What the last sync came to (#328): its counts and its notes, kept in `catalogue.json` so the
    /// desktop and a LAN browser read the same answer after a restart. `None` until the first sync,
    /// and for a catalogue file written before the field existed.
    pub last_sync: Option<SyncSummary>,
    /// One sentence per document that could not be read. A non-empty list is also why writes are
    /// refused: the store will not overwrite a file it could not understand.
    pub problems: Vec<String>,
    /// One sentence per thing worth knowing that does NOT stop a write (#412): today, a `house.json`
    /// written after `location.json` — an older build's edits, which this build never reads.
    /// Defaulted, so a reader from before the field sees an empty list.
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// The build string a report written before #566 carries: the field is absent, and the honest
/// answer is that it does not know rather than a version nobody built.
fn unknown_build() -> String {
    "unknown".to_string()
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
    let mut entries: Vec<ServedEntry> = inner
        .catalogue
        .tools
        .iter()
        .map(|e| ServedEntry { entry: ToolLibraryEntry::from(e), metal_duty: e.extras.metal_duty })
        .collect();
    entries.extend(
        inner
            .location
            .tools
            .iter()
            .map(|t| ServedEntry { entry: ToolLibraryEntry::from(t), metal_duty: None }),
    );
    json_bytes(&entries)
}

/// One `/tools` row as served (#398): the {@link ToolLibraryEntry} every tier shares, plus the one
/// catalogue column the client reads, `metalDuty`. It sits BESIDE `tool`, not in it (#212 "do not
/// widen `Tool`"), and only a `cat:` row has one: a `user:` row has no vendor column to state it,
/// so the key is omitted rather than sent as a `null` that would read like a vendor's blank.
///
/// What the real install's column holds was read off a sync before this was wired (#398): `0` on
/// exactly the Non Metal groups, `1` on the metal line AND on every corn, drill, thread and chamfer
/// row — "rated for metal", not "on the metal line". The client reads it as such; this only carries
/// it. The rest of the extras and the `contentHash` stay off the wire.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServedEntry {
    #[serde(flatten)]
    entry: ToolLibraryEntry,
    #[serde(skip_serializing_if = "Option::is_none")]
    metal_duty: Option<i64>,
}

/// The `/inventory` body, ordered by `added_at` so a list a UI renders does not reshuffle when a
/// write lands somewhere in the middle of the file. Same free-function rule as `tools_bytes`.
fn inventory_bytes(inner: &Inner) -> Result<Vec<u8>, HouseError> {
    let mut items = inner.location.inventory.clone();
    items.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.id.cmp(&b.id)));
    json_bytes(&items)
}

/// The `/stock` body (#413): the shelf in the order it was added, so a list a UI renders does not
/// reshuffle on a write. Same free-function rule as `tools_bytes`.
fn stock_bytes(inner: &Inner) -> Result<Vec<u8>, HouseError> {
    let mut items = inner.location.stock.clone();
    items.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.id.cmp(&b.id)));
    json_bytes(&items)
}

/// The `/feed-table` body (#450): the rows in the order they are stored. NOT sorted, unlike the
/// shelf: `entryFor` takes the FIRST matching row, and two rows are allowed to TOUCH at a shared
/// diameter boundary precisely so the earlier one wins there; re-ordering here would change which
/// row a cutter on that boundary takes.
fn feed_table_bytes(inner: &Inner) -> Result<Vec<u8>, HouseError> {
    json_bytes(&inner.location.feeds)
}

/// The `/defaults` body: the shop's defaults, keyed and sorted (a `BTreeMap`), so the bytes — and
/// the `ETag` — depend only on the content.
fn defaults_bytes(inner: &Inner) -> Result<Vec<u8>, HouseError> {
    json_bytes(&inner.location.defaults)
}

/// The `/location` body (#412): the location's identity and machines, without the tool tiers. Same
/// free-function rule as `tools_bytes`, for the same reason — a guarded machine write needs it while
/// it holds the write guard.
fn location_bytes(inner: &Inner) -> Result<Vec<u8>, HouseError> {
    json_bytes(&inner.location.view())
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
///
/// `version` is the document's OWN version (#412): the house and the catalogue are
/// `HOUSE_SCHEMA_VERSION`, the location is `LOCATION_SCHEMA_VERSION`, and the two move independently.
/// #597 — the fixture list moved from each machine to the location's `accessories`. Hoist once, on
/// read: if the location has no `accessories` and a machine still carries `bedFixtures`, move them up
/// and check each out to its machine. Idempotent (the `accessories` key is the marker).
fn hoist_bed_fixtures(value: &mut serde_json::Value) {
    let Some(obj) = value.as_object_mut() else { return };
    if obj.contains_key("accessories") {
        return;
    }
    let Some(machines) = obj.get_mut("machines").and_then(|m| m.as_array_mut()) else { return };
    let mut accessories: Vec<serde_json::Value> = Vec::new();
    for machine in machines.iter_mut() {
        let Some(m) = machine.as_object_mut() else { continue };
        let machine_id = m.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        let since = m.get("updatedAt").and_then(|u| u.as_str()).unwrap_or("").to_string();
        let Some(fixtures) = m.get_mut("bedFixtures").and_then(|f| f.as_array_mut()) else { continue };
        for fixture in fixtures.drain(..) {
            let mut acc = fixture.clone();
            if let Some(a) = acc.as_object_mut() {
                a.insert(
                    "whereabouts".into(),
                    serde_json::json!({ "kind": "machine", "machineId": machine_id, "since": since }),
                );
                a.insert(
                    "history".into(),
                    serde_json::json!([{ "at": since, "what": "hoisted from the machine bed fixtures" }]),
                );
            }
            accessories.push(acc);
        }
        m.remove("bedFixtures");
    }
    if !accessories.is_empty() {
        obj.insert("accessories".into(), serde_json::Value::Array(accessories));
    }
}

fn read_doc<T: for<'de> Deserialize<'de>>(
    path: &Path,
    kind: &str,
    version: u32,
    migrate: Option<fn(&mut serde_json::Value)>,
) -> Result<Option<T>, String> {
    // `try_exists`, not `exists` (#412 review): `exists` reads "could not tell" — a permission
    // error, a dead network share — as "not there", and the caller then writes a fresh empty
    // location over a file it simply could not see. An unanswerable question is a problem.
    match path.try_exists() {
        Ok(false) => return Ok(None),
        Ok(true) => {}
        Err(e) => return Err(format!("{}: cannot tell whether it exists: {e}", path.display())),
    }
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("{} is not readable JSON: {e}", path.display()))?;
    let file_kind = value.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if file_kind != kind {
        return Err(format!(
            "{} says it is {:?}; this file must be {kind:?}",
            path.display(),
            file_kind
        ));
    }
    let found = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if found != u64::from(version) {
        return Err(format!(
            "{} is version {found}; this build reads version {version}",
            path.display()
        ));
    }
    if let Some(migrate) = migrate {
        migrate(&mut value);
    }
    let doc: T = serde_json::from_value(value)
        .map_err(|e| format!("{} does not match its own schema: {e}", path.display()))?;
    Ok(Some(doc))
}

struct Inner {
    /// The user's own document (#412): the location, which holds the tool tiers `house.json` did.
    location: LocationDoc,
    catalogue: CatalogueDoc,
    /// Why the user's document could not be read — `location.json`, or the `house.json` it would
    /// have been migrated from — if it could not. Non-empty ⇒ every write is refused.
    location_problem: Option<String>,
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
    /// Where a power switch's token is kept (#416): the OS store in the app, a memory one in tests.
    secrets: std::sync::Arc<dyn crate::power::SecretStore>,
    /// What is known about a `house.json` changed after the migration (#412 review), mirrored in
    /// `house-watch.json` so it survives a restart. See `stale_house_warning`.
    house_watch: std::sync::Mutex<Option<HouseWatch>>,
}

/// The secure store a store opens with. In a TEST build it is always the in-memory one, so no test —
/// whatever it calls — can reach the real Credential Manager (#416).
fn default_secrets() -> std::sync::Arc<dyn crate::power::SecretStore> {
    #[cfg(test)]
    return std::sync::Arc::new(crate::power::MemorySecretStore::default());
    #[cfg(not(test))]
    return std::sync::Arc::new(crate::power::OsSecretStore);
}

/// What `GET /api/v1/power/:id` answers (#416). Never the token: only whether one is saved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    /// The configured switch, or null — the default, and then nothing else here means anything.
    pub switch: Option<crate::power::PowerSwitch>,
    pub has_token: bool,
    /// The plug as the provider reported it just now, when it could be asked.
    pub state: Option<crate::power::PlugState>,
    /// Why the state could not be read, in a sentence that never contains the token.
    pub problem: Option<String>,
}

/// The file the stale-`house.json` state is kept in, beside the documents. Ours, not the user's.
const HOUSE_WATCH_FILE: &str = "house-watch.json";

/// A `house.json` seen modified after `location.json`: its modification time (nanoseconds since the
/// epoch) and whether the user has dealt with it — dismissed the warning, or imported a house file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HouseWatch {
    house_modified: u64,
    acknowledged: bool,
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
        let (location, location_problem) = Self::load_location(&dir);
        let catalogue_path = dir.join(CATALOGUE_FILE);
        let (catalogue, catalogue_problem) =
            match read_doc::<CatalogueDoc>(&catalogue_path, CATALOGUE_KIND, HOUSE_SCHEMA_VERSION, None) {
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
        let house_watch = fs::read(dir.join(HOUSE_WATCH_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice::<HouseWatch>(&b).ok());
        let store = HouseStore {
            dir,
            studio_db,
            inner: RwLock::new(Inner {
                location,
                catalogue,
                location_problem,
                catalogue_problem,
            }),
            house_watch: std::sync::Mutex::new(house_watch),
            secrets: default_secrets(),
        };
        // Looked for at open too, BEFORE anything can write the location: an older build cannot run
        // beside this one (the lock), so its edits are always made while this one is closed, and
        // the first write after opening would otherwise make `location.json` the newer file.
        let _ = store.stale_house_warning();
        store
    }

    /// The user's document, and why it could not be read if it could not (#412).
    ///
    /// `location.json` first: if it is there it is the authority, readable or not — an unreadable
    /// location is a problem, and `house.json` is NOT consulted behind it, because serving the old
    /// file would quietly undo every write made since the migration. If it is absent, a readable
    /// and valid `house.json` is migrated into a new location, which is written at once; the old
    /// file is left exactly where it is. An unreadable or invalid `house.json` is the problem
    /// instead, nothing is written, and every write is refused until it is dealt with by hand —
    /// the rule `house.json` always had (#320, #339).
    fn load_location(dir: &Path) -> (LocationDoc, Option<String>) {
        let location_path = dir.join(LOCATION_FILE);
        match read_doc::<LocationDoc>(&location_path, LOCATION_KIND, LOCATION_SCHEMA_VERSION, Some(hoist_bed_fixtures)) {
            // Parsing is not enough (#320): a hand-edited document can parse and still hold a
            // duplicate key or a tool the client refuses.
            Ok(Some(mut doc)) => {
                // A location from before the shop defaults (or before a seed this build adds) reads
                // the seed values, in memory; the next write stores them (`defaults.rs`). The feeds
                // table follows the same rule (#450 slice 3): a location written before the table
                // existed is served the twelve starting rows — labelled `seeded`, unmeasured — rather
                // than refusing every job until the user writes one.
                crate::defaults::add_missing_seeds(&mut doc.defaults);
                crate::feeds::add_missing_seeds(&mut doc.feeds);
                return match doc.validate() {
                    Ok(()) => (doc, None),
                    Err(e) => {
                        let why = format!("{} cannot be served: {e}", location_path.display());
                        log::warn!("house service: {why}");
                        (LocationDoc::fresh(), Some(why))
                    }
                }
            }
            Ok(None) => {}
            Err(e) => {
                log::warn!("house service: {e}");
                return (LocationDoc::fresh(), Some(e));
            }
        }

        let house_path = dir.join(HOUSE_FILE);
        match read_doc::<HouseDoc>(&house_path, HOUSE_KIND, HOUSE_SCHEMA_VERSION, None) {
            Ok(Some(house)) => match house.validate() {
                Ok(()) => {
                    let location = LocationDoc::from_house(house, HOUSE_FILE);
                    // Written now, so the migration happens once and `location.json` is the marker.
                    // A failed write is not fatal: the location is served from memory and the first
                    // write through `commit` lands it — the same file, the same rows.
                    Self::write_location_now(&location_path, &location);
                    (location, None)
                }
                Err(e) => {
                    let why = format!("{} cannot be served: {e}", house_path.display());
                    log::warn!("house service: {why}");
                    (LocationDoc::fresh(), Some(why))
                }
            },
            // A first run. The empty location is written now rather than at the first write, so its
            // id is the same across restarts from the start (#412 review: an id minted per open
            // would change under any client that read it). A failed write is not fatal, as above.
            Ok(None) => {
                let location = LocationDoc::fresh();
                Self::write_location_now(&location_path, &location);
                (location, None)
            }
            Err(e) => {
                log::warn!("house service: {e}");
                (LocationDoc::fresh(), Some(e))
            }
        }
    }

    /// Write a location at open — the migration's and the first run's. Logged, never fatal: the
    /// document is served from memory and the first `commit` lands it.
    fn write_location_now(path: &Path, location: &LocationDoc) {
        match serde_json::to_vec_pretty(location) {
            Ok(bytes) => {
                if let Err(e) = write_atomic(path, &bytes) {
                    log::warn!("house service: could not write {}: {e}", path.display());
                }
            }
            Err(e) => log::warn!("house service: could not serialize the location: {e}"),
        }
    }

    pub async fn health(&self) -> Health {
        let inner = self.inner.read().await;
        Health {
            ok: true,
            schema_version: HOUSE_SCHEMA_VERSION,
            // #566 — the commit this binary was built from, stamped by `build.rs`.
            build: env!("CM_BUILD").to_string(),
            has_catalogue: !inner.catalogue.tools.is_empty(),
            feed_rows: inner.catalogue.feeds.len(),
            material_spec_rows: inner.catalogue.material_specs.len(),
            catalogue_synced_at: inner.catalogue.synced_at.clone(),
            last_sync: inner.catalogue.last_sync.clone(),
            problems: [&inner.location_problem, &inner.catalogue_problem]
                .iter()
                .filter_map(|p| (*p).clone())
                .collect(),
            warnings: self.stale_house_warning().into_iter().collect(),
        }
    }

    /// A `house.json` modified AFTER `location.json` (#412 review). The migration is one-way, so an
    /// older build that still writes `house.json` writes into a file this build never reads again —
    /// its edits would vanish without a word. A warning and not a problem: the location is still the
    /// authority, and refusing writes would not bring the older build's edits back.
    ///
    /// IT PERSISTS UNTIL IT IS DEALT WITH (re-review). Comparing modification times alone would hide
    /// it at this build's next write, which makes `location.json` the newer file again. So the first
    /// sighting is RECORDED (`house-watch.json`, with the `house.json` time it was seen at) and the
    /// warning stays until the user dismisses it or imports a house file. A `house.json` changed
    /// again after that — a different modification time — is a new sighting.
    fn stale_house_warning(&self) -> Option<String> {
        let nanos = |name: &str| {
            fs::metadata(self.dir.join(name))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as u64)
        };
        let mut watch = self.house_watch.lock().unwrap_or_else(|e| e.into_inner());
        if let (Some(house), Some(location)) = (nanos(HOUSE_FILE), nanos(LOCATION_FILE)) {
            let seen_before = watch.map(|w| w.house_modified);
            let changed_since_seen = seen_before.is_some_and(|t| t != house);
            if (house > location && seen_before != Some(house)) || changed_since_seen {
                let next = HouseWatch { house_modified: house, acknowledged: false };
                self.save_watch(&next);
                *watch = Some(next);
            }
        }
        match *watch {
            Some(w) if !w.acknowledged => Some(format!(
                "{HOUSE_FILE} was changed after {LOCATION_FILE} — by an older Case Maker build, most \
                 likely. This build reads only {LOCATION_FILE}, so those changes are not in your \
                 tools: re-enter them here, or import that {HOUSE_FILE} (it replaces the tools and \
                 inventory and keeps the machine)"
            )),
            _ => None,
        }
    }

    /// The user has dealt with the stale `house.json` — dismissed the warning, or imported a house
    /// file. Recorded against the `house.json` time it was seen at, so only a NEW change raises it.
    pub fn acknowledge_house_warning(&self) {
        let mut watch = self.house_watch.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = watch.as_mut() {
            w.acknowledged = true;
            let copy = *w;
            self.save_watch(&copy);
        }
    }

    /// Logged, never fatal: losing the record only means the warning is judged afresh next time.
    fn save_watch(&self, watch: &HouseWatch) {
        match serde_json::to_vec(watch) {
            Ok(bytes) => {
                if let Err(e) = write_atomic(&self.dir.join(HOUSE_WATCH_FILE), &bytes) {
                    log::warn!("house service: could not record the house.json warning: {e}");
                }
            }
            Err(e) => log::warn!("house service: could not serialize the house.json warning: {e}"),
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

    /// The vendor's purchasable stock sizes (#446), with its `ETag`. Its own document for the same
    /// reason as the feeds: a client that only wants the sizes does not parse the feed matrix, and a
    /// sync that changes one does not move the other's `ETag`. An empty array is a catalogue whose
    /// library has no `t_MaterialSpecs` — a normal answer.
    pub async fn material_specs(&self) -> Result<(Vec<u8>, String), HouseError> {
        let inner = self.inner.read().await;
        let bytes = json_bytes(&inner.catalogue.material_specs)?;
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
        Self::writable(&inner.location_problem)?;
        if inner.location.tools.iter().any(|t| t.key == entry.key) {
            return Err(HouseError::Conflict(format!(
                "{} is already in the house",
                entry.key
            )));
        }
        let mut next = inner.location.clone();
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
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&tools_bytes(&inner)?), if_match, "the tool list")?;
        let mut next = inner.location.clone();
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
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&tools_bytes(&inner)?), if_match, "the tool list")?;
        let mut next = inner.location.clone();
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
        Self::writable(&inner.location_problem)?;
        if inner.location.inventory.iter().any(|i| i.id == item.id) {
            return Err(HouseError::Conflict(format!(
                "{} is already registered",
                item.id
            )));
        }
        if let Some(code) = clashing_code(&inner.location.inventory, &item) {
            return Err(HouseError::Conflict(format!(
                "{code} is already on another cutter — change that one's quantity instead of \
                 registering a second"
            )));
        }
        if let Some(m) = crate::tool_copy::machine_clash(&inner.location.inventory, &item) {
            return Err(HouseError::Conflict(format!(
                "another cutter already has a copy in machine {m} — move that one to its box first"
            )));
        }
        let mut next = inner.location.clone();
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
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&inventory_bytes(&inner)?), if_match, "the inventory")?;
        // Existence first: an id nobody registered is a NOT FOUND whatever codes it carries.
        if !inner.location.inventory.iter().any(|i| i.id == item.id) {
            return Err(HouseError::NotFound(format!(
                "{} is not registered",
                item.id
            )));
        }
        if let Some(code) = clashing_code(&inner.location.inventory, &item) {
            return Err(HouseError::Conflict(format!(
                "{code} is already on another cutter"
            )));
        }
        if let Some(m) = crate::tool_copy::machine_clash(&inner.location.inventory, &item) {
            return Err(HouseError::Conflict(format!(
                "another cutter already has a copy in machine {m} — move that one to its box first"
            )));
        }
        let mut next = inner.location.clone();
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
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&inventory_bytes(&inner)?), if_match, "the inventory")?;
        let mut next = inner.location.clone();
        let before = next.inventory.len();
        next.inventory.retain(|i| i.id != id);
        if next.inventory.len() == before {
            return Err(HouseError::NotFound(format!("{id} is not registered")));
        }
        self.commit(&mut inner, next)
    }

    /// The location without its tool tiers (#412) — id, name, machines — with the `ETag` a machine
    /// write is guarded on. The tiers have their own endpoints and their own validators.
    ///
    /// REFUSED while the user's document cannot be read (#412 review): the store holds a stand-in
    /// with a fresh id then, and serving it would show a brand-new empty location — a different one
    /// on every restart — instead of the file the user has and cannot use. The refusal carries the
    /// problem's own sentence, so the Machines card can show it.
    pub async fn location(&self) -> Result<(Vec<u8>, String), HouseError> {
        let inner = self.inner.read().await;
        Self::writable(&inner.location_problem)?;
        let bytes = location_bytes(&inner)?;
        let etag = etag_for(&bytes);
        Ok((bytes, etag))
    }

    /// Create or replace one machine record, by id (#412). GUARDED on the location's `ETag`, as the
    /// tool and inventory writes are on theirs (#321): a machine save based on a location somebody
    /// else has since changed is refused rather than winning silently. An upsert rather than a
    /// POST/PATCH pair, because the record is one statement about one machine and the client mints
    /// its id — the guard, not the key, is what stops two windows from overwriting each other.
    pub async fn put_machine(
        &self,
        record: MachineRecord,
        if_match: Option<&str>,
    ) -> Result<(), HouseError> {
        record.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&location_bytes(&inner)?), if_match, "the location")?;
        let mut next = inner.location.clone();
        let mut record = record;
        match next.machines.iter_mut().find(|m| m.id == record.id) {
            Some(existing) => {
                // The power switch (#416), the wasteboard (#417) and the finished programs (#419
                // §4.5) have their OWN endpoints: a machine PUT — the settings write-through — keeps
                // what is stored, whatever its body says, so a window that has not read them cannot
                // wipe them.
                record.power = existing.power.clone();
                record.wasteboard = existing.wasteboard.clone();
                record.finished_programs = existing.finished_programs.clone();
                // The bed (#510) is written by the client's one-time migration and, later, by the
                // profile UI. An OLDER client sends no bed keys at all, and must not wipe them —
                // but the migration itself arrives as a key-bearing PUT, so the rule is "absent
                // keeps what is stored" rather than "always keep", as power and the wasteboard do:
                // those have their own endpoints, the bed does not yet.
                if record.bed_profiles.is_none() {
                    record.bed_profiles = existing.bed_profiles.clone();
                }
                if record.active_bed_profile_id.is_none() {
                    record.active_bed_profile_id = existing.active_bed_profile_id.clone();
                }
                *existing = record;
            }
            None => {
                record.power = None;
                record.wasteboard = None;
                record.finished_programs = Vec::new();
                record.bed_profiles = None;
                record.active_bed_profile_id = None;
                next.machines.push(record);
            }
        }
        self.commit(&mut inner, next)
    }

    /// #601 — create or replace one accessory record (a register, an edit, a measurement, a
    /// check-out). GUARDED on the location's `ETag`, as a machine write is. The whole document is
    /// validated after the change, so a record that leaves the location unreadable is refused
    /// rather than committed.
    pub async fn put_accessory(
        &self,
        record: crate::location::FixtureRecord,
        if_match: Option<&str>,
    ) -> Result<(), HouseError> {
        record.validate("the location")?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&location_bytes(&inner)?), if_match, "the location")?;
        let mut next = inner.location.clone();
        match next.accessories.iter_mut().find(|a| a.id == record.id) {
            Some(existing) => *existing = record,
            None => next.accessories.push(record),
        }
        next.validate()?;
        self.commit(&mut inner, next)
    }

    /// #601 — retire one accessory record. Guarded as `put_accessory` is; the whole document is
    /// validated after the removal, so an accessory a bed placement still names is refused.
    pub async fn delete_accessory(&self, id: &str, if_match: Option<&str>) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&location_bytes(&inner)?), if_match, "the location")?;
        let mut next = inner.location.clone();
        if !next.accessories.iter().any(|a| a.id == id) {
            return Err(HouseError::NotFound(format!("{id} is not among the accessories")));
        }
        next.accessories.retain(|a| a.id != id);
        next.validate()?;
        self.commit(&mut inner, next)
    }

    /// The machine's switch config, or why there is none to act on.
    async fn switch_of(&self, machine_id: &str) -> Result<Option<crate::power::PowerSwitch>, HouseError> {
        let inner = self.inner.read().await;
        Self::writable(&inner.location_problem)?;
        let machine = inner
            .location
            .machines
            .iter()
            .find(|m| m.id == machine_id)
            .ok_or_else(|| HouseError::NotFound(format!("machine {machine_id} is not in the location")))?;
        Ok(machine.power.clone())
    }

    fn token_of(&self, machine_id: &str, sw: &crate::power::PowerSwitch) -> Result<Option<String>, HouseError> {
        self.secrets
            .get(&crate::power::token_account(machine_id, sw))
            .map_err(HouseError::Io)
    }

    /// Delete the tokens of every switch in `before` that `after` no longer points at the same server
    /// (#416 review): a removed switch, a removed machine, a moved address or provider. Logged, not
    /// fatal — the token is filed by address anyway, so a stale one can never be SENT anywhere new.
    fn drop_moved_tokens(&self, before: &LocationDoc, after: &LocationDoc) {
        for m in &before.machines {
            let Some(old) = &m.power else { continue };
            let still = after
                .machines
                .iter()
                .find(|n| n.id == m.id)
                .and_then(|n| n.power.as_ref())
                .is_some_and(|new| crate::power::same_server(old, new));
            if !still {
                if let Err(e) = self.secrets.delete(&crate::power::token_account(&m.id, old)) {
                    log::warn!("house service: could not remove a power switch's old token: {e}");
                }
            }
        }
    }

    /// The switch, whether a token is saved, and the plug's state when it can be asked (#416). The
    /// provider is asked OUTSIDE the lock: a slow Home Assistant must not stall every other request.
    pub async fn power_status(&self, machine_id: &str) -> Result<PowerStatus, HouseError> {
        let switch = self.switch_of(machine_id).await?;
        let Some(sw) = switch.clone() else {
            return Ok(PowerStatus { switch: None, has_token: false, state: None, problem: None });
        };
        let token = self.token_of(machine_id, &sw)?;
        let Some(token) = token else {
            return Ok(PowerStatus {
                switch,
                has_token: false,
                state: None,
                problem: Some("no token is saved for this switch on this computer".into()),
            });
        };
        let (state, problem) = match crate::power::plug_state(&sw, &token).await {
            Ok(s) => (Some(s), None),
            Err(e) => (None, Some(e)),
        };
        Ok(PowerStatus { switch, has_token: true, state, problem })
    }

    /// Set up, change or remove (`None`) a machine's switch. GUARDED on the location's `ETag`, as a
    /// machine write is. Removing it also removes its token from the secure store.
    pub async fn set_power(
        &self,
        machine_id: &str,
        switch: Option<crate::power::PowerSwitch>,
        if_match: Option<&str>,
    ) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&location_bytes(&inner)?), if_match, "the location")?;
        if let Some(sw) = &switch {
            sw.validate()?;
        }
        let before = inner.location.clone();
        let mut next = before.clone();
        let machine = next
            .machines
            .iter_mut()
            .find(|m| m.id == machine_id)
            .ok_or_else(|| HouseError::NotFound(format!("machine {machine_id} is not in the location")))?;
        machine.power = switch;
        self.commit(&mut inner, next.clone())?;
        // A removed switch, or one pointed at a different server, loses its token (#416 review).
        self.drop_moved_tokens(&before, &next);
        Ok(())
    }

    /// Save a switch's token in the secure store (#416). The machine must have a switch to use it.
    /// The caller (`house_api`) has already refused any peer that is not this computer.
    pub async fn set_power_token(&self, machine_id: &str, token: &str) -> Result<(), HouseError> {
        let Some(sw) = self.switch_of(machine_id).await? else {
            return Err(HouseError::Conflict(format!(
                "machine {machine_id} has no power switch set up to use a token"
            )));
        };
        if token.trim().is_empty() || token != token.trim() || token.chars().any(|c| c.is_control()) {
            return Err(HouseError::BadEntry(
                "the token is empty or has spaces or control characters in it".into(),
            ));
        }
        // Filed under the address it is saved FOR: it can only ever be sent there.
        self.secrets
            .set(&crate::power::token_account(machine_id, &sw), token)
            .map_err(HouseError::Refused)
    }

    /// Switch the plug (#416). The GUARDS — never off while running, off only after Idle and a home —
    /// are the client's, which alone can read the controller's status; this only refuses a machine
    /// with no switch or no token, and reports what the provider said.
    pub async fn switch_power(&self, machine_id: &str, on: bool) -> Result<PowerStatus, HouseError> {
        let sw = self.switch_of(machine_id).await?.ok_or_else(|| {
            HouseError::Conflict(format!("machine {machine_id} has no power switch"))
        })?;
        let token = self.token_of(machine_id, &sw)?.ok_or_else(|| {
            HouseError::Conflict("no token is saved for this switch on this computer".into())
        })?;
        crate::power::plug_set(&sw, &token, on).await.map_err(HouseError::Refused)?;
        self.power_status(machine_id).await
    }

    /// Record, change or clear (`None`) a machine's wasteboard (#417). Guarded on the location's
    /// `ETag`.
    pub async fn set_wasteboard(
        &self,
        machine_id: &str,
        board: Option<crate::wasteboard::Wasteboard>,
        if_match: Option<&str>,
    ) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&location_bytes(&inner)?), if_match, "the location")?;
        if let Some(b) = &board {
            b.validate()?;
        }
        let mut next = inner.location.clone();
        let machine = next
            .machines
            .iter_mut()
            .find(|m| m.id == machine_id)
            .ok_or_else(|| HouseError::NotFound(format!("machine {machine_id} is not in the location")))?;
        machine.wasteboard = board;
        self.commit(&mut inner, next)
    }

    /// Record that a program FINISHED cleanly on this machine (#419 §4.5): append its FNV hash to
    /// the machine's list (`finished_programs.rs`).
    ///
    /// NOT guarded on the location's `ETag`. This is an append to one section with a single writer
    /// per finish, and two windows that each finished a run must BOTH be recorded — a stale-validator
    /// refusal would silently lose the second. The store's write lock makes the dedupe and the cap
    /// atomic, which is what the guard would otherwise have bought. A hash already on the list is a
    /// no-op and writes nothing.
    pub async fn add_finished_program(&self, machine_id: &str, hash: &str) -> Result<(), HouseError> {
        crate::finished_programs::validate_hash(hash)?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        let mut next = inner.location.clone();
        let machine = next
            .machines
            .iter_mut()
            .find(|m| m.id == machine_id)
            .ok_or_else(|| HouseError::NotFound(format!("machine {machine_id} is not in the location")))?;
        if machine.finished_programs.iter().any(|h| h == hash) {
            return Ok(());
        }
        crate::finished_programs::append(&mut machine.finished_programs, hash);
        self.commit(&mut inner, next)
    }

    /// The shop's defaults, with their `ETag`.
    pub async fn defaults(&self) -> Result<(Vec<u8>, String), HouseError> {
        let inner = self.inner.read().await;
        Self::writable(&inner.location_problem)?;
        let bytes = defaults_bytes(&inner)?;
        let etag = etag_for(&bytes);
        Ok((bytes, etag))
    }

    /// Set one default. GUARDED on the defaults' own `ETag`, precondition first.
    pub async fn put_default(
        &self,
        key: &str,
        value: crate::defaults::ShopDefault,
        if_match: Option<&str>,
    ) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&defaults_bytes(&inner)?), if_match, "the shop defaults")?;
        crate::defaults::validate_write(key, &value)?;
        let mut next = inner.location.clone();
        next.defaults.insert(key.to_string(), value);
        crate::defaults::validate_all(&next.defaults)?;
        self.commit(&mut inner, next)
    }

    /// Remove one default: a seeded key goes back to its seed, any other key is removed.
    pub async fn reset_default(&self, key: &str, if_match: Option<&str>) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&defaults_bytes(&inner)?), if_match, "the shop defaults")?;
        let mut next = inner.location.clone();
        if next.defaults.remove(key).is_none() {
            return Err(HouseError::NotFound(format!("{key} is not one of the shop's defaults")));
        }
        crate::defaults::add_missing_seeds(&mut next.defaults);
        self.commit(&mut inner, next)
    }

    /// The stock shelf, with its `ETag` (#413).
    pub async fn stock(&self) -> Result<(Vec<u8>, String), HouseError> {
        let inner = self.inner.read().await;
        let bytes = stock_bytes(&inner)?;
        let etag = etag_for(&bytes);
        Ok((bytes, etag))
    }

    /// Put an entry on the shelf. Not guarded: a create is judged against its id, which is a
    /// stronger answer than a validator (the rule `create_inventory` follows).
    pub async fn create_stock(&self, item: StockItem) -> Result<(), HouseError> {
        item.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        if inner.location.stock.iter().any(|s| s.id == item.id) {
            return Err(HouseError::Conflict(format!("{} is already on the shelf", item.id)));
        }
        let mut next = inner.location.clone();
        next.stock.push(item);
        self.commit(&mut inner, next)
    }

    /// Replace an entry — an edit, a reservation, a use. GUARDED (#321) on the shelf's `ETag`, so two
    /// windows reserving the last plate cannot both win.
    ///
    /// The PRECONDITION IS CHECKED FIRST (#413 review): a write based on an old shelf is a 412 whatever
    /// else is wrong with it, because the fix is to re-read — and the re-read may make the rest moot.
    pub async fn update_stock(&self, item: StockItem, if_match: Option<&str>) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&stock_bytes(&inner)?), if_match, "the stock shelf")?;
        item.validate()?;
        let mut next = inner.location.clone();
        let Some(existing) = next.stock.iter_mut().find(|s| s.id == item.id) else {
            return Err(HouseError::NotFound(format!("{} is not on the shelf", item.id)));
        };
        *existing = item;
        self.commit(&mut inner, next)
    }

    /// Take an entry off the shelf. Guarded as `update_stock` is.
    pub async fn delete_stock(&self, id: &str, if_match: Option<&str>) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&stock_bytes(&inner)?), if_match, "the stock shelf")?;
        let mut next = inner.location.clone();
        let Some(item) = next.stock.iter().find(|s| s.id == id) else {
            return Err(HouseError::NotFound(format!("{id} is not on the shelf")));
        };
        // A reserved entry is a job's (#413 review): removing it would leave the job holding stock
        // that is not there. The job releases it first; the UI's disabled button is not the guard.
        if !item.reservations.is_empty() {
            let jobs: Vec<&str> = item.reservations.iter().map(|r| r.job_id.as_str()).collect();
            return Err(HouseError::Conflict(format!(
                "{id} is reserved for {} — release it from the job before taking it off the shelf",
                jobs.join(", ")
            )));
        }
        next.stock.retain(|s| s.id != id);
        self.commit(&mut inner, next)
    }

    /// The feeds table, with its `ETag` (#450).
    pub async fn feed_table(&self) -> Result<(Vec<u8>, String), HouseError> {
        let inner = self.inner.read().await;
        let bytes = feed_table_bytes(&inner)?;
        let etag = etag_for(&bytes);
        Ok((bytes, etag))
    }

    /// Add a row. Not guarded: a create is judged against its id, as `create_stock` is. The WHOLE
    /// table is validated after the push, because an added row can overlap one already there — a
    /// rule no single row can see (`feeds::validate_table`).
    pub async fn create_feed(&self, row: FeedRow) -> Result<(), HouseError> {
        row.validate()?;
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        if inner.location.feeds.iter().any(|f| f.id == row.id) {
            return Err(HouseError::Conflict(format!(
                "{} is already in the feeds table",
                row.id
            )));
        }
        let mut next = inner.location.clone();
        next.feeds.push(row);
        crate::feeds::validate_table(&next.feeds)?;
        self.commit(&mut inner, next)
    }

    /// Replace a row — an edit, or a measurement landed on it. GUARDED on the table's `ETag`, with
    /// the precondition first: a write based on an old table is a 412 whatever else is wrong with it.
    pub async fn update_feed(&self, row: FeedRow, if_match: Option<&str>) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&feed_table_bytes(&inner)?), if_match, "the feeds table")?;
        row.validate()?;
        let mut next = inner.location.clone();
        let Some(existing) = next.feeds.iter_mut().find(|f| f.id == row.id) else {
            return Err(HouseError::NotFound(format!(
                "{} is not in the feeds table",
                row.id
            )));
        };
        *existing = row;
        // An edit can move a row onto another's band just as a create can.
        crate::feeds::validate_table(&next.feeds)?;
        self.commit(&mut inner, next)
    }

    /// Remove a row. Guarded as `update_feed` is.
    pub async fn delete_feed(&self, id: &str, if_match: Option<&str>) -> Result<(), HouseError> {
        let mut inner = self.inner.write().await;
        Self::writable(&inner.location_problem)?;
        check_precondition(&etag_for(&feed_table_bytes(&inner)?), if_match, "the feeds table")?;
        let mut next = inner.location.clone();
        if !next.feeds.iter().any(|f| f.id == id) {
            return Err(HouseError::NotFound(format!("{id} is not in the feeds table")));
        }
        next.feeds.retain(|f| f.id != id);
        self.commit(&mut inner, next)
    }

    /// The whole location, pretty-printed: the one file a location exports as (#412, §3.5) —
    /// machines, the user's tool definitions and the inventory. The catalogue is NOT in here and
    /// cannot be — #212's rule that nothing vendor-derived leaves the machine.
    pub async fn export(&self) -> Result<Vec<u8>, HouseError> {
        let inner = self.inner.read().await;
        serde_json::to_vec_pretty(&inner.location)
            .map_err(|e| HouseError::Io(format!("could not serialize the location: {e}")))
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
        // The same loss for the vendor's stock sizes (#446): a list that had rows and now has none
        // is either a library that lost the table or one whose rows were all dropped. The shelf
        // falls back to sizes the user types in, so the sync still lands — and the note says so.
        if imported.material_specs.is_empty() && !inner.catalogue.material_specs.is_empty() {
            notes.push(SyncNote::loss(format!(
                "it holds no stock sizes, and the catalogue already has {} — this sync emptied the \
                 vendor size list, so the shelf now offers only sizes the user entered",
                inner.catalogue.material_specs.len()
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
            material_spec_rows: imported.material_specs.len(),
            notes,
        };
        let doc = CatalogueDoc {
            synced_at: Some(synced_at),
            tools: imported.entries,
            feeds: imported.feeds,
            material_specs: imported.material_specs,
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

    /// Load an exported document over the one this service holds. WHOLE-OR-NOTHING (decision 28):
    /// the document is parsed, version-checked and VALIDATED before anything is touched, so a
    /// truncated, foreign or self-contradictory file is refused with a reason and the store is left
    /// exactly as it was.
    ///
    /// TWO KINDS ARE ACCEPTED, AND THEY REPLACE DIFFERENT THINGS (#412).
    ///   * A `casemaker-location` — what `export` now writes — replaces the whole location: its
    ///     identity, its machines and both tool tiers.
    ///   * A `casemaker-house` — an older export, and what `tool-labels/build-house.ts` builds and
    ///     POSTs here — replaces ONLY the two tool tiers and keeps the location's identity and
    ///     machine records. A house file never knew the machine, so letting it replace the location
    ///     would make every inventory rebuild silently wipe the machine's saved setup.
    ///
    /// THE VALIDATION IS THE CLIENT'S, NOT A LOOSER ONE (#320). An import this service accepts must
    /// be one the app can read back, so the whole document is held to the same rule `load` holds
    /// the file to — every tool through the full entry rule, unique keys, unique inventory ids and
    /// codes, unique machine ids.
    pub async fn import(&self, bytes: &[u8]) -> Result<(), HouseError> {
        let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| {
            HouseError::BadEntry(format!("not a Case Maker location or house file: {e}"))
        })?;
        let kind = value.get("kind").and_then(|k| k.as_str()).unwrap_or("").to_string();
        let found = value.get("schemaVersion").and_then(|v| v.as_u64());
        let version_refusal = |what: &str, reads: u32| {
            HouseError::BadEntry(format!(
                "the {what} file is version {}; this build reads version {reads}",
                found.map_or_else(|| "missing".to_string(), |v| v.to_string())
            ))
        };
        match kind.as_str() {
            LOCATION_KIND => {
                if found != Some(u64::from(LOCATION_SCHEMA_VERSION)) {
                    return Err(version_refusal("location", LOCATION_SCHEMA_VERSION));
                }
                let mut doc: LocationDoc = serde_json::from_value(value).map_err(|e| {
                    HouseError::BadEntry(format!("not a Case Maker location file: {e}"))
                })?;
                // A location exported before the shop defaults gets the seeds, as one read at load does.
                crate::defaults::add_missing_seeds(&mut doc.defaults);
                // The feeds table follows the same rule (#450 slice 5): a location exported before
                // the table existed is imported with the twelve starting rows, not with a hole every
                // job would fall back to the compiled literal through.
                crate::feeds::add_missing_seeds(&mut doc.feeds);
                doc.validate()?;
                // An import is a WRITE: `seeded` is held to the write rule here too (#416/#417
                // re-review) — the app's own starting value, exactly, or the entry is `chosen`.
                for (key, d) in &doc.defaults {
                    crate::defaults::validate_write(key, d)?;
                }
                let mut inner = self.inner.write().await;
                Self::writable(&inner.location_problem)?;
                let before = inner.location.clone();
                self.commit(&mut inner, doc.clone())?;
                // An imported switch pointed elsewhere does not inherit this computer's token.
                self.drop_moved_tokens(&before, &doc);
                Ok(())
            }
            HOUSE_KIND => {
                if found != Some(u64::from(HOUSE_SCHEMA_VERSION)) {
                    return Err(version_refusal("house", HOUSE_SCHEMA_VERSION));
                }
                let mut doc: HouseDoc = serde_json::from_value(value).map_err(|e| {
                    HouseError::BadEntry(format!("not a Case Maker house file: {e}"))
                })?;
                let mut inner = self.inner.write().await;
                Self::writable(&inner.location_problem)?;
                // The operator's conditions survive an inventory rebuild (#415 review).
                crate::tool_copy::carry_copies(&inner.location.inventory, &mut doc.inventory);
                doc.validate()?;
                let mut next = inner.location.clone();
                next.tools = doc.tools;
                next.inventory = doc.inventory;
                self.commit(&mut inner, next)?;
                // Importing a house file is the warning's remedy (#412 review): it is dealt with.
                self.acknowledge_house_warning();
                Ok(())
            }
            other => Err(HouseError::BadEntry(format!(
                "this is a{} document, not a location or house file",
                if other.is_empty() {
                    "n unrecognised".to_string()
                } else {
                    format!(" {other}")
                }
            ))),
        }
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
    ///
    /// The document is `location.json` (#412); `house.json` is never written again after the
    /// migration, so the user's old file stays exactly as it was when it was moved.
    fn commit(&self, inner: &mut Inner, next: LocationDoc) -> Result<(), HouseError> {
        let bytes = serde_json::to_vec_pretty(&next)
            .map_err(|e| HouseError::Io(format!("could not serialize the location: {e}")))?;
        write_atomic(&self.dir.join(LOCATION_FILE), &bytes)?;
        inner.location = next;
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
            copies: vec![],
            collet_fits: None,
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
    async fn an_accessory_registers_edits_and_retires_through_the_file() {
        // #601 — the register door and the check-out/return/retire moves all land through one
        // guarded accessory write. `*` stands in for the location's current `ETag`, as the guarded
        // write table's own tests use it.
        let (dir, store) = store();
        let probe = crate::location::FixtureRecord {
            id: "fx-probe-1".into(),
            kind: "probe".into(),
            product: Some("Makera Wired Probe V2".into()),
            variant: Some("wired-touch".into()),
            constants: serde_json::Map::new(),
            unit: serde_json::Map::new(),
            provenance: Default::default(),
            whereabouts: crate::location::AccessoryWhereabouts::Box {},
            history: vec![crate::location::AccessoryHistory {
                at: "2026-10-23T00:00:00.000Z".into(),
                what: "owned; not yet tested".into(),
            }],
        };
        store.put_accessory(probe, Some("*")).await.unwrap();

        // A new store over the same directory sees it, which is the whole point of the file.
        let reopened = HouseStore::open(dir.path().to_path_buf());
        let doc: crate::location::LocationDoc =
            serde_json::from_slice(&reopened.export().await.unwrap()).unwrap();
        assert_eq!(doc.accessories.len(), 1);
        assert_eq!(doc.accessories[0].product.as_deref(), Some("Makera Wired Probe V2"));

        // Check it out: the same id is replaced in place, not duplicated.
        reopened
            .put_accessory(
                crate::location::FixtureRecord {
                    id: "fx-probe-1".into(),
                    kind: "probe".into(),
                    product: Some("Makera Wired Probe V2".into()),
                    variant: Some("wired-touch".into()),
                    constants: serde_json::Map::new(),
                    unit: serde_json::Map::new(),
                    provenance: Default::default(),
                    whereabouts: crate::location::AccessoryWhereabouts::Machine {
                        machine_id: "machine-1a2b3c".into(),
                        since: "2026-10-23T00:00:00.000Z".into(),
                    },
                    history: vec![],
                },
                Some("*"),
            )
            .await
            .unwrap();
        let doc: crate::location::LocationDoc =
            serde_json::from_slice(&reopened.export().await.unwrap()).unwrap();
        assert_eq!(doc.accessories.len(), 1);
        assert!(matches!(
            &doc.accessories[0].whereabouts,
            crate::location::AccessoryWhereabouts::Machine { .. }
        ));

        // Retire it.
        reopened.delete_accessory("fx-probe-1", Some("*")).await.unwrap();
        let doc: crate::location::LocationDoc =
            serde_json::from_slice(&reopened.export().await.unwrap()).unwrap();
        assert!(doc.accessories.is_empty());
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
    async fn a_catalogue_rows_metal_duty_is_served_beside_its_tool() {
        // #398: the one catalogue column the client reads. A `cat:` row carries the vendor's value
        // (0 and NULL included as stated: 0 is a value, a NULL column is omitted); a `user:` row has
        // no catalogue column at all, so the key is absent, and it never goes inside `tool` (#212).
        let dir = TempDir::new().unwrap();
        let mut rated = a_catalogue_entry("00000000-0000-0000-0000-000000000001");
        rated.extras.metal_duty = Some(1);
        let mut plain = a_catalogue_entry("00000000-0000-0000-0000-000000000002");
        plain.tool.name = "synthetic plain flat".to_string();
        plain.extras.metal_duty = Some(0);
        let unstated = a_catalogue_entry("00000000-0000-0000-0000-000000000003");
        let catalogue = CatalogueDoc {
            synced_at: Some("2026-10-08T12:00:00.000Z".to_string()),
            tools: vec![rated, plain, unstated],
            ..CatalogueDoc::default()
        };
        fs::write(dir.path().join(CATALOGUE_FILE), serde_json::to_vec_pretty(&catalogue).unwrap()).unwrap();
        let store = HouseStore::open(dir.path().to_path_buf());
        store.create_tool(an_entry("user:abc")).await.unwrap();

        let (bytes, _) = store.tools().await.unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(raw[0]["metalDuty"], serde_json::json!(1), "{raw}");
        assert_eq!(raw[1]["metalDuty"], serde_json::json!(0), "{raw}");
        assert!(raw[2].get("metalDuty").is_none(), "{raw}");
        assert_eq!(raw[3]["key"], serde_json::json!("user:abc"));
        assert!(raw[3].get("metalDuty").is_none(), "{raw}");
        for row in raw.as_array().unwrap() {
            assert!(row["tool"].get("metalDuty").is_none(), "{row}");
            assert!(row.get("extras").is_none(), "{row}");
        }
        // The shared entry shape still reads the body: the extra key is beside it, not in it.
        let entries: Vec<ToolLibraryEntry> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(entries.len(), 4);
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
        // And nothing was migrated: no empty location stands in for the house it could not read.
        assert!(!dir.path().join(LOCATION_FILE).exists(), "a corrupt house.json wrote a location");
    }

    #[tokio::test]
    async fn a_foreign_or_future_document_is_refused_without_touching_the_house() {
        let dir = TempDir::new().unwrap();
        let store = HouseStore::open(dir.path().to_path_buf());
        store.create_tool(an_entry("user:abc")).await.unwrap();
        let before = fs::read(dir.path().join(LOCATION_FILE)).unwrap();

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
        assert_eq!(fs::read(dir.path().join(LOCATION_FILE)).unwrap(), before);
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
        let reopened = fs::read_to_string(dir.path().join(LOCATION_FILE)).unwrap();
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
        let at_open = fs::read(dir.path().join(LOCATION_FILE)).unwrap();
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
        // Nothing was written: the location is the empty one the first run wrote, byte for byte.
        assert_eq!(fs::read(dir.path().join(LOCATION_FILE)).unwrap(), at_open, "nothing was written");
        assert!(!dir.path().join(HOUSE_FILE).exists(), "house.json is never written");
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
        let house_before = fs::read(dir.path().join(LOCATION_FILE)).unwrap();

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
        assert_eq!(fs::read(dir.path().join(LOCATION_FILE)).unwrap(), house_before);

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
            material_spec_rows: report.material_spec_rows,
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

    #[tokio::test]
    async fn vendor_stock_sizes_are_synced_served_and_their_loss_is_named() {
        // #446, at the store's edge: the sizes travel from the vendor library into `catalogue.json`,
        // out of their own endpoint with their own `ETag`, and a sync that empties the list is said
        // out loud rather than passing as a clean report.
        use crate::catalogue::fixture::{material, put_spec, Spec};

        let dir = TempDir::new().unwrap();
        let full = a_library(&dir);
        let conn = rusqlite::Connection::open(&full).unwrap();
        material(&conn, "mat-1", "Hardwood");
        put_spec(
            &conn,
            &Spec {
                id: "spec-1".to_string(),
                material_id: "mat-1".to_string(),
                name: "Hardwood / 100mm * 200mm * 5mm".to_string(),
                shape: "R".to_string(),
                length: Some(200.0),
                width: Some(100.0),
                height: Some(5.0),
                diameter: None,
                g_id: "9990000000000001".to_string(),
            },
        );
        drop(conn);

        let store = store_syncing(&dir, &full);
        let report = store.sync_catalogue().await.unwrap();
        assert_eq!(report.material_spec_rows, 1);
        assert!(report.notes.is_empty(), "{:?}", report.notes);
        assert_eq!(store.health().await.material_spec_rows, 1);

        // Its own document, not a field on `/tools`: a client that wants the sizes does not parse
        // 129 cutters, and the two `ETag`s move independently.
        let (bytes, etag) = store.material_specs().await.unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(raw[0]["material"], "Hardwood");
        assert_eq!(raw[0]["shape"], "R");
        assert_eq!(raw[0]["length"], serde_json::json!(200.0));
        let (_, again) = store.material_specs().await.unwrap();
        assert_eq!(etag, again);

        // A library without the table empties the list. Unlike the cutters, that is not a refusal —
        // the shelf falls back to sizes the user entered — but it IS a loss and is named as one.
        let other = TempDir::new().unwrap();
        let bare = a_library(&other);
        rusqlite::Connection::open(&bare)
            .unwrap()
            .execute("DROP TABLE t_MaterialSpecs", [])
            .unwrap();
        let store = store_syncing(&dir, &bare);
        let report = store.sync_catalogue().await.unwrap();
        assert_eq!(report.material_spec_rows, 0);
        let loss = report
            .notes
            .iter()
            .find(|n| n.text.contains("emptied the vendor size list"))
            .unwrap_or_else(|| panic!("{:?}", report.notes));
        assert_eq!(loss.kind, crate::catalogue::SyncNoteKind::Loss);
        assert_eq!(store.health().await.material_spec_rows, 0);
        // Kept with the catalogue, so `/health` still says so after a restart.
        let kept = store_syncing(&dir, &bare).health().await.last_sync.unwrap();
        assert_eq!(kept.material_spec_rows, 0);
        assert_eq!(kept.notes, report.notes);
    }

    // — the location (#412) -----------------------------------------------------------------------

    /// `tests/unit/fixtures/location-doc.json`: the location BOTH sides read, as `house_fixture` is
    /// for the house. `locationContract.spec.ts` parses it with the client's schemas.
    fn location_fixture() -> Vec<u8> {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/unit/fixtures/location-doc.json");
        fs::read(&path).unwrap_or_else(|e| panic!("{} should be readable: {e}", path.display()))
    }

    fn a_machine(id: &str) -> MachineRecord {
        MachineRecord {
            id: id.to_string(),
            profile_id: Some("Z1".into()),
            name: Some("Makera_Z1_000000".into()),
            nickname: None,
            serial: None,
            firmware: None,
            address: Some(crate::location::MachineAddress { host: "192.0.2.10".into(), port: 2222 }),
            calibration: None,
            fixtures: Some(serde_json::json!({ "vise": { "source": "measured" } })),
            bed_profiles: None,
            active_bed_profile_id: None,
            margins: None,
            power: None,
            wasteboard: None,
            finished_programs: Vec::new(),
            updated_at: "2026-10-15T00:00:00.000Z".into(),
        }
    }

    /// What the house served for a document BEFORE #412 — `tools_bytes` and `inventory_bytes` over a
    /// `HouseDoc` with no catalogue — computed here from the document itself, so "the migration lost
    /// nothing" is a comparison of bytes, not of counts.
    fn served_by_the_old_house(doc: &HouseDoc) -> (Vec<u8>, Vec<u8>) {
        let tools: Vec<ToolLibraryEntry> = doc.tools.iter().map(ToolLibraryEntry::from).collect();
        let mut items = doc.inventory.clone();
        items.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.id.cmp(&b.id)));
        (json_bytes(&tools).unwrap(), json_bytes(&items).unwrap())
    }

    /// The Kazoo shape: 37 boxes under distinct codes, one user clone — built here, synthetic, since
    /// the real labels are vendor text and are never committed.
    fn a_big_house() -> HouseDoc {
        let mut doc: HouseDoc = serde_json::from_slice(&house_fixture()).unwrap();
        for n in 0..36 {
            doc.inventory.push(InventoryItem {
                added_at: format!("2026-10-12T16:{:02}:00.000Z", n),
                quantity: 1 + (n % 3),
                notes: Some(format!("box {n}")),
                ..an_item(&format!("inv-kazoo-{n:02}"))
            });
        }
        doc
    }

    #[tokio::test]
    async fn a_house_file_is_migrated_into_a_location_and_nothing_is_lost() {
        for (what, house) in [
            ("the shared fixture", serde_json::from_slice::<HouseDoc>(&house_fixture()).unwrap()),
            ("a 37-box inventory", a_big_house()),
        ] {
            let dir = TempDir::new().unwrap();
            let house_bytes = serde_json::to_vec_pretty(&house).unwrap();
            fs::write(dir.path().join(HOUSE_FILE), &house_bytes).unwrap();
            let (want_tools, want_inventory) = served_by_the_old_house(&house);

            let store = HouseStore::open(dir.path().to_path_buf());
            assert!(store.health().await.problems.is_empty(), "{what}");
            let (tools, tools_etag) = store.tools().await.unwrap();
            let (inventory, inventory_etag) = store.inventory().await.unwrap();
            // Byte-identical, so the ETags a client already holds are still current after the move.
            assert_eq!(tools, want_tools, "{what}: the tool list changed");
            assert_eq!(inventory, want_inventory, "{what}: the inventory changed");
            assert_eq!(tools_etag, etag_for(&want_tools), "{what}");
            assert_eq!(inventory_etag, etag_for(&want_inventory), "{what}");
            assert_eq!(
                serde_json::from_slice::<Vec<InventoryItem>>(&inventory).unwrap().len(),
                house.inventory.len(),
                "{what}"
            );

            // Written at once, and the old file left byte-for-byte as it was.
            let written: LocationDoc =
                serde_json::from_slice(&fs::read(dir.path().join(LOCATION_FILE)).unwrap()).unwrap();
            assert_eq!(written.tools, house.tools, "{what}");
            assert_eq!(written.inventory, house.inventory, "{what}");
            assert!(written.machines.is_empty(), "{what}: the house never knew the machine");
            assert!(written.migrated_from.as_deref().unwrap().starts_with(HOUSE_FILE), "{what}");
            assert_eq!(fs::read(dir.path().join(HOUSE_FILE)).unwrap(), house_bytes, "{what}");

            // ONE-WAY: a restart reads the location, not the house again — the id survives, and a
            // write made after the move is not undone by the old file still being there.
            store.create_tool(an_entry("user:after-the-move")).await.unwrap();
            let reopened = HouseStore::open(dir.path().to_path_buf());
            let (bytes, _) = reopened.location().await.unwrap();
            let view: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(view["id"], serde_json::json!(written.id), "{what}");
            let (tools, _) = reopened.tools().await.unwrap();
            let keys: Vec<ToolLibraryEntry> = serde_json::from_slice(&tools).unwrap();
            assert!(keys.iter().any(|e| e.key == "user:after-the-move"), "{what}");
            assert_eq!(fs::read(dir.path().join(HOUSE_FILE)).unwrap(), house_bytes, "{what}");
        }
    }

    #[tokio::test]
    async fn an_unreadable_location_is_a_problem_and_the_old_house_is_not_served_behind_it() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(HOUSE_FILE), house_fixture()).unwrap();
        let junk = b"{ \"kind\": \"casemaker-location\", truncated";
        fs::write(dir.path().join(LOCATION_FILE), junk).unwrap();

        let store = HouseStore::open(dir.path().to_path_buf());
        let h = store.health().await;
        assert_eq!(h.problems.len(), 1, "{:?}", h.problems);
        assert!(h.problems[0].contains(LOCATION_FILE), "{:?}", h.problems);
        // Serving `house.json` here would quietly undo every write made since the migration.
        assert_eq!(store.tools().await.unwrap().0, b"[]");
        assert!(matches!(
            store.create_tool(an_entry("user:abc")).await,
            Err(HouseError::Refused(_))
        ));
        assert!(matches!(
            store.put_machine(a_machine("m-1"), Some("*")).await,
            Err(HouseError::Refused(_))
        ));
        assert_eq!(fs::read(dir.path().join(LOCATION_FILE)).unwrap(), junk);
    }

    #[tokio::test]
    async fn a_fresh_install_writes_its_empty_location_at_once_and_keeps_its_id() {
        let (dir, store) = store();
        // Written at open (#412 review): an id minted per open would change under every client.
        assert!(dir.path().join(LOCATION_FILE).exists());
        let (bytes, etag) = store.location().await.unwrap();
        let reopened = HouseStore::open(dir.path().to_path_buf());
        assert_eq!(reopened.location().await.unwrap(), (bytes.clone(), etag), "same id, same body");
        let view: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(view["kind"], serde_json::json!(LOCATION_KIND));
        assert_eq!(view["machines"], serde_json::json!([]));
        // The tiers are not in the location's own body: they have their own endpoints and ETags.
        assert!(view.get("tools").is_none() && view.get("inventory").is_none(), "{view}");
        store.create_tool(an_entry("user:abc")).await.unwrap();
        assert!(!dir.path().join(HOUSE_FILE).exists(), "house.json is never written");
    }

    #[tokio::test]
    async fn a_machine_write_is_guarded_on_the_location_and_upserts_by_id() {
        let (_dir, store) = store();
        assert!(matches!(
            store.put_machine(a_machine("m-1"), None).await,
            Err(HouseError::PreconditionRequired(_))
        ));
        assert!(matches!(
            store.put_machine(a_machine("m-1"), Some("\"stale\"")).await,
            Err(HouseError::StalePrecondition(_))
        ));
        let (_, etag) = store.location().await.unwrap();
        store.put_machine(a_machine("m-1"), Some(&etag)).await.unwrap();
        // The etag moved: the same validator a second time is now stale.
        assert!(matches!(
            store.put_machine(a_machine("m-1"), Some(&etag)).await,
            Err(HouseError::StalePrecondition(_))
        ));
        let (_, etag) = store.location().await.unwrap();
        let replaced = MachineRecord { firmware: Some("1.1.2".into()), ..a_machine("m-1") };
        store.put_machine(replaced.clone(), Some(&etag)).await.unwrap();
        let (bytes, _) = store.location().await.unwrap();
        let view: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(view["machines"].as_array().unwrap().len(), 1, "an upsert, not a second row");
        assert_eq!(view["machines"][0]["firmware"], serde_json::json!("1.1.2"));
        // A machine write does not move the tool list's or the inventory's validator.
        let (tools_before, _) = store.tools().await.unwrap();
        assert_eq!(tools_before, b"[]");

        let (_, etag) = store.location().await.unwrap();
        let bad = MachineRecord { margins: Some(serde_json::json!("lots")), ..a_machine("m-2") };
        assert!(matches!(store.put_machine(bad, Some(&etag)).await, Err(HouseError::BadEntry(_))));
    }

    #[tokio::test]
    async fn a_house_import_replaces_the_tools_and_keeps_the_machine() {
        // `tool-labels/build-house.ts` POSTs a `casemaker-house` document to `/import`. That rebuild
        // must not wipe the machine record the client wrote — the house file never knew it.
        let (_dir, store) = store();
        let (_, etag) = store.location().await.unwrap();
        store.put_machine(a_machine("m-1"), Some(&etag)).await.unwrap();
        store.create_tool(an_entry("user:old")).await.unwrap();
        let (before, _) = store.location().await.unwrap();

        store.import(&house_fixture()).await.unwrap();
        let (after, _) = store.location().await.unwrap();
        assert_eq!(after, before, "the location's identity and machine are untouched");
        let (tools, _) = store.tools().await.unwrap();
        let keys: Vec<String> = serde_json::from_slice::<Vec<ToolLibraryEntry>>(&tools)
            .unwrap()
            .into_iter()
            .map(|e| e.key)
            .collect();
        assert_eq!(keys, ["user:1a2b3c4d5e", "user:6f7a8b9c0d"], "the tiers were replaced");
    }

    #[tokio::test]
    async fn the_shared_location_fixture_round_trips_through_export_and_import() {
        let (_dir, store) = store();
        store.import(&location_fixture()).await.unwrap();
        let exported = store.export().await.unwrap();
        let original: LocationDoc = serde_json::from_slice(&location_fixture()).unwrap();
        let back: LocationDoc = serde_json::from_slice(&exported).unwrap();
        assert_eq!(back, original, "export is the document that was imported");
        // #450 slice 5. The fixture carries the feeds table — the twelve starting rows, all three V
        // rows included — so the document BOTH sides read states where every number came from. Raw-file
        // equality is not the property to assert: the fixture is hand-formatted and is not what
        // serde writes (its `calibration` members are in a different order, among other things).
        // The evidence is that the rows are the seeds and the export is byte-for-byte the
        // fixture's own parsed value re-serialised, feeds included.
        use crate::feeds::{FeedEdge, FeedSource};
        assert_eq!(
            back.feeds,
            crate::feeds::seeded_rows(),
            "the fixture carries every seeded row, not a subset"
        );
        assert_eq!(back.feeds.len(), 12);
        assert!(back.feeds.iter().all(|r| r.source == FeedSource::Seeded));
        assert!(
            back.feeds.iter().any(|r| r.edge == Some(FeedEdge::V)),
            "the V row is a location row too"
        );
        assert_eq!(
            serde_json::to_vec_pretty(&original).unwrap(),
            exported,
            "the exported document is the imported one, feeds included"
        );
        // The machine's sections are kept verbatim — the client is their shape authority.
        assert_eq!(
            back.machines[0].fixtures.as_ref().unwrap()["vise"]["measuredAt"],
            serde_json::json!("2026-10-13T12:00:00.000Z")
        );

        let other = TempDir::new().unwrap();
        let fresh = HouseStore::open(other.path().to_path_buf());
        fresh.import(&exported).await.unwrap();
        assert_eq!(fresh.export().await.unwrap(), exported);
        assert_eq!(fresh.tools().await.unwrap().0, store.tools().await.unwrap().0);
        assert_eq!(fresh.inventory().await.unwrap().0, store.inventory().await.unwrap().0);
        assert_eq!(fresh.location().await.unwrap(), store.location().await.unwrap());
    }

    /// #450 slice 5: a location exported before the feeds table existed has no `feeds` key.
    /// Importing it seeds the table, exactly as one read at load does, so the next export carries
    /// the twelve starting rows rather than a hole every job would fall back to the compiled literal
    /// through.
    #[tokio::test]
    async fn an_import_from_before_the_feeds_table_gets_the_seeded_rows() {
        let (_dir, store) = store();
        let mut doc: serde_json::Value = serde_json::from_slice(&location_fixture()).unwrap();
        doc.as_object_mut().unwrap().remove("feeds");
        store.import(&serde_json::to_vec(&doc).unwrap()).await.unwrap();
        let back: LocationDoc = serde_json::from_slice(&store.export().await.unwrap()).unwrap();
        assert_eq!(back.feeds, crate::feeds::seeded_rows());
    }

    #[tokio::test]
    async fn a_location_import_the_client_would_refuse_is_refused_whole() {
        let (dir, store) = store();
        let at_open = fs::read(dir.path().join(LOCATION_FILE)).unwrap();
        let cases: Vec<(&str, Box<dyn FnOnce(&mut serde_json::Value)>)> = vec![
            ("a future version", Box::new(|d| d["schemaVersion"] = serde_json::json!(2))),
            ("no name", Box::new(|d| d["name"] = serde_json::json!(" "))),
            (
                "one machine twice",
                Box::new(|d| {
                    let m = d["machines"][0].clone();
                    d["machines"].as_array_mut().unwrap().push(m);
                }),
            ),
            ("a key this build does not know", Box::new(|d| d["shelf"] = serde_json::json!([]))),
            (
                "a duplicate tool key, by the house's own rule",
                Box::new(|d| d["tools"][1]["key"] = d["tools"][0]["key"].clone()),
            ),
        ];
        for (why, break_it) in cases {
            let mut doc: serde_json::Value = serde_json::from_slice(&location_fixture()).unwrap();
            break_it(&mut doc);
            let err = store.import(&serde_json::to_vec(&doc).unwrap()).await.unwrap_err();
            assert!(
                matches!(err, HouseError::BadKey(_) | HouseError::BadEntry(_)),
                "{why} was refused as {err:?}"
            );
        }
        assert_eq!(fs::read(dir.path().join(LOCATION_FILE)).unwrap(), at_open, "nothing was written");
    }

    #[tokio::test]
    async fn an_unreadable_location_is_refused_on_its_own_endpoint_not_served_fresh() {
        // #412 review: serving the stand-in would show a new, empty location with a new id on every
        // restart, instead of saying the user's file cannot be read.
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(LOCATION_FILE), b"{ broken").unwrap();
        let store = HouseStore::open(dir.path().to_path_buf());
        let err = store.location().await.unwrap_err();
        assert!(matches!(err, HouseError::Refused(_)), "{err:?}");
        assert!(err.to_string().contains(LOCATION_FILE), "{err}");
    }

    #[tokio::test]
    async fn a_house_file_written_after_the_location_is_a_warning_on_health() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(HOUSE_FILE), house_fixture()).unwrap();
        let store = HouseStore::open(dir.path().to_path_buf());
        let h = store.health().await;
        assert!(h.warnings.is_empty(), "just migrated: {:?}", h.warnings);

        // An older build saves `house.json` after the migration.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(dir.path().join(HOUSE_FILE))
            .unwrap()
            .set_modified(later)
            .unwrap();
        let h = store.health().await;
        assert_eq!(h.warnings.len(), 1, "{:?}", h.warnings);
        assert!(h.warnings[0].contains(HOUSE_FILE), "{:?}", h.warnings);
        assert!(h.problems.is_empty(), "a warning, not a refusal: {:?}", h.problems);
        // Writes are not refused.
        store.create_tool(an_entry("user:abc")).await.unwrap();

        // It PERSISTS (re-review): a write that makes `location.json` the newer file does not hide
        // it, and neither does a restart.
        let set_mtime = |name: &str, secs: u64| {
            fs::File::options()
                .write(true)
                .open(dir.path().join(name))
                .unwrap()
                .set_modified(later + std::time::Duration::from_secs(secs))
                .unwrap();
        };
        set_mtime(LOCATION_FILE, 60);
        assert_eq!(store.health().await.warnings.len(), 1, "hidden by a location write");
        let reopened = HouseStore::open(dir.path().to_path_buf());
        assert_eq!(reopened.health().await.warnings.len(), 1, "hidden by a restart");

        // Dismissed: gone, and stays gone across a restart.
        reopened.acknowledge_house_warning();
        assert!(reopened.health().await.warnings.is_empty());
        drop(reopened);
        let reopened = HouseStore::open(dir.path().to_path_buf());
        assert!(reopened.health().await.warnings.is_empty(), "a dismissal is remembered");

        // A NEW change to `house.json` is a new sighting, whatever the location's time.
        set_mtime(HOUSE_FILE, 30);
        assert_eq!(reopened.health().await.warnings.len(), 1, "a later house.json edit");

        // Importing a house file deals with it.
        reopened.import(&house_fixture()).await.unwrap();
        assert!(reopened.health().await.warnings.is_empty(), "the import is the remedy");
    }

    #[test]
    fn a_document_whose_existence_cannot_be_checked_is_a_problem_not_absent() {
        // `try_exists` (re-review). A path under a FILE cannot be checked — the OS answers with an
        // error, not "no" — and the caller must not take that as a first run.
        let dir = TempDir::new().unwrap();
        let not_a_dir = dir.path().join("plain-file");
        fs::write(&not_a_dir, b"x").unwrap();
        let under = not_a_dir.join(LOCATION_FILE);
        let read = read_doc::<LocationDoc>(&under, LOCATION_KIND, LOCATION_SCHEMA_VERSION, Some(hoist_bed_fixtures));
        // Unix answers ENOTDIR, which `try_exists` reports as an error; Windows reports this path
        // as not found, which is honestly "not there". Either way it is never a document.
        #[cfg(unix)]
        assert!(read.as_ref().is_err_and(|e| e.contains("cannot tell whether it exists")), "{read:?}");
        #[cfg(not(unix))]
        assert!(matches!(read, Ok(None)), "{read:?}");
    }

    // — the stock shelf (#413) ----------------------------------------------------------------------

    #[tokio::test]
    async fn the_shelf_is_written_under_its_own_validator() {
        use crate::stock::tests::a_plate;
        let (dir, store) = store();
        store.create_stock(a_plate("s-1")).await.unwrap();
        assert!(matches!(store.create_stock(a_plate("s-1")).await, Err(HouseError::Conflict(_))));
        // A sphere never reaches the shelf (Q20).
        let sphere = crate::stock::StockItem { form: "sphere".into(), ..a_plate("s-2") };
        assert!(matches!(store.create_stock(sphere).await, Err(HouseError::BadEntry(_))));

        let (bytes, etag) = store.stock().await.unwrap();
        let listed: Vec<crate::stock::StockItem> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(listed.len(), 1);

        // Guarded: none, stale, current.
        let reserved = crate::stock::StockItem {
            reservations: vec![crate::stock::StockClaim {
                job_id: "job-1".into(),
                quantity: 2,
                at: "2026-10-15T01:00:00.000Z".into(),
            }],
            ..a_plate("s-1")
        };
        assert!(matches!(
            store.update_stock(reserved.clone(), None).await,
            Err(HouseError::PreconditionRequired(_))
        ));
        assert!(matches!(
            store.update_stock(reserved.clone(), Some("\"old\"")).await,
            Err(HouseError::StalePrecondition(_))
        ));
        store.update_stock(reserved, Some(&etag)).await.unwrap();

        // More reserved than there is: refused, and the shelf is as it was.
        let (before, etag) = store.stock().await.unwrap();
        let over = crate::stock::StockItem {
            reservations: vec![crate::stock::StockClaim {
                job_id: "job-2".into(),
                quantity: 3,
                at: "2026-10-15T02:00:00.000Z".into(),
            }],
            ..a_plate("s-1")
        };
        assert!(matches!(store.update_stock(over, Some(&etag)).await, Err(HouseError::BadEntry(_))));
        assert_eq!(store.stock().await.unwrap().0, before);

        // A shelf write moves neither the tools' nor the location's validator.
        assert_eq!(store.tools().await.unwrap().0, b"[]");
        let (loc, _) = store.location().await.unwrap();
        assert!(!String::from_utf8(loc).unwrap().contains("s-1"), "the shelf is not on /location");

        // Reserved: refused (#413 review). Released, then removed.
        assert!(matches!(store.delete_stock("s-1", Some(&etag)).await, Err(HouseError::Conflict(_))));
        store.update_stock(a_plate("s-1"), Some(&etag)).await.unwrap();
        let (_, etag) = store.stock().await.unwrap();
        store.delete_stock("s-1", Some(&etag)).await.unwrap();
        assert_eq!(store.stock().await.unwrap().0, b"[]");
        let written = fs::read_to_string(dir.path().join(LOCATION_FILE)).unwrap();
        assert!(written.contains("\"stock\": []"), "{written}");
    }

    // — the feeds table (#450, slice 2) ------------------------------------------------------------

    #[tokio::test]
    async fn the_feeds_table_is_written_under_its_whole_table_rule() {
        use crate::feeds::tests::a_row;
        let (dir, store) = store();
        // #450 slice 3: a fresh location now holds the twelve seeded rows, and this test is about the
        // WRITE rule on a table it builds row by row. Delete the seeds through the guarded API, so
        // the starting state is the empty table this test used to open with.
        loop {
            let (bytes, etag) = store.feed_table().await.unwrap();
            let rows: Vec<FeedRow> = serde_json::from_slice(&bytes).unwrap();
            let Some(first) = rows.first() else { break };
            store.delete_feed(&first.id, Some(&etag)).await.unwrap();
        }
        assert_eq!(store.feed_table().await.unwrap().0, b"[]");
        let row = a_row("feed-softwood-flat-0.8-1.6");
        store.create_feed(row.clone()).await.unwrap();
        // One id, one row: a second create of the same id is a conflict, as on the shelf.
        assert!(matches!(store.create_feed(row.clone()).await, Err(HouseError::Conflict(_))));

        // A row that cannot stand on its own is a 400.
        let mut bad = a_row("feed-bad");
        bad.params.rpm = 0.0;
        assert!(matches!(store.create_feed(bad).await, Err(HouseError::BadEntry(_))));

        // TOUCHING at 1.6 is the table's shape, and the order it was added in is preserved.
        let mut next_band = a_row("feed-softwood-flat-1.6-3.2");
        next_band.min_diameter = 1.6;
        next_band.max_diameter = 3.2;
        store.create_feed(next_band).await.unwrap();
        let (bytes, etag) = store.feed_table().await.unwrap();
        let listed: Vec<FeedRow> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            listed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["feed-softwood-flat-0.8-1.6", "feed-softwood-flat-1.6-3.2"]
        );

        // An OVERLAP with a row already there is the table's rule, not any row's: 400.
        let mut overlapping = a_row("feed-overlap");
        overlapping.min_diameter = 1.0;
        overlapping.max_diameter = 3.2;
        let err = store.create_feed(overlapping.clone()).await.unwrap_err();
        assert!(matches!(err, HouseError::BadEntry(_)), "{err:?}");
        assert_eq!(store.feed_table().await.unwrap().0, bytes, "a refused add wrote nothing");

        // Guarded: none, stale, current. An edit onto another row's band is refused whole.
        let mut edited = row.clone();
        edited.params.feed = 600.0;
        assert!(matches!(
            store.update_feed(edited.clone(), None).await,
            Err(HouseError::PreconditionRequired(_))
        ));
        assert!(matches!(
            store.update_feed(edited.clone(), Some("\"old\"")).await,
            Err(HouseError::StalePrecondition(_))
        ));
        store.update_feed(edited.clone(), Some(&etag)).await.unwrap();

        let (before, etag) = store.feed_table().await.unwrap();
        let mut over = edited.clone();
        over.max_diameter = 3.2;
        assert!(matches!(
            store.update_feed(over, Some(&etag)).await,
            Err(HouseError::BadEntry(_))
        ));
        assert_eq!(store.feed_table().await.unwrap().0, before);

        // A row that is not there is a 404; a delete needs the current guard.
        let missing = a_row("feed-missing");
        assert!(matches!(
            store.update_feed(missing, Some(&etag)).await,
            Err(HouseError::NotFound(_))
        ));
        assert!(matches!(
            store.delete_feed("feed-softwood-flat-1.6-3.2", None).await,
            Err(HouseError::PreconditionRequired(_))
        ));
        assert!(matches!(
            store.delete_feed("feed-softwood-flat-1.6-3.2", Some("\"old\"")).await,
            Err(HouseError::StalePrecondition(_))
        ));
        store.delete_feed("feed-softwood-flat-1.6-3.2", Some(&etag)).await.unwrap();
        let (_, etag) = store.feed_table().await.unwrap();
        store.delete_feed("feed-softwood-flat-0.8-1.6", Some(&etag)).await.unwrap();
        assert_eq!(store.feed_table().await.unwrap().0, b"[]");

        // An EMPTY table writes no key at all (the held fixture has none).
        let written = fs::read_to_string(dir.path().join(LOCATION_FILE)).unwrap();
        assert!(!written.contains("\"feeds\""), "{written}");
    }

    #[tokio::test]
    async fn an_older_location_with_no_feeds_table_is_served_the_seeds_at_load() {
        // #450 slice 3. A document written before the table existed carries no `feeds`. It is
        // served the twelve starting rows — in memory, as an older one gets the defaults — so the
        // panel has numbers from the first read; the user's file is not rewritten by opening it.
        let older = TempDir::new().unwrap();
        let mut doc: serde_json::Value = serde_json::from_slice(&location_fixture()).unwrap();
        doc.as_object_mut().unwrap().remove("feeds");
        fs::write(older.path().join(LOCATION_FILE), serde_json::to_vec(&doc).unwrap()).unwrap();

        let store = HouseStore::open(older.path().to_path_buf());
        let (bytes, _) = store.feed_table().await.unwrap();
        let rows: Vec<FeedRow> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(rows, crate::feeds::seeded_rows());
        assert!(rows.iter().all(|r| r.source == crate::feeds::FeedSource::Seeded));

        let on_disk = fs::read_to_string(older.path().join(LOCATION_FILE)).unwrap();
        assert!(!on_disk.contains("\"feeds\""), "opening the location rewrote it: {on_disk}");
    }

    #[tokio::test]
    async fn the_shelf_travels_with_the_location_and_survives_a_house_import() {
        let (_dir, store) = store();
        store.import(&location_fixture()).await.unwrap();
        let (shelf, _) = store.stock().await.unwrap();
        let items: Vec<crate::stock::StockItem> = serde_json::from_slice(&shelf).unwrap();
        // Ordered by `addedAt`: the blank was put on the shelf first, the laminate last (#492).
        assert_eq!(
            items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["stock-blank1", "stock-plate1", "stock-laminate1"]
        );

        // A house file replaces the tools and keeps the shelf, as it keeps the machine.
        store.import(&house_fixture()).await.unwrap();
        assert_eq!(store.stock().await.unwrap().0, shelf);

        let exported: LocationDoc = serde_json::from_slice(&store.export().await.unwrap()).unwrap();
        assert_eq!(exported.stock.len(), 3);
    }

    #[tokio::test]
    async fn a_reserved_entry_cannot_be_removed_and_a_stale_invalid_write_is_a_412() {
        use crate::stock::tests::a_plate;
        let (_dir, store) = store();
        let reserved = crate::stock::StockItem {
            reservations: vec![crate::stock::StockClaim {
                job_id: "job-1".into(),
                quantity: 1,
                at: "2026-10-15T01:00:00.000Z".into(),
            }],
            ..a_plate("s-1")
        };
        store.create_stock(reserved).await.unwrap();
        let (_, etag) = store.stock().await.unwrap();
        let err = store.delete_stock("s-1", Some(&etag)).await.unwrap_err();
        assert!(matches!(err, HouseError::Conflict(_)), "{err:?}");
        assert!(err.to_string().contains("job-1"), "{err}");

        // Stale AND invalid: the stale guard answers first.
        let invalid = crate::stock::StockItem { form: "sphere".into(), ..a_plate("s-1") };
        assert!(matches!(
            store.update_stock(invalid, Some("\"old\"")).await,
            Err(HouseError::StalePrecondition(_))
        ));
    }

    #[tokio::test]
    async fn a_location_from_before_the_shelf_reads_with_an_empty_one() {
        // #413 review: the shared fixture has a shelf now, so the pre-#413 shape is tested on its own.
        let dir = TempDir::new().unwrap();
        let mut doc: serde_json::Value = serde_json::from_slice(&location_fixture()).unwrap();
        doc.as_object_mut().unwrap().remove("stock");
        fs::write(dir.path().join(LOCATION_FILE), serde_json::to_vec(&doc).unwrap()).unwrap();
        let store = HouseStore::open(dir.path().to_path_buf());
        assert!(store.health().await.problems.is_empty());
        assert_eq!(store.stock().await.unwrap().0, b"[]");
        assert_eq!(store.tools().await.unwrap().0.is_empty(), false);
    }

    /// `tests/unit/fixtures/stock-refusals.json`: ONE table of entries the shelf refuses, read by this
    /// test and by `stockShelf.spec.ts` (#413 review). Each case patches the fixture's plate; a case
    /// marked `"zodOnly": true` is a rule only the client holds (the material vocabulary).
    #[test]
    fn the_shared_refusal_table_is_refused_here_too() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/unit/fixtures/stock-refusals.json");
        let cases: Vec<serde_json::Value> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let loc: serde_json::Value = serde_json::from_slice(&location_fixture()).unwrap();
        let mut checked = 0;
        for case in &cases {
            if case["zodOnly"].as_bool() == Some(true) {
                continue;
            }
            let mut entry = loc["stock"][0].clone();
            for (k, v) in case["patch"].as_object().unwrap() {
                entry[k] = v.clone();
            }
            let why = case["why"].as_str().unwrap();
            // Either door refuses it: the parse (a shape serde cannot hold) or the rules.
            let refused = match serde_json::from_value::<crate::stock::StockItem>(entry) {
                Err(_) => true,
                Ok(item) => item.validate().is_err(),
            };
            assert!(refused, "{why} was accepted");
            checked += 1;
        }
        assert!(checked >= 10, "the table should carry the shared cases ({checked})");
    }

    // — the power switch (#416) and the wasteboard (#417) ------------------------------------------

    /// A store with one machine in it, and its location validator.
    async fn store_with_machine() -> (TempDir, HouseStore) {
        let (dir, store) = store();
        let (_, etag) = store.location().await.unwrap();
        store.put_machine(a_machine("m-1"), Some(&etag)).await.unwrap();
        (dir, store)
    }

    #[tokio::test]
    async fn with_no_switch_the_status_says_none_and_switching_is_refused() {
        let (_dir, store) = store_with_machine().await;
        let s = store.power_status("m-1").await.unwrap();
        assert!(s.switch.is_none() && !s.has_token && s.state.is_none() && s.problem.is_none());
        assert!(matches!(store.switch_power("m-1", true).await, Err(HouseError::Conflict(_))));
        assert!(matches!(store.set_power_token("m-1", "t").await, Err(HouseError::Conflict(_))));
        assert!(matches!(store.power_status("nope").await, Err(HouseError::NotFound(_))));
    }

    #[tokio::test]
    async fn a_switch_is_configured_tokened_and_switched_through_a_fake_home_assistant() {
        let ha = crate::power::tests::fake_ha("tok-1").await;
        let (dir, store) = store_with_machine().await;
        let (_, etag) = store.location().await.unwrap();
        store
            .set_power("m-1", Some(crate::power::tests::a_switch(&ha.base_url)), Some(&etag))
            .await
            .unwrap();
        let s = store.power_status("m-1").await.unwrap();
        assert!(s.switch.is_some() && !s.has_token, "{s:?}");

        store.set_power_token("m-1", "tok-1").await.unwrap();
        let s = store.switch_power("m-1", true).await.unwrap();
        assert_eq!(s.state, Some(crate::power::PlugState::On));
        let s = store.switch_power("m-1", false).await.unwrap();
        assert_eq!(s.state, Some(crate::power::PlugState::Off));

        // The token is in the secure store and NOWHERE in the document, the view or the export.
        let file = fs::read_to_string(dir.path().join(LOCATION_FILE)).unwrap();
        let export = String::from_utf8(store.export().await.unwrap()).unwrap();
        let view = String::from_utf8(store.location().await.unwrap().0).unwrap();
        for text in [&file, &export, &view] {
            assert!(!text.contains("tok-1"), "the token leaked");
        }
        assert!(file.contains("switch.makera_cnc"));
        let status = serde_json::to_string(&store.power_status("m-1").await.unwrap()).unwrap();
        assert!(!status.contains("tok-1") && status.contains("\"hasToken\":true"), "{status}");

        // Removing the switch removes its token too.
        let (_, etag) = store.location().await.unwrap();
        store.set_power("m-1", None, Some(&etag)).await.unwrap();
        let sw = crate::power::tests::a_switch(&ha.base_url);
        assert_eq!(store.secrets.get(&crate::power::token_account("m-1", &sw)).unwrap(), None);
    }

    #[tokio::test]
    async fn a_machine_put_keeps_the_switch_and_the_wasteboard() {
        // The settings write-through PUTs the whole machine record; it must not wipe either field.
        let (_dir, store) = store_with_machine().await;
        let (_, etag) = store.location().await.unwrap();
        store
            .set_power("m-1", Some(crate::power::tests::a_switch("http://ha.local:8123")), Some(&etag))
            .await
            .unwrap();
        let (_, etag) = store.location().await.unwrap();
        store
            .set_wasteboard("m-1", Some(crate::wasteboard::tests::a_board()), Some(&etag))
            .await
            .unwrap();
        let (_, etag) = store.location().await.unwrap();
        let mut edited = a_machine("m-1");
        edited.margins = Some(serde_json::json!({ "source": "user" }));
        store.put_machine(edited, Some(&etag)).await.unwrap();
        let view: serde_json::Value = serde_json::from_slice(&store.location().await.unwrap().0).unwrap();
        let m = &view["machines"][0];
        assert_eq!(m["margins"]["source"], serde_json::json!("user"));
        assert_eq!(m["power"]["entityId"], serde_json::json!("switch.makera_cnc"));
        assert_eq!(m["wasteboard"]["thickness"], serde_json::json!(10.0));
    }

    #[tokio::test]
    async fn a_machine_put_keeps_bed_keys_an_older_client_omits_and_accepts_the_migration() {
        // #510: the client's one-time migration is a key-bearing machine PUT, and the settings
        // write-through of an OLDER client carries no bed keys at all. The first must write, the
        // second must not wipe — the reason `put_machine` has the `is_none` rule.
        use crate::location::{BedDatums, BedProfile, BedSurface, SurfaceKind};

        let (_dir, store) = store_with_machine().await;
        let (_, etag) = store.location().await.unwrap();
        let mut migrated = a_machine("m-1");
        migrated.bed_profiles = Some(vec![BedProfile {
            id: "bp-1".into(),
            name: "Current bed (migrated 2026-10-18)".into(),
            created_at: "2026-10-18T00:00:00.000Z".into(),
            based_on: None,
            surface: BedSurface {
                kind: SurfaceKind::BareBed,
                material: None,
                length: None,
                width: None,
                thickness: None,
                position: None,
                provenance: Default::default(),
                scars: Vec::new(),
                last_resurfaced_at: None,
            },
            datums: BedDatums {
                surface_top_z: None,
                vise_jaw_top_z: None,
                bracket_seat_z: None,
                rotary_axis: None,
            },
            placements: Vec::new(),
            preferred_mounting: Vec::new(),
            consumables: None,
            history: Vec::new(),
        }]);
        migrated.active_bed_profile_id = Some("bp-1".into());
        store.put_machine(migrated, Some(&etag)).await.unwrap();

        let view: serde_json::Value = serde_json::from_slice(&store.location().await.unwrap().0).unwrap();
        assert_eq!(view["machines"][0]["bedProfiles"][0]["id"], serde_json::json!("bp-1"));
        assert_eq!(view["machines"][0]["activeBedProfileId"], serde_json::json!("bp-1"));

        // An older client's settings write: no bed keys on the wire, so the stored bed survives.
        let (_, etag) = store.location().await.unwrap();
        let mut older = a_machine("m-1");
        older.margins = Some(serde_json::json!({ "source": "user" }));
        store.put_machine(older, Some(&etag)).await.unwrap();
        let view: serde_json::Value = serde_json::from_slice(&store.location().await.unwrap().0).unwrap();
        assert_eq!(view["machines"][0]["margins"]["source"], serde_json::json!("user"));
        assert_eq!(view["machines"][0]["bedProfiles"][0]["id"], serde_json::json!("bp-1"));
        assert_eq!(view["machines"][0]["activeBedProfileId"], serde_json::json!("bp-1"));
    }

    #[tokio::test]
    async fn a_wasteboard_is_guarded_validated_and_cleared() {
        let (_dir, store) = store_with_machine().await;
        assert!(matches!(
            store.set_wasteboard("m-1", Some(crate::wasteboard::tests::a_board()), None).await,
            Err(HouseError::PreconditionRequired(_))
        ));
        let (_, etag) = store.location().await.unwrap();
        let bad = crate::wasteboard::Wasteboard { thickness: 0.0, ..crate::wasteboard::tests::a_board() };
        assert!(matches!(store.set_wasteboard("m-1", Some(bad), Some(&etag)).await, Err(HouseError::BadEntry(_))));
        store.set_wasteboard("m-1", Some(crate::wasteboard::tests::a_board()), Some(&etag)).await.unwrap();
        let (_, etag) = store.location().await.unwrap();
        store.set_wasteboard("m-1", None, Some(&etag)).await.unwrap();
        let view: serde_json::Value = serde_json::from_slice(&store.location().await.unwrap().0).unwrap();
        assert_eq!(view["machines"][0]["wasteboard"], serde_json::Value::Null);
    }

    // — a machine's finished programs (#419 §4.5) ----------------------------------------------------

    #[tokio::test]
    async fn a_machine_gains_finished_programs_once_and_keeps_them_across_a_machine_put() {
        let (_dir, store) = store_with_machine().await;
        // No ETag: an append is not a read-modify-write (see `add_finished_program`'s note).
        store.add_finished_program("m-1", "a1b2c3d4").await.unwrap();
        store.add_finished_program("m-1", "a1b2c3d4").await.unwrap();
        store.add_finished_program("m-1", "0badf00d").await.unwrap();
        let view: serde_json::Value = serde_json::from_slice(&store.location().await.unwrap().0).unwrap();
        assert_eq!(
            view["machines"][0]["finishedPrograms"],
            serde_json::json!(["a1b2c3d4", "0badf00d"])
        );

        // The settings write-through must not wipe the list, as it must not wipe power/wasteboard.
        let (_, etag) = store.location().await.unwrap();
        store.put_machine(a_machine("m-1"), Some(&etag)).await.unwrap();
        let view: serde_json::Value = serde_json::from_slice(&store.location().await.unwrap().0).unwrap();
        assert_eq!(
            view["machines"][0]["finishedPrograms"],
            serde_json::json!(["a1b2c3d4", "0badf00d"])
        );
    }

    #[tokio::test]
    async fn a_finished_program_needs_a_hash_and_a_machine_that_exists() {
        let (_dir, store) = store_with_machine().await;
        assert!(matches!(store.add_finished_program("m-1", " ").await, Err(HouseError::BadEntry(_))));
        assert!(matches!(
            store.add_finished_program("nope", "a1b2c3d4").await,
            Err(HouseError::NotFound(_))
        ));
        // Neither refusal wrote anything.
        let view: serde_json::Value = serde_json::from_slice(&store.location().await.unwrap().0).unwrap();
        assert!(view["machines"][0].get("finishedPrograms").is_none(), "{view}");
    }

    #[tokio::test]
    async fn the_finished_program_list_keeps_its_cap() {
        let (_dir, store) = store_with_machine().await;
        let cap = crate::finished_programs::MAX_FINISHED_PROGRAMS;
        for i in 0..cap + 5 {
            store.add_finished_program("m-1", &format!("h{i:04}")).await.unwrap();
        }
        let view: serde_json::Value = serde_json::from_slice(&store.location().await.unwrap().0).unwrap();
        let list = view["machines"][0]["finishedPrograms"].as_array().unwrap();
        assert_eq!(list.len(), cap);
        assert_eq!(list.last().unwrap(), &serde_json::json!("h0204"));
        assert_ne!(list[0], serde_json::json!("h0000"), "the oldest entry was not dropped");
    }

    // — the shop's defaults --------------------------------------------------------------------------

    #[tokio::test]
    async fn a_fresh_location_is_seeded_and_an_older_one_gets_the_seeds_at_load() {
        let (dir, store) = store();
        let (bytes, _) = store.defaults().await.unwrap();
        let d: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(d["power.onWaitSeconds"]["source"], serde_json::json!("seeded"));
        assert_eq!(d["wasteboard.depthLimitMm"]["value"], serde_json::json!(0.5));
        // On disk too: the fresh location was written with them.
        assert!(fs::read_to_string(dir.path().join(LOCATION_FILE)).unwrap().contains("power.onWaitSeconds"));

        let older = TempDir::new().unwrap();
        let mut doc: serde_json::Value = serde_json::from_slice(&location_fixture()).unwrap();
        doc.as_object_mut().unwrap().remove("defaults");
        fs::write(older.path().join(LOCATION_FILE), serde_json::to_vec(&doc).unwrap()).unwrap();
        let reopened = HouseStore::open(older.path().to_path_buf());
        let d: serde_json::Value = serde_json::from_slice(&reopened.defaults().await.unwrap().0).unwrap();
        assert_eq!(d["wasteboard.depthLimitMm"]["source"], serde_json::json!("seeded"));
    }

    #[tokio::test]
    async fn a_fresh_location_gets_the_rest_machining_seeds() {
        // #436 — the two numbers a two-tool job runs on are SHOP SETTINGS, so a fresh location has to
        // come up holding them. A bench whose document lacked them would run the build's own fallback
        // pair instead, which is the very thing the maintainer moved them out of the code to avoid.
        use crate::defaults::{DefaultSource, ShopDefault};
        let (dir, store) = store();
        let (bytes, _) = store.defaults().await.unwrap();
        let d: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(d["rest.overlapMm"]["value"], serde_json::json!(0.5), "the band's floor");
        assert_eq!(d["rest.overlapMm"]["unit"], serde_json::json!("mm"));
        assert_eq!(d["rest.thirdToolPct"]["value"], serde_json::json!(2.0), "the threshold");
        assert_eq!(d["rest.thirdToolPct"]["unit"], serde_json::json!("%"));
        for k in ["rest.overlapMm", "rest.thirdToolPct"] {
            assert_eq!(d[k]["source"], serde_json::json!("seeded"), "{k}");
            // A seeded value says what it is, which is the whole point of the provenance (#436).
            assert!(d[k]["note"].as_str().is_some_and(|n| n.contains("not measured")), "{k}");
        }
        // Written to the document, not only served from an in-memory default.
        assert!(fs::read_to_string(dir.path().join(LOCATION_FILE)).unwrap().contains("rest.thirdToolPct"));
        // And each seed is held to its own rule, which is what makes the value usable as a floor.
        let chosen = |v: f64| ShopDefault {
            value: serde_json::json!(v),
            source: DefaultSource::Chosen,
            set_at: Some("2026-10-16T00:00:00.000Z".into()),
            unit: None,
            note: None,
        };
        assert!(crate::defaults::validate_one("rest.overlapMm", &chosen(25.0)).is_err());
        assert!(crate::defaults::validate_one("rest.thirdToolPct", &chosen(60.0)).is_err());
        crate::defaults::validate_one("rest.overlapMm", &chosen(1.0)).unwrap();
        crate::defaults::validate_one("rest.thirdToolPct", &chosen(5.0)).unwrap();
    }

    #[tokio::test]
    async fn a_default_is_set_guarded_open_to_new_keys_and_reset_to_its_seed() {
        use crate::defaults::{DefaultSource, ShopDefault};
        let (_dir, store) = store();
        let chosen = |v: serde_json::Value| ShopDefault {
            value: v,
            source: DefaultSource::Chosen,
            set_at: Some("2026-10-15T00:00:00.000Z".into()),
            unit: Some("mm".into()),
            note: None,
        };
        assert!(matches!(
            store.put_default("shop.exampleMm", chosen(serde_json::json!(0.5)), None).await,
            Err(HouseError::PreconditionRequired(_))
        ));
        let (_, etag) = store.defaults().await.unwrap();
        // A key this build has never heard of — the peer's — is accepted when well-formed: it has no
        // seed to claim, so it is `chosen`, and a reset removes it rather than restoring one.
        store.put_default("shop.exampleMm", chosen(serde_json::json!(0.5)), Some(&etag)).await.unwrap();
        let (_, etag) = store.defaults().await.unwrap();
        assert!(matches!(
            store.put_default("wasteboard.depthLimitMm", chosen(serde_json::json!(-2)), Some(&etag)).await,
            Err(HouseError::BadEntry(_))
        ));
        store.put_default("wasteboard.depthLimitMm", chosen(serde_json::json!(1.0)), Some(&etag)).await.unwrap();
        // The defaults' ETag is their own: the location view and the shelf did not move.
        let (_, etag) = store.defaults().await.unwrap();
        store.reset_default("wasteboard.depthLimitMm", Some(&etag)).await.unwrap();
        let (_, etag) = store.defaults().await.unwrap();
        store.reset_default("shop.exampleMm", Some(&etag)).await.unwrap();
        let d: serde_json::Value = serde_json::from_slice(&store.defaults().await.unwrap().0).unwrap();
        assert_eq!(d["wasteboard.depthLimitMm"]["source"], serde_json::json!("seeded"), "back to its seed");
        assert!(d.get("shop.exampleMm").is_none(), "an unseeded key is removed");
        // And they travel with the export.
        assert!(String::from_utf8(store.export().await.unwrap()).unwrap().contains("wasteboard.depthLimitMm"));
    }

    #[tokio::test]
    async fn a_moved_address_or_an_import_drops_the_token_and_never_sends_it_elsewhere() {
        // #416 review: the token is a credential for ONE server. Pointing the switch at another
        // address — by the endpoint or by an import — must leave it with no token at all.
        let real = crate::power::tests::fake_ha("tok-1").await;
        let attacker = crate::power::tests::fake_ha("tok-1").await;
        let (_dir, store) = store_with_machine().await;
        let (_, etag) = store.location().await.unwrap();
        store.set_power("m-1", Some(crate::power::tests::a_switch(&real.base_url)), Some(&etag)).await.unwrap();
        store.set_power_token("m-1", "tok-1").await.unwrap();
        assert!(store.power_status("m-1").await.unwrap().has_token);

        // 1. The endpoint moves the address.
        let (_, etag) = store.location().await.unwrap();
        store.set_power("m-1", Some(crate::power::tests::a_switch(&attacker.base_url)), Some(&etag)).await.unwrap();
        let s = store.power_status("m-1").await.unwrap();
        assert!(!s.has_token, "the token followed the address");
        assert!(matches!(store.switch_power("m-1", true).await, Err(HouseError::Conflict(_))));
        assert!(attacker.seen.lock().unwrap().is_empty(), "the other server was sent something");
        let sw_real = crate::power::tests::a_switch(&real.base_url);
        assert_eq!(store.secrets.get(&crate::power::token_account("m-1", &sw_real)).unwrap(), None, "left behind");

        // 2. An import moves it back to the real server: still no token (it was dropped), and an
        //    import that moves a TOKENED switch elsewhere drops that token too.
        let (_, etag) = store.location().await.unwrap();
        store.set_power("m-1", Some(sw_real.clone()), Some(&etag)).await.unwrap();
        store.set_power_token("m-1", "tok-1").await.unwrap();
        let mut doc: serde_json::Value = serde_json::from_slice(&store.export().await.unwrap()).unwrap();
        doc["machines"][0]["power"]["baseUrl"] = serde_json::json!(attacker.base_url);
        store.import(&serde_json::to_vec(&doc).unwrap()).await.unwrap();
        assert!(!store.power_status("m-1").await.unwrap().has_token);
        assert_eq!(store.secrets.get(&crate::power::token_account("m-1", &sw_real)).unwrap(), None);
        assert!(attacker.seen.lock().unwrap().is_empty());

        // An import that keeps the same server keeps the token.
        let (_, etag) = store.location().await.unwrap();
        store.set_power("m-1", Some(sw_real.clone()), Some(&etag)).await.unwrap();
        store.set_power_token("m-1", "tok-1").await.unwrap();
        let same = store.export().await.unwrap();
        store.import(&same).await.unwrap();
        assert!(store.power_status("m-1").await.unwrap().has_token);
    }

    #[tokio::test]
    async fn an_import_cannot_fake_a_seeded_default() {
        let (_dir, store) = store();
        let mut doc: serde_json::Value = serde_json::from_slice(&location_fixture()).unwrap();
        // A seed claimed for a value that is not the seed, and for a key that has none at all.
        for (key, value) in [
            ("power.onWaitSeconds", serde_json::json!(600)),
            ("rest.overlapMm", serde_json::json!(0.6)),
            ("bracket.seatMachineZ", serde_json::json!(-70.2)),
        ] {
            let mut faked = doc.clone();
            faked["defaults"][key] = serde_json::json!({ "value": value, "source": "seeded", "setAt": null, "unit": null });
            let err = store.import(&serde_json::to_vec(&faked).unwrap()).await.unwrap_err();
            assert!(matches!(err, HouseError::BadEntry(_)), "{key}: {err:?}");
            assert!(err.to_string().contains("seeded"), "{err}");
        }
        // The app's own export — seeds at their seed values — still imports.
        doc["defaults"]["power.onWaitSeconds"] = serde_json::json!({ "value": 180.0, "source": "seeded", "setAt": null, "unit": "s" });
        store.import(&serde_json::to_vec(&doc).unwrap()).await.unwrap();
        let exported = store.export().await.unwrap();
        store.import(&exported).await.unwrap();
    }

    #[tokio::test]
    async fn an_item_carries_its_copies_and_collet_fits_through_the_service() {
        // #415. An old inventory (no `copies`) reads unchanged; a described copy round-trips; a copy
        // the item does not own is refused.
        use crate::tool_copy::{Condition, ToolCopy, Whereabouts};
        let (_dir, store) = store();
        let mut item = an_item("inv-1");
        item.quantity = 2;
        item.copies = vec![ToolCopy {
            id: "c-1".into(),
            condition: Some(Condition::Worn),
            whereabouts: Whereabouts::Machine { machine_id: "m-1".into() },
            runtime_warn_minutes: Some(120.0),
            notes: None,
            runtime_minutes: None,
        }];
        item.collet_fits = Some(vec!["m-1".into()]);
        store.create_inventory(item.clone()).await.unwrap();
        let (bytes, etag) = store.inventory().await.unwrap();
        let served: Vec<InventoryItem> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(served[0], item);

        // More copies described than owned: two copies on a quantity of one (#415 review — the old
        // version set quantity 0, which the item's own rule refuses before the copies are looked at).
        let mut too_many = item.clone();
        too_many.quantity = 1;
        too_many.copies.push(ToolCopy {
            id: "c-2".into(),
            condition: Some(Condition::New),
            whereabouts: Whereabouts::Box { case: None },
            runtime_warn_minutes: None,
            notes: None,
            runtime_minutes: None,
        });
        let err = store.update_inventory(too_many, Some(&etag)).await.unwrap_err();
        assert!(err.to_string().contains("only 1 are owned"), "{err}");
        // An item from before #415 parses with no copies and no stated fits.
        let old: InventoryItem = serde_json::from_value(serde_json::json!({
            "id": "inv-9", "tool": serde_json::to_value(a_tool("x")).unwrap(), "quantity": 1,
            "addedAt": "2026-10-08T00:00:00.000Z"
        }))
        .unwrap();
        assert!(old.copies.is_empty() && old.collet_fits.is_none());
    }

    fn a_copy(id: &str, machine: Option<&str>) -> crate::tool_copy::ToolCopy {
        crate::tool_copy::ToolCopy {
            id: id.into(),
            condition: Some(crate::tool_copy::Condition::Worn),
            whereabouts: match machine {
                Some(m) => crate::tool_copy::Whereabouts::Machine { machine_id: m.into() },
                None => crate::tool_copy::Whereabouts::Box { case: None },
            },
            runtime_warn_minutes: None,
            notes: None,
            runtime_minutes: None,
        }
    }

    #[tokio::test]
    async fn a_house_import_keeps_the_copies_the_operator_described() {
        // #415 review, blocking: the Kazoo rebuild (`build-house.ts` → POST /import) writes items with
        // no copies, and must not wipe the conditions.
        use crate::tool_copy::{Condition, ToolCopy, Whereabouts};
        let (_dir, store) = store();
        let mut item = an_item("kz-c1");
        item.quantity = 3;
        item.copies = vec![a_copy("in-spindle", Some("m-1")), a_copy("boxed-1", None), a_copy("boxed-2", None)];
        item.collet_fits = Some(vec!["m-1".into()]);
        store.create_inventory(item.clone()).await.unwrap();

        // Same count: everything carried over.
        let mut rebuilt = HouseDoc::default();
        rebuilt.inventory = vec![an_item("kz-c1")];
        rebuilt.inventory[0].quantity = 3;
        store.import(&serde_json::to_vec(&rebuilt).unwrap()).await.unwrap();
        let served: Vec<InventoryItem> = serde_json::from_slice(&store.inventory().await.unwrap().0).unwrap();
        assert_eq!(served[0].copies, item.copies);
        assert_eq!(served[0].collet_fits, item.collet_fits);

        // The count fell to 1: boxed copies go first, the last-listed first; the spindle copy stays.
        rebuilt.inventory[0].quantity = 1;
        store.import(&serde_json::to_vec(&rebuilt).unwrap()).await.unwrap();
        let served: Vec<InventoryItem> = serde_json::from_slice(&store.inventory().await.unwrap().0).unwrap();
        assert_eq!(served[0].copies.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["in-spindle"]);

        // #491: the label import states ONE BARE COPY PER BOX — its case, and no condition. Same
        // length, so the old operator fields ride along by position and the case is the file's.
        rebuilt.inventory[0].quantity = 1;
        rebuilt.inventory[0].copies = vec![ToolCopy {
            id: "boxed-case".into(),
            condition: None,
            whereabouts: Whereabouts::Box {
                case: Some(crate::tool_copy::CopyCase { colour: "yellow".into(), label: None }),
            },
            runtime_warn_minutes: None,
            notes: None,
            runtime_minutes: None,
        }];
        store.import(&serde_json::to_vec(&rebuilt).unwrap()).await.unwrap();
        let served: Vec<InventoryItem> = serde_json::from_slice(&store.inventory().await.unwrap().0).unwrap();
        assert_eq!(served[0].copies.len(), 1);
        assert_eq!(served[0].copies[0].condition, Some(Condition::Worn), "the old condition carried");
        assert_eq!(
            served[0].copies[0].whereabouts,
            Whereabouts::Box {
                case: Some(crate::tool_copy::CopyCase { colour: "yellow".into(), label: None })
            },
            "the file's case is kept"
        );
        assert_eq!(served[0].collet_fits, Some(vec!["m-1".into()]), "the old fits carried");

        // A file that STATES copies with a condition is the authority for them.
        rebuilt.inventory[0].quantity = 2;
        rebuilt.inventory[0].copies = vec![a_copy("from-file", None)];
        store.import(&serde_json::to_vec(&rebuilt).unwrap()).await.unwrap();
        let served: Vec<InventoryItem> = serde_json::from_slice(&store.inventory().await.unwrap().0).unwrap();
        assert_eq!(served[0].copies.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["from-file"]);
        assert_eq!(served[0].collet_fits, None, "the file stated copies and no fits");
    }

    #[tokio::test]
    async fn an_item_with_no_copies_exports_as_it_did_before_them() {
        // #415 review: an older build refuses unknown keys, so an empty `copies` / null `colletFits`
        // must not be written at all.
        let (_dir, store) = store();
        store.create_inventory(an_item("inv-1")).await.unwrap();
        let exported = String::from_utf8(store.export().await.unwrap()).unwrap();
        assert!(!exported.contains("copies") && !exported.contains("colletFits"), "{exported}");
        let (bytes, _) = store.inventory().await.unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("copies"), "{text}");
    }

    #[tokio::test]
    async fn one_machine_holds_one_cutter_across_the_whole_inventory() {
        let (_dir, store) = store();
        let mut a = an_item("inv-a");
        a.copies = vec![a_copy("a1", Some("m-1"))];
        store.create_inventory(a.clone()).await.unwrap();
        let mut b = an_item("inv-b");
        b.copies = vec![a_copy("b1", Some("m-1"))];
        let err = store.create_inventory(b.clone()).await.unwrap_err();
        assert!(matches!(err, HouseError::Conflict(_)), "{err:?}");
        // Through an import, too: the document is refused whole.
        let mut doc = HouseDoc::default();
        doc.inventory = vec![a, b];
        assert!(matches!(store.import(&serde_json::to_vec(&doc).unwrap()).await, Err(HouseError::BadEntry(_))));
    }
}
