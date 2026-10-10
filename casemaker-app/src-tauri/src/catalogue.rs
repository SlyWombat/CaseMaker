// Makera's catalogue, imported from Studio's own database (#308, tracking #212).
//
// WHAT THIS IS. Makera Studio ships 129 cutters in a local SQLite file. This module reads that
// file and turns it into the `cat:` tier the house service serves: `read_all` is the whole reader,
// `diff` is what a re-sync reports, and `house.rs` is what stores the result. Nothing here knows
// about axum, and nothing here writes to the database.
//
// READ ONLY, AND READ FROM A COPY. The reader is `rusqlite` with the `bundled` SQLite, opened
// SQLITE_OPEN_READ_ONLY, over a **scratch copy** of Studio's file rather than the file itself. That
// is not belt-and-braces: `makera_library.db` belongs to a running application, and this service
// must never take a lock on it, never create a `-journal` or `-wal` beside it, and never leave it
// altered in any way. Copying first makes "we do not touch their file" structural — the only syscalls
// this module makes against their path are a `metadata` of the sidecars it might have and `fs::copy`'s
// read, and neither of those takes a lock or writes a byte. The copy is removed afterwards, best
// effort; a leftover copy in the temp directory is not a document anybody reads.
//
// AND THE COPY IS VERIFIED, BECAUSE A TORN ONE PARSES (#327). A bare copy of a database that is being
// written can be torn, and the tear worth refusing is not the one that fails to open: it is the one
// that opens and answers with FEWER ROWS, where every missing cutter is reported `removed` and its
// feed rows go with it. So there are checks on both sides of the copy. A `-journal` or `-wal` with
// anything in it beside Studio's library means the main file is behind its own writes — rollback mode
// keeps the ORIGINAL pages in the journal while the main file already carries the new ones, and WAL
// keeps new commits in `-wal` until a checkpoint — so the sync refuses and says so, with the one piece
// of advice that fixes it (an EMPTY sidecar is the at-rest state `journal_mode=PERSIST` leaves, and is
// not a pending write). And `PRAGMA integrity_check`, SQLite's own full verification, runs on the copy
// before a single row is read from it. An `immutable=1` URI open would suppress the copy's sidecars
// too, and is not used: a `file:` URI has to be hand-escaped for a Windows temp path (`C:\Users\…`
// with a space in it), and a mis-escaped one fails the whole sync — so the copy is opened by path and
// its sidecars are removed by name instead.
//
// THIS IS NOT `canReadLocalFiles` (#306's flag). That flag decides whether a build may *offer* the
// "read Studio's install on this computer" affordance. Reading the file is a runtime fact about
// where the service is running, exactly as reaching the service is a runtime fact (decision 31):
// the desktop app and a LAN browser served by it get the same catalogue, and the web build gets
// none because there is no service to ask.
//
// THE CATEGORY ID IS THE TOOL TYPE, AND ITS NAME IS NOT IN THE DATABASE. `cutterCategoryId` is the
// same integer the config files call `toolType` (verified against `configure/Contour2DPath.json`:
// "3.175*12mm Flat End(Metal)" is `toolType: 1` and `cutterCategoryId = 1`). `t_CutterCategory` —
// the table that would hold the names — is EMPTY in the real install, so the id→name table below is
// `/Makera-Parity.md` §3's, and the eight shape words are the ones the TS `shapeFromType`
// (`engine/cnc/tool.ts`) derives from those same type strings — a spec there pins the two in step,
// because a cutter whose `type=` text and shape disagree would be imported and then refused by the
// sweep for a reason that has nothing to do with the cutter.
//
// **4 IS A HYPOTHESIS.** §3 lists `Bull Nose` for id 4 and nothing in the real install uses it:
// the counts are 0→18, 1→45, 2→3, 3→22, 5→30, 6→8, 7→3, with 4 absent. It is in the table because
// the id gap and the binary's `Bull Nose` strings both say it is real, and the day Makera ship one
// it should import as a bull nose rather than as "unknown". An id this build has no entry for is
// NOT refused: it is served with `ToolShape::Unknown`, and the sync reports it by name.
//
// EMPTY STRING MEANS UNSET, AND THAT IS NOT THE SAME AS ZERO. Every geometry column in this
// database is nullable in practice, and Studio writes `''` rather than NULL for "no value"
// (`/docs/bench/2026-10-08-makera-library-schema.md`). SQLite keeps `''` as TEXT even in a REAL
// column, so a plain `get::<Option<f64>>` FAILS on the rows that matter — every ball nose, every
// engraver, every thread mill. Reading through `ValueRef` and treating an empty or unparseable
// string as "not stated" is what makes those rows importable at all, and a `0` stays a `0`.
//
// A BALL NOSE STATES ITS BALL IN TWO DIFFERENT PLACES. Category 0 puts the ball diameter in
// `cutterMaxDiameter` and its radius in `cutterCornerRadius` ("3.175*1*3mm Ball Nose(Metal)" →
// 1.0 and 0.5). Category 7 puts only the radius there, and its `cutterMaxDiameter` is the 6 mm
// SHANK ("6*0.5*30.5mm Ball Nose Engraving" → 6.0 and 0.25, i.e. a 0.5 mm ball). So the tip
// diameter is read from the column when the source states it and otherwise derived as 2 × the
// corner radius — for those two ball families only, where the corner radius IS the ball radius.
// A bull nose (4) is deliberately NOT in that set: there the corner radius is a corner, not a ball.
//
// WHAT A RE-SYNC DIFFS ON. `contentHash`, over every column a served row reads — because that is
// the honest definition: if a column reaches the entry, changing it must be reported. `lastUpdateDate`
// is the one exception and is kept as a hint in the extras instead, because it is a vendor workflow
// stamp, not geometry, and a timestamp bump with identical numbers is not a change to a cutter.
//
// AND THE FEEDS (#310). `t_MakeraCutterProperties` — 1 328 rows keyed material × cutter — is read in
// the same pass and stored in the same document, as {@link FeedRow}. It is the STARTING NUMBERS the
// client falls back to for a material no coupon has measured, and it is deliberately the weaker
// tier there: `engine/cnc/feeds.ts` puts it below a measured row and refuses every material name
// this app has no stock for. The row is keyed by the CUTTER (`g_ID`, i.e. `Tool.id`) rather than by
// a diameter range, so it attaches to Makera's cutter wherever it appears — including the built-in
// `flat-3.175x12-metal`, which IS `112111313812`. A row that names no cutter, that leaves one of its
// four numbers empty, or that states a number no cut can use — a `0` or a negative (Studio writes
// `''` for "unset" but a `0` in a numeric column it never filled is a real `0` here, #325), or a
// NON-FINITE one, which `num()` can produce because Rust's `f64` parse accepts "inf" and serde_json
// writes that as `null` (#326) — is DROPPED rather than served short: the client validates the
// document as one array, so one bad row would cost the whole tier, and it validates each number as
// positive AND finite. Dropping it costs one row and is reported.
//
// AND THE TABLE ITSELF (#326). `t_MakeraCutterProperties` not being in the database at all is a
// catalogue with no starting numbers: an empty matrix, and no note. Every OTHER way that query can
// fail — a renamed column, a torn copy, a missing join table — is a read that went WRONG and comes
// back as a sentence. The alternative, which this once did, is the worst shape a sync can have: it
// SUCCEEDS, writes `feeds: []` over 1 328 rows, reports `feedRows: 0` with empty notes, and the
// panel quietly falls back to the starting table with nothing telling the user why.
//
// WHY THE FEED ROWS ARE NOT DIFFED LIKE THE CUTTERS. They have no content hash: the ETag over the
// served bytes is what tells a client they changed, and the report's `feedRows` count is what tells
// a user how many arrived. A cutter is a definition with an identity; a feed row is a number whose
// identity IS the (cutter, material) pair.
//
// WHAT IS DELIBERATELY NOT READ. `t_CustomCutterList`, `t_CutterInventoryList` and `t_SkuMapping`
// are Studio's own — all empty or not ours. `Tool` is not widened by any of this (#212): what the CAM
// view cannot carry lives in `CatalogueExtras`, beside the tool rather than inside it. The feed
// table's `stepOver`, `stepOverPercent` and `coolant` are read by nobody, and `FeedRow` says why.

use crate::house::{HouseError, Tool, ToolShape};
use rusqlite::types::ValueRef;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Studio's directory under the platform's data directory, and its library file. On Windows
/// (`%AppData%\Roaming`) that is exactly where the real install keeps it; on the platforms Studio
/// does not ship for, the path simply does not exist and a sync says so.
pub const STUDIO_DIR: &str = "MakeraStudio";
pub const STUDIO_DB: &str = "makera_library.db";

/// Where Makera Studio's library is, if this platform has a data directory at all.
pub fn studio_db_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(STUDIO_DIR).join(STUDIO_DB))
}

/// The catalogue document's kind. Makera's rows, held locally and never committed (#186).
pub const CATALOGUE_KIND: &str = "casemaker-catalogue";

/// An ISO-8601 UTC timestamp, the shape the client's own timestamps use (`…T12:00:00.000Z`).
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// One imported cutter: the same `{key, tool, provenance}` the client parses, plus what a re-sync
/// needs and what the CAM view has no room for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEntry {
    /// `cat:<cutterId>` — the row's UUID primary key. NOT the 12-digit `g_ID`, which is also
    /// unique here but is the header's business (`Tool.id`), not the row's identity: a re-sync
    /// diffs on the key, and the UUID is what the vendor database is keyed by.
    pub key: String,
    pub tool: Tool,
    pub provenance: String,
    /// FNV-1a over the vendor columns this entry reads. What decides "changed".
    pub content_hash: String,
    #[serde(default)]
    pub extras: CatalogueExtras,
}

/// What Makera states that the CAM view does not carry (#212: "do not widen `Tool`"). Read because
/// the row states it and a re-sync should lose nothing, not because something reads it yet.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueExtras {
    /// The row's UUID. The key is built from it, and `validate` re-checks that it still is.
    pub cutter_id: String,
    /// `cutterCategoryId` — the same integer the config files call `toolType`.
    pub category_id: i64,
    /// The category's name from §3's table, since the database's own is empty.
    pub category_name: String,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Studio's own grouping ("Corn Bits", "Single Flute Non Metal"), and its parent ("Flat End").
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub group_family: Option<String>,
    #[serde(default)]
    pub drill_diameter: Option<f64>,
    #[serde(default)]
    pub pitch: Option<f64>,
    #[serde(default)]
    pub thread_angle: Option<f64>,
    #[serde(default)]
    pub thread_specification: Option<f64>,
    #[serde(default)]
    pub metal_duty: Option<i64>,
    #[serde(default)]
    pub sell_product: Option<i64>,
    /// `lastUpdateDate`: a hint about when Makera touched the row, never the identity of a change.
    #[serde(default)]
    pub vendor_updated_at: Option<String>,
    /// The vendor's `cutterStickoutLength`, which is empty on every row of the real install. It is
    /// NOT copied into `Tool.stickout` — a stick-out is what the Bit Collar Installer set on the
    /// user's own bit, not a catalogue field (#305 design point 1) — so it is kept here, named for
    /// whose claim it is.
    #[serde(default)]
    pub vendor_stickout_length: Option<f64>,
}

impl CatalogueEntry {
    /// The rule for a row this service may serve. The key rule is the house's, inverted: a
    /// catalogue key MUST be `cat:`-namespaced (that namespace is this writer's, and only this
    /// writer's) and must still be the key its own `cutterId` makes.
    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        if self.key.contains('|') {
            return Err(HouseError::BadEntry(format!(
                "{} contains a pipe, which the .nc header's tool line cannot carry",
                self.key
            )));
        }
        let expected = format!("cat:{}", self.extras.cutter_id);
        if self.key != expected {
            return Err(HouseError::BadEntry(format!(
                "{} does not name the cutter row it came from ({expected})",
                self.key
            )));
        }
        if self.provenance.trim().is_empty() {
            return Err(HouseError::BadEntry(format!(
                "{} says nothing about where its numbers came from",
                self.key
            )));
        }
        self.tool.validate()
    }
}

/// One row of `t_MakeraCutterProperties` (#310): the vendor's starting numbers for one of their
/// cutters in one material. Served as-is by `GET /api/v1/feeds` and validated at the client by
/// `FeedCatalogueSchema`, which is why every field is a plain number or a non-empty string.
///
/// FOUR NUMBERS, NOT SEVEN. The table states a spindle speed, a cutting feed, a plunge feed, a
/// step-down, a step-over (twice: in mm and as a percentage of the tip diameter) and a coolant flag.
/// The other three are not served, and each exclusion is a decision rather than an omission:
///
///   - **Step-over** describes the vendor's own pocketing operation. For every flat end mill in wood
///     it is 63 % of the cutting diameter (2.0 mm on the 3.175 mm `112111313812`), and this app's
///     contour-parallel sweep leaves an uncut spine above 50 % (#191) — adopting it would refuse
///     every flat-end wood row in the catalogue. Step-over stays this app's 45 % of the cutter.
///   - **Coolant** is a machining decision about a machine, not a property of a cutter.
///
/// The row is keyed by the CUTTER: `cutterId` is `t_MakeraCutterList.g_ID`, the 12-digit id the
/// `.nc` header calls `id=` and the client carries as `Tool.id`. So the numbers travel with the
/// cutter into every tier, and a cutter with no vendor id can never pick one up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedRow {
    /// `g_ID`. Non-empty on every row of the real install, and a row without one is dropped.
    pub cutter_id: String,
    /// `t_MaterialList.materialSubcategoryName`, VERBATIM — "Hardwood", "6061 Aluminum", "PLA" is
    /// not among them. The client's map decides which of these this app can use; the service serves
    /// the vendor's word rather than a translation it would have to keep in step.
    pub material: String,
    /// `spindleSpeed`, RPM.
    pub rpm: f64,
    /// `feedRate`, mm/min.
    pub feed: f64,
    /// `plungeFeedRate`, mm/min.
    pub plunge_feed: f64,
    /// `stepDown`, mm per depth pass.
    pub step_down: f64,
}

/// `catalogue.json` — Makera's list as a sync imported it, local to this machine and never
/// committed (`/Fabrication.md` §3, #186). Read by the house store, written only by a sync.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueDoc {
    pub kind: String,
    pub schema_version: u32,
    /// When the last sync ran. Provenance, never a freshness claim: what a row says is what
    /// matters, not how old the file is.
    #[serde(default)]
    pub synced_at: Option<String>,
    #[serde(default)]
    pub tools: Vec<CatalogueEntry>,
    /// The feed matrix (#310). Defaulted, like every field added after the first release: a
    /// `catalogue.json` written by #308 parses as a catalogue with no feed rows, which is a state
    /// a re-sync fixes rather than an error (`GET /api/v1/health` reports it as `feedRows: 0`).
    #[serde(default)]
    pub feeds: Vec<FeedRow>,
    /// What the last sync came to (#328): the counts and the notes, so a restart — or a second
    /// client on the LAN — can still see what the sync said. Defaulted, like every field added after
    /// the first release: #320's strictness is about SHAPE, not absence, and a `catalogue.json`
    /// written before this field is a catalogue whose last sync simply went unrecorded.
    #[serde(default)]
    pub last_sync: Option<SyncSummary>,
}

impl Default for CatalogueDoc {
    fn default() -> Self {
        CatalogueDoc {
            kind: CATALOGUE_KIND.to_string(),
            schema_version: crate::house::HOUSE_SCHEMA_VERSION,
            synced_at: None,
            tools: Vec::new(),
            feeds: Vec::new(),
            last_sync: None,
        }
    }
}

/// How much a note weighs (#328). An emptied feed matrix or a replaced catalogue file is a LOSS —
/// something the user had is gone, and only a re-sync against a better database brings it back. An
/// unknown category or a handful of unusable cells is INFORMATION: the sync did what it could and
/// says so. The distinction travels with the note rather than being read back out of its wording,
/// because the panel that renders them must not have to parse English to decide what to colour.
///
/// A LARGE drop of feed cells is still `Info` unless the matrix emptied: there is no threshold here,
/// and inventing one would be a judgement about the vendor's data this module has no basis for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncNoteKind {
    Info,
    Loss,
}

/// One sentence about a sync that still succeeded, and its weight.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncNote {
    pub kind: SyncNoteKind,
    pub text: String,
}

impl SyncNote {
    pub fn info(text: impl Into<String>) -> SyncNote {
        SyncNote { kind: SyncNoteKind::Info, text: text.into() }
    }

    pub fn loss(text: impl Into<String>) -> SyncNote {
        SyncNote { kind: SyncNoteKind::Loss, text: text.into() }
    }
}

/// What the last sync came to, as `catalogue.json` keeps it across a restart (#328). The counts and
/// the notes, and NOT the added/removed/changed lists: those are a diff against a catalogue that no
/// longer exists, so a restart has nothing to show them against. The house is the authority
/// (decision 31) and the same service answers a LAN browser and the desktop, so this lives on the
/// service — a browser remembering its own last sync would make each client remember a different one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    #[serde(default)]
    pub synced_at: Option<String>,
    pub source: String,
    pub total: usize,
    #[serde(default)]
    pub feed_rows: usize,
    #[serde(default)]
    pub notes: Vec<SyncNote>,
}

impl From<&SyncReport> for SyncSummary {
    fn from(r: &SyncReport) -> Self {
        SyncSummary {
            synced_at: r.synced_at.clone(),
            source: r.source.clone(),
            total: r.total,
            feed_rows: r.feed_rows,
            notes: r.notes.clone(),
        }
    }
}

/// What one sync found. The counts and the keys, so "nothing changed" and "these eleven cutters
/// changed" are both things the user can be told (#311's panel), and `notes` carries what is worth
/// saying about a sync that still succeeded.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// The vendor database this read, named so a user with two installs can see which one it was.
    pub source: String,
    #[serde(default)]
    pub synced_at: Option<String>,
    pub total: usize,
    #[serde(default)]
    pub added: Vec<String>,
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default)]
    pub changed: Vec<String>,
    pub unchanged: usize,
    /// How many feed rows the catalogue now holds (#310). A COUNT and not a diff: a feed row has no
    /// identity beyond its (cutter, material) pair, so "added" and "changed" are not the same
    /// question for it — the served `ETag` is what says the matrix moved.
    #[serde(default)]
    pub feed_rows: usize,
    /// Sentences about this sync that are not failures: a replaced unreadable file, a category
    /// this build does not know. Each carries its weight (#328).
    #[serde(default)]
    pub notes: Vec<SyncNote>,
}

/// Added, removed, changed — by key. The one place a re-sync decides what happened.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Change {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
    pub unchanged: usize,
}

/// Compare what is stored against what was just read. Order comes from the new rows (`added`,
/// `changed`) and from the old ones (`removed`), so a report reads in catalogue order rather than
/// in hash order.
pub fn diff(previous: &[CatalogueEntry], next: &[CatalogueEntry]) -> Change {
    let before: HashMap<&str, &CatalogueEntry> =
        previous.iter().map(|e| (e.key.as_str(), e)).collect();
    let after: HashSet<&str> = next.iter().map(|e| e.key.as_str()).collect();
    let mut change = Change::default();
    for entry in next {
        match before.get(entry.key.as_str()) {
            None => change.added.push(entry.key.clone()),
            Some(old) if old.content_hash != entry.content_hash => {
                change.changed.push(entry.key.clone())
            }
            Some(_) => change.unchanged += 1,
        }
    }
    change.removed = previous
        .iter()
        .filter(|e| !after.contains(e.key.as_str()))
        .map(|e| e.key.clone())
        .collect();
    change
}

/// What one read produced: the rows, plus anything worth saying about them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Imported {
    pub entries: Vec<CatalogueEntry>,
    /// The feed matrix (#310), in catalogue order.
    pub feeds: Vec<FeedRow>,
    pub notes: Vec<SyncNote>,
}

/// Read every cutter Studio knows about, from a scratch copy of its database.
///
/// Fails with a sentence rather than an empty list whenever the file is missing, is not a Makera
/// library, or has a shape this build does not understand — a sync that silently imported nothing
/// would be indistinguishable from "Makera never changed anything". Since #327 that list also holds the
/// two ways a copy can be a LIE: a `-journal` or `-wal` with something in it beside the vendor's own
/// file (the main file is behind its own writes, so a copy of it alone is missing a transaction), and
/// a copy that does not pass `PRAGMA integrity_check`.
pub fn read_all(db: &Path) -> Result<Imported, String> {
    read_all_in(db, &std::env::temp_dir())
}

/// The same read, with the directory the scratch copy is made in named explicitly.
///
/// The seam is for tests (#327), and it is the same sort as `HouseStore::open_with`'s vendor path: a
/// test asserting "a read leaves nothing behind" can only make that claim about a directory nothing
/// else is using. Every test in this binary reads in parallel, so a copy that is alive in another
/// thread at the instant the process-wide temp directory is listed is not a leak — while a copy made
/// in the test's own directory and not removed is exactly one.
fn read_all_in(db: &Path, scratch_dir: &Path) -> Result<Imported, String> {
    read_all_around(db, scratch_dir, || {})
}

/// The same read, with a hook that runs BETWEEN the copy and the check that follows it.
///
/// A test seam and nothing else (#339): the sidecar check below runs on both sides of the copy, and
/// the only way to exercise the second side is to put a sidecar there after the first has looked.
/// The hook is a no-op for every caller that is not a test.
fn read_all_around(
    db: &Path,
    scratch_dir: &Path,
    after_copy: impl FnOnce(),
) -> Result<Imported, String> {
    if !db.exists() {
        return Err(format!(
            "{}: Makera Studio's library is not there",
            db.display()
        ));
    }
    if let Some(sidecar) = pending_write_beside(db) {
        return Err(pending_write(db, &sidecar));
    }
    let copy = scratch_path(scratch_dir);
    std::fs::copy(db, &copy)
        .map_err(|e| format!("{}: could not be read: {e}", db.display()))?;
    after_copy();
    // The same check AGAIN, now that the copy is done (#339). The one before the copy is a
    // point-in-time answer: a Studio commit that begins between it and the copy produces a copy
    // whose sidecar was never seen, and `integrity_check` catches a copy that is physically torn —
    // not one that is logically torn, where one table's pages landed and a sibling's did not. A
    // sidecar that is there now may have appeared after the copy finished, in which case the copy
    // is whole; but from here the two cannot be told apart, and the refusal costs one re-sync where
    // the alternative costs cutters reported removed.
    let read = match pending_write_beside(db) {
        Some(sidecar) => Err(pending_write(db, &sidecar)),
        None => read_copy(&copy, db),
    };
    // The copy is ours and is not a document: leave nothing behind, and never let a failure to
    // remove it change the answer. The sidecars go too (#327): a read-only open of a database in WAL
    // mode creates `-wal` and `-shm` beside it, and the cleanup that removed only the copy left those
    // in the temp directory for good.
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let mut os = copy.as_os_str().to_os_string();
        os.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(os));
    }
    read
}

/// The refusal for a sidecar with something in it (#327), in ONE wording whichever side of the copy
/// found it: the fact is the same, and the advice that fixes it is the same.
fn pending_write(db: &Path, sidecar: &Path) -> String {
    format!(
        "{}: {} is beside it, so the database holds a transaction that has not reached the main \
         file — a copy taken now would be missing it, and the cutters it touches would be \
         reported removed. Open Makera Studio and close it again, then sync",
        db.display(),
        sidecar
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| sidecar.display().to_string())
    )
}

/// The `-journal` or `-wal` beside Studio's library, when it says the main file is behind (#327).
///
/// Both journal modes keep the not-yet-committed part of a write in a sidecar: rollback mode holds the
/// ORIGINAL pages in `-journal` while the main file already carries the new ones, and WAL mode holds
/// new commits in `-wal` until a checkpoint. A bare copy takes the main file alone, so while either
/// exists the copy is a database that is missing whatever the sidecar has — and missing silently,
/// which is the shape this whole module refuses.
///
/// A ZERO-LENGTH sidecar is NOT a pending write: `journal_mode=PERSIST` leaves an empty `-journal`
/// behind after every commit and a fully checkpointed `-wal` can be empty too, so size is the test
/// and the at-rest states are not refused.
fn pending_write_beside(db: &Path) -> Option<PathBuf> {
    ["-journal", "-wal"].into_iter().find_map(|suffix| {
        let mut os = db.as_os_str().to_os_string();
        os.push(suffix);
        let sidecar = PathBuf::from(os);
        match std::fs::metadata(&sidecar) {
            Ok(m) if m.len() > 0 => Some(sidecar),
            _ => None,
        }
    })
}

static COPY_SEQ: AtomicU64 = AtomicU64::new(0);

/// A name no other sync in this process can be using. Two syncs at once would otherwise read each
/// other's half-written copy, which is a data error a user could not diagnose.
fn scratch_path(dir: &Path) -> PathBuf {
    let n = COPY_SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("casemaker-studio-{}-{n}.db", std::process::id()))
}

/// The refusal for a copy that cannot be trusted to be a whole database (#327), in ONE wording
/// whether it was `PRAGMA integrity_check` that found the damage or the first query that could not
/// read a page — from here the two are the same fact.
fn torn(source: &Path, why: impl std::fmt::Display) -> String {
    format!(
        "{}: the copy did not verify, so reading it would import a partial catalogue ({why})",
        source.display()
    )
}

/// Does this error mean the FILE could not be read, rather than simply not holding our tables?
///
/// The distinction is the difference between "you pointed me at the wrong file" and "this file is
/// damaged" (#327): a valid SQLite database that has never heard of Makera answers with "no such
/// table" and is refused as the wrong file, while a torn copy answers with a corruption code and is
/// refused as a copy that did not verify. Without this, a half-written library is reported as "not a
/// Makera Studio library", which sends the user looking for an entirely different problem.
fn unreadable(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(err, _)
            if matches!(
                err.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            )
    )
}

/// Verify a copy before anything is read out of it (#327).
///
/// A bare `fs::copy` of a live database can be a TORN database, and the bad tear is not the one that
/// fails to open or fails to query — it is the one that parses and answers with FEWER ROWS, because
/// every cutter that went missing is then reported `removed` and its feed rows go with it, silently,
/// until somebody happens to re-sync. `integrity_check` is SQLite's own full verification and so a
/// superset of the `quick_check` #327 named: the difference between them is the index-versus-table
/// cross-check and the UNIQUE checks, and an index whose entries disagree with its table is exactly
/// what a main file written without its journal looks like — with this module's own SELECTs joining
/// through the `t_MakeraCutterList.cutterId` primary-key index, a `quick_check`-clean copy can still
/// answer the wrong rows.
///
/// Both the pragma failing and the pragma reporting are refusals, worded the same way, because from
/// here they are the same fact: this copy is not a database to import a catalogue from.
fn verify_copy(conn: &rusqlite::Connection, source: &Path) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA integrity_check")
        .map_err(|e| torn(source, e))?;
    let problems: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| torn(source, e))?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|e| torn(source, e))?;
    if problems.len() == 1 && problems[0].eq_ignore_ascii_case("ok") {
        return Ok(());
    }
    let why = match problems.split_first() {
        Some((first, [])) => first.clone(),
        Some((first, rest)) => format!("{first}, and {} more", rest.len()),
        None => "no result".to_string(),
    };
    Err(torn(source, why))
}

fn read_copy(copy: &Path, source: &Path) -> Result<Imported, String> {
    let conn = rusqlite::Connection::open_with_flags(
        copy,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("{}: could not be opened: {e}", source.display()))?;

    let mut stmt = conn.prepare(SELECT_CUTTERS).map_err(|e| match unreadable(&e) {
        // A copy the first query cannot even read is refused as damage, not as the wrong file
        // (#327): the two need different things from the user, and only one of them is their mistake.
        true => torn(source, e),
        false => format!(
            "{}: this is not a Makera Studio library ({e})",
            source.display()
        ),
    })?;
    // Verified before a row is read from it (#327).
    verify_copy(&conn, source)?;
    let rows = stmt
        .query_map([], Row::from_sql)
        .map_err(|e| format!("{}: {e}", source.display()))?;

    let mut entries = Vec::new();
    let mut unknown: BTreeMap<i64, usize> = BTreeMap::new();
    for row in rows {
        let row = row.map_err(|e| format!("{}: {e}", source.display()))?;
        let category = category(row.category.unwrap_or(-1));
        let (type_text, shape) = match &category {
            Some(c) => (c.name.to_string(), c.shape),
            None => {
                let id = row.category.unwrap_or(-1);
                *unknown.entry(id).or_insert(0) += 1;
                (format!("Category {id}"), ToolShape::Unknown)
            }
        };
        entries.push(row.to_entry(&type_text, shape));
    }

    let mut notes = Vec::new();
    if !unknown.is_empty() {
        let ids: Vec<String> = unknown.keys().map(|id| id.to_string()).collect();
        let count: usize = unknown.values().sum();
        notes.push(SyncNote::info(format!(
            "{count} cutters are in a category this build does not know (id {}): they are served \
             with no `type=` text and shape `unknown`",
            ids.join(", ")
        )));
    }
    let (feeds, feed_note) = read_feeds(&conn, source)?;
    if let Some(note) = feed_note {
        // Information, whatever the count (#328): rows that no cutter could have been given were
        // dropped, and the matrix is still there. The loss case — the matrix emptied — is decided
        // one level up, in `house.rs::sync_catalogue`, which is the only place that can see what
        // was stored before.
        notes.push(SyncNote::info(note));
    }
    Ok(Imported {
        entries,
        feeds,
        notes,
    })
}

/// The feed matrix (#310), in catalogue order.
///
/// A row is served only when it is COMPLETE AND USABLE: a cutter id, a material name, and four
/// numbers that are each a positive finite number. The check is here because the client validates the
/// document as one array AND every number in it as positive and finite (#325, #326) — a single null,
/// a single `0`, or a single `inf` would cost the entire feed tier, where dropping the row costs one
/// row that no cutter could be given anyway. What was dropped is named in a note.
///
/// A row that is merely ABSURD is served, not dropped: 32 of Makera's rows state 15 000 RPM on a
/// 13 000 RPM spindle, which is a real vendor number for a real cutter, and `feedsFor` clamps it and
/// says so. Positive-and-finite is the line drawn here, because it is the line the client's schema
/// draws; what to do about a number the machine cannot run is the resolver's business, not the
/// reader's.
///
/// A FAILED QUERY IS NOT AN EMPTY TABLE (#326). The two are told apart by asking what the error says,
/// because they are not distinguishable by code — a missing table and a missing column are both
/// `SQLITE_ERROR` — and the check is deliberately for the ONE table whose absence is legitimate.
fn read_feeds(conn: &rusqlite::Connection, source: &Path) -> Result<(Vec<FeedRow>, Option<String>), String> {
    let mut stmt = match conn.prepare(SELECT_FEEDS) {
        Ok(stmt) => stmt,
        Err(e) if absent_feed_table(&e) => return Ok((Vec::new(), None)),
        Err(e) => {
            return Err(format!(
                "{}: the feed matrix could not be read ({e})",
                source.display()
            ))
        }
    };
    let rows = stmt
        .query_map([], |r| {
            Ok((
                text(r.get_ref(0)?),
                text(r.get_ref(1)?),
                num(r.get_ref(2)?),
                num(r.get_ref(3)?),
                num(r.get_ref(4)?),
                num(r.get_ref(5)?),
            ))
        })
        .map_err(|e| format!("{}: {e}", source.display()))?;

    let mut feeds = Vec::new();
    let mut incomplete: usize = 0;
    for row in rows {
        let (cutter_id, material, rpm, feed, plunge_feed, step_down) =
            row.map_err(|e| format!("{}: {e}", source.display()))?;
        match (cutter_id, material, rpm, feed, plunge_feed, step_down) {
            // Every number POSITIVE AND FINITE (#325, #326): `num()` reads Studio's `0` as a
            // perfectly good `0.0`, and it also reads the TEXT `inf` — Rust's `f64` parse accepts it
            // — which is a number no cut can use and one serde_json would write as `null`. Servable
            // is not the same question as sane: an absurd-but-positive row goes through (the doc
            // above), and `feedsFor` decides what to do with it.
            (Some(cutter_id), Some(material), Some(rpm), Some(feed), Some(plunge_feed), Some(step_down))
                if [rpm, feed, plunge_feed, step_down]
                    .iter()
                    .all(|n| n.is_finite() && *n > 0.0) =>
            {
                feeds.push(FeedRow {
                    cutter_id,
                    material,
                    rpm,
                    feed,
                    plunge_feed,
                    step_down,
                });
            }
            _ => incomplete += 1,
        }
    }
    let note = (incomplete > 0).then(|| {
        format!(
            "{incomplete} feed rows name no cutter, leave one of their four numbers empty, or state \
             a number that is not positive and finite: they are not served"
        )
    });
    Ok((feeds, note))
}

/// Is this prepare error the ONE benign case: `t_MakeraCutterProperties` simply not being in the
/// database (#326)?
///
/// A catalogue that never held feeds is a catalogue, and `read_feeds` answers it with an empty matrix
/// and no note. Everything else the query can fail on is a read that went wrong and must be said out
/// loud — a renamed column, a torn copy, a `t_MaterialList` that is not there either.
///
/// THE MESSAGE IS THE DISCRIMINATOR, and that is a measured fact rather than a preference: SQLite
/// reports "no such table" and "no such column" with the SAME code (`SQLITE_ERROR`, which rusqlite
/// maps to `ErrorCode::Unknown`), so the code cannot tell the benign case from the dangerous one. The
/// table is named in the match, so a missing JOIN table — which would empty the matrix with no note
/// at all — is refused rather than swallowed.
fn absent_feed_table(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(_, Some(m))
            if m.contains("no such table") && m.contains("t_MakeraCutterProperties")
    )
}

/// The one SELECT (#308). A LEFT JOIN for the group's name and one more for its parent's: the
/// vendor's grouping is the one thing a browsing UI (#311) cannot reconstruct, since the group
/// names live in a table and the category names do not live anywhere at all.
const SELECT_CUTTERS: &str = "
    SELECT l.cutterId, l.cutterName, l.cutterNumber, l.cutterCategoryId, l.groupId,
           g.name, p.name,
           l.cutterDiameter, l.cutterStickoutLength, l.cutterShoulderLength, l.cutterFluteLength,
           l.cutterMaxDiameter, l.cutterTipDiameter, l.cutterCornerRadius,
           l.cutterAngle, l.cutterHalfAngle,
           l.threadSpecification, l.pitch, l.threadAngle, l.drillDiameter,
           l.sellProduct, l.g_ID, l.metalDuty, l.lastUpdateDate
      FROM t_MakeraCutterList l
      LEFT JOIN t_MakeraCutterGroup g ON g.cutterGroupid = l.groupId
      LEFT JOIN t_MakeraCutterGroup p ON p.cutterGroupid = g.parentId
     ORDER BY l.cutterCategoryId, l.cutterName, l.cutterId";

/// The feed matrix (#310). The cutter is reached through the row's `cutterID`, which is the UUID a
/// re-sync keys on, and the material's NAME through its `materialId` — the four numbers and nothing
/// else of the seven the table states (`FeedRow` says why).
///
/// Both joins are INNER on purpose: a row with no cutter to attach to, or no material to name, is a
/// row about nothing and is invisible here. A row that DOES join and then turns out to be incomplete
/// — Studio's `''` in a numeric column, or a cutter with no `g_ID` — is counted and reported, because
/// that one names something real.
const SELECT_FEEDS: &str = "
    SELECT l.g_ID, m.materialSubcategoryName,
           p.spindleSpeed, p.feedRate, p.plungeFeedRate, p.stepDown
      FROM t_MakeraCutterProperties p
      JOIN t_MakeraCutterList l ON l.cutterId = p.cutterID
      JOIN t_MaterialList m ON m.materialID = p.materialId
     ORDER BY l.g_ID, m.materialSubcategoryName";

/// One row of `t_MakeraCutterList`, as read. Kept as its own type so the hash and the mapping read
/// the same values: `content_hash` must cover exactly what `to_entry` uses, and one struct is how
/// that stays true.
struct Row {
    cutter_id: String,
    group_id: Option<String>,
    group_name: Option<String>,
    group_family: Option<String>,
    name: Option<String>,
    number: Option<i64>,
    category: Option<i64>,
    diameter: Option<f64>,
    stickout: Option<f64>,
    shoulder: Option<f64>,
    flute: Option<f64>,
    max_diameter: Option<f64>,
    tip_diameter: Option<f64>,
    corner_radius: Option<f64>,
    angle: Option<f64>,
    half_angle: Option<f64>,
    thread_specification: Option<f64>,
    pitch: Option<f64>,
    thread_angle: Option<f64>,
    drill_diameter: Option<f64>,
    sell_product: Option<i64>,
    g_id: Option<String>,
    metal_duty: Option<i64>,
    updated_at: Option<String>,
}

impl Row {
    fn from_sql(r: &rusqlite::Row) -> rusqlite::Result<Row> {
        Ok(Row {
            cutter_id: text(r.get_ref(0)?).unwrap_or_default(),
            name: text(r.get_ref(1)?),
            number: int(r.get_ref(2)?),
            category: int(r.get_ref(3)?),
            group_id: text(r.get_ref(4)?),
            group_name: text(r.get_ref(5)?),
            group_family: text(r.get_ref(6)?),
            diameter: num(r.get_ref(7)?),
            stickout: num(r.get_ref(8)?),
            shoulder: num(r.get_ref(9)?),
            flute: num(r.get_ref(10)?),
            max_diameter: num(r.get_ref(11)?),
            tip_diameter: num(r.get_ref(12)?),
            corner_radius: num(r.get_ref(13)?),
            angle: num(r.get_ref(14)?),
            half_angle: num(r.get_ref(15)?),
            thread_specification: num(r.get_ref(16)?),
            pitch: num(r.get_ref(17)?),
            thread_angle: num(r.get_ref(18)?),
            drill_diameter: num(r.get_ref(19)?),
            sell_product: int(r.get_ref(20)?),
            g_id: text(r.get_ref(21)?),
            metal_duty: int(r.get_ref(22)?),
            updated_at: text(r.get_ref(23)?),
        })
    }

    /// Every column this entry reads, in a fixed order, with the field name in front of each value.
    /// `lastUpdateDate` is the one column left out, and by name rather than by accident: it says
    /// when Makera touched the row, not what the row says.
    fn canonical(&self) -> String {
        let mut s = String::new();
        let mut put = |name: &str, value: String| {
            s.push('\u{1f}');
            s.push_str(name);
            s.push('=');
            s.push_str(&value);
        };
        put("cutterId", self.cutter_id.clone());
        put("cutterName", self.name.clone().unwrap_or_default());
        put("cutterNumber", opt_i(self.number));
        put("cutterCategoryId", opt_i(self.category));
        put("groupId", self.group_id.clone().unwrap_or_default());
        put("cutterDiameter", opt_f(self.diameter));
        put("cutterStickoutLength", opt_f(self.stickout));
        put("cutterShoulderLength", opt_f(self.shoulder));
        put("cutterFluteLength", opt_f(self.flute));
        put("cutterMaxDiameter", opt_f(self.max_diameter));
        put("cutterTipDiameter", opt_f(self.tip_diameter));
        put("cutterCornerRadius", opt_f(self.corner_radius));
        put("cutterAngle", opt_f(self.angle));
        put("cutterHalfAngle", opt_f(self.half_angle));
        put("threadSpecification", opt_f(self.thread_specification));
        put("pitch", opt_f(self.pitch));
        put("threadAngle", opt_f(self.thread_angle));
        put("drillDiameter", opt_f(self.drill_diameter));
        put("sellProduct", opt_i(self.sell_product));
        put("g_ID", self.g_id.clone().unwrap_or_default());
        put("metalDuty", opt_i(self.metal_duty));
        s
    }

    /// The one place a vendor row becomes something this app serves. `type_text`/`shape` come from
    /// the category table, and the group names from the join, so this method reads only its own
    /// fields.
    fn to_entry(&self, type_text: &str, shape: ToolShape) -> CatalogueEntry {
        // A ball family states its ball as the corner radius when it does not state a tip.
        let tip_diameter = self
            .tip_diameter
            .or_else(|| if is_ball(self.category) { self.corner_radius.map(|r| 2.0 * r) } else { None });
        let tool = Tool {
            number: self.number,
            id: self.g_id.clone(),
            name: self.name.clone().unwrap_or_default(),
            type_text: type_text.to_string(),
            shape,
            handle_diameter: self.diameter,
            tip_diameter,
            diameter: self.max_diameter,
            corner_radius: self.corner_radius,
            angle: self.angle,
            half_angle: self.half_angle,
            flute_length: self.flute,
            shoulder_length: self.shoulder,
            // A catalogue row has no stick-out: it is what the collar set on THIS user's bit
            // (#305 design point 1). The vendor's claim, empty everywhere in practice, is kept in
            // the extras rather than served as if it were an installation.
            stickout: None,
            // Nothing in the catalogue says whether a cutter is centre-cutting (#220).
            centre_cutting: None,
        };
        CatalogueEntry {
            key: format!("cat:{}", self.cutter_id),
            provenance: match &self.g_id {
                Some(g) => format!("Makera catalogue {g}"),
                None => format!("Makera catalogue {}", self.cutter_id),
            },
            content_hash: crate::etag::fnv1a_hex(self.canonical().as_bytes()),
            extras: CatalogueExtras {
                cutter_id: self.cutter_id.clone(),
                category_id: self.category.unwrap_or(-1),
                category_name: type_text.to_string(),
                group_id: self.group_id.clone(),
                group_name: self.group_name.clone(),
                group_family: self.group_family.clone(),
                drill_diameter: self.drill_diameter,
                pitch: self.pitch,
                thread_angle: self.thread_angle,
                thread_specification: self.thread_specification,
                metal_duty: self.metal_duty,
                sell_product: self.sell_product,
                vendor_updated_at: self.updated_at.clone(),
                vendor_stickout_length: self.stickout,
            },
            tool,
        }
    }
}

fn opt_f(v: Option<f64>) -> String {
    match v {
        Some(f) if f.is_finite() => format!("{f}"),
        _ => String::new(),
    }
}

fn opt_i(v: Option<i64>) -> String {
    v.map(|i| i.to_string()).unwrap_or_default()
}

/// The category ids whose `cutterCornerRadius` is the BALL radius rather than a corner radius.
fn is_ball(category: Option<i64>) -> bool {
    matches!(category, Some(0) | Some(7))
}

struct Category {
    name: &'static str,
    shape: ToolShape,
}

/// `/Makera-Parity.md` §3's table. `cutterCategoryId == toolType`, so this is also "which operation
/// can use this cutter". See the module doc for why 4 is here and why an unknown id is not refused.
fn category(id: i64) -> Option<Category> {
    let (name, shape) = match id {
        0 => ("Ball Nose", ToolShape::Ball),
        1 => ("Flat End", ToolShape::Flat),
        2 => ("Chamfer", ToolShape::Chamfer),
        3 => ("Engraving", ToolShape::Engraving),
        4 => ("Bull Nose", ToolShape::Bull),
        5 => ("Drill", ToolShape::Drill),
        6 => ("Thread", ToolShape::Thread),
        7 => ("Ball Nose Engraving", ToolShape::Ball),
        _ => return None,
    };
    Some(Category { name, shape })
}

/// SQLite gives a column back as whatever was stored in it, not as what its declared type promises:
/// Studio writes `''` into REAL columns to mean "unset", and `''` is TEXT. These three are the whole
/// of the empty-string trap (#307's dump, the importer section).
fn num(v: ValueRef<'_>) -> Option<f64> {
    match v {
        ValueRef::Integer(i) => Some(i as f64),
        ValueRef::Real(f) => Some(f),
        ValueRef::Text(t) => std::str::from_utf8(t).ok()?.trim().parse().ok(),
        ValueRef::Null | ValueRef::Blob(_) => None,
    }
}

fn int(v: ValueRef<'_>) -> Option<i64> {
    match v {
        ValueRef::Integer(i) => Some(i),
        ValueRef::Real(f) => Some(f as i64),
        ValueRef::Text(t) => std::str::from_utf8(t).ok()?.trim().parse().ok(),
        ValueRef::Null | ValueRef::Blob(_) => None,
    }
}

fn text(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Text(t) => {
            let s = String::from_utf8_lossy(t).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Null | ValueRef::Blob(_) => None,
    }
}

/// A Makera library to read in tests.
///
/// `pub(crate)` because the store's own tests (`house.rs`) need a sync to run against (#308): the
/// real install is not something a test may depend on, and the fixture that stands in for it is
/// this one. The DDL is copied verbatim from the real database and the rows are written the way
/// Studio writes them — an empty string for "no value" — so the emptiness trap is reproduced by the
/// fixture rather than described by a comment.
#[cfg(test)]
pub(crate) mod fixture {
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    const CUTTERS: &str = "CREATE TABLE t_MakeraCutterList (cutterId TEXT PRIMARY KEY NOT NULL, \
        groupId TEXT, cutterName TEXT, cutterNumber INTEGER, cutterCategoryId INTEGER, \
        cutterDiameter REAL, cutterStickoutLength REAL, cutterShoulderLength REAL, \
        cutterFluteLength REAL, cutterMaxDiameter REAL, cutterTipDiameter REAL, \
        cutterCornerRadius REAL, cutterAngle REAL, cutterHalfAngle REAL, threadSpecification REAL, \
        pitch REAL, threadAngle REAL, drillDiameter REAL, sellProduct INTEGER, g_ID TEXT, \
        metalDuty INTEGER, lastUpdateDate TEXT)";
    const GROUPS: &str = "CREATE TABLE t_MakeraCutterGroup (cutterGroupid TEXT PRIMARY KEY NOT \
        NULL, name TEXT, parentId TEXT, lastUpdateDate TEXT)";
    // #310's two tables, DDL verbatim from the real database: the feed matrix, and the material
    // names it is keyed by. `p.cutterID` is the cutter's UUID and `m.materialID` the material's —
    // two different keys, neither of which is the 12-digit `g_ID` the client sees.
    const PROPERTIES: &str = "CREATE TABLE t_MakeraCutterProperties (propertiesId TEXT PRIMARY KEY \
        NOT NULL, materialId TEXT, cutterID TEXT, spindleSpeed INTEGER, feedRate INTEGER, \
        plungeFeedRate REAL, stepDown REAL, stepOver REAL, stepOverPercent REAL, coolant INTEGER)";
    const MATERIALS: &str = "CREATE TABLE t_MaterialList (materialID TEXT PRIMARY KEY NOT NULL, \
        materialCategoryID TEXT, materialSubcategoryName TEXT, lastUpdateDate TEXT)";

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// One cutter row. Every field defaults to "Studio says nothing", which is what most of the 129
    /// real rows say about most columns.
    #[derive(Default, Clone)]
    pub(crate) struct Cutter {
        pub cutter_id: String,
        pub group_id: String,
        pub name: String,
        pub number: i64,
        pub category: i64,
        pub diameter: Option<f64>,
        pub stickout: Option<f64>,
        pub shoulder: Option<f64>,
        pub flute: Option<f64>,
        pub max_diameter: Option<f64>,
        pub tip: Option<f64>,
        pub corner: Option<f64>,
        pub angle: Option<f64>,
        pub half_angle: Option<f64>,
        pub thread_spec: Option<f64>,
        pub pitch: Option<f64>,
        pub thread_angle: Option<f64>,
        pub drill: Option<f64>,
        pub sell_product: Option<i64>,
        pub g_id: String,
        pub metal_duty: Option<i64>,
        pub updated: String,
    }

    impl Cutter {
        /// A row named and categorised, with a fresh `cutterId` and the `g_ID` the header would
        /// carry.
        pub(crate) fn new(name: &str, category: i64) -> Cutter {
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            Cutter {
                cutter_id: format!("019c049a-8169-7a1e-ace2-{n:012}"),
                name: name.to_string(),
                number: (n as i64 % 6) + 1,
                category,
                g_id: format!("1121113138{n:02}"),
                updated: "2026-05-20 00:00:00".to_string(),
                ..Cutter::default()
            }
        }
    }

    /// A Makera library at `path`, empty. `write` the rows, then read it.
    pub(crate) fn db(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute(CUTTERS, []).unwrap();
        conn.execute(GROUPS, []).unwrap();
        conn.execute(PROPERTIES, []).unwrap();
        conn.execute(MATERIALS, []).unwrap();
        conn
    }

    /// One `t_MakeraCutterProperties` row: four numbers for one cutter in one material. Every
    /// number defaults to "Studio says nothing", which is the shape a dropped row has.
    #[derive(Default, Clone)]
    pub(crate) struct Feed {
        pub id: String,
        pub material_id: String,
        pub cutter_id: String,
        pub rpm: Option<i64>,
        pub feed: Option<i64>,
        pub plunge: Option<f64>,
        pub step_down: Option<f64>,
    }

    /// A material, as `t_MaterialList` lists it. The NAME is what the client's map is keyed by.
    pub(crate) fn material(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO t_MaterialList (materialID, materialCategoryID, materialSubcategoryName, \
             lastUpdateDate) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, "mat-category-1", name, "2026-05-20 00:00:00"],
        )
        .unwrap();
    }

    /// Insert a feed row. `cutter_id` is a cutter's UUID, NOT its `g_ID`.
    pub(crate) fn put_feed(conn: &Connection, f: &Feed) {
        conn.execute(
            "INSERT INTO t_MakeraCutterProperties (propertiesId, materialId, cutterID, \
             spindleSpeed, feedRate, plungeFeedRate, stepDown, stepOver, stepOverPercent, coolant) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                f.id,
                f.material_id,
                f.cutter_id,
                f.rpm,
                f.feed,
                f.plunge,
                f.step_down,
                2.0,
                0.63,
                0,
            ],
        )
        .unwrap();
    }

    pub(crate) fn group(conn: &Connection, id: &str, name: &str, parent: Option<&str>) {
        conn.execute(
            "INSERT INTO t_MakeraCutterGroup (cutterGroupid, name, parentId, lastUpdateDate) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, name, parent.unwrap_or(""), "2026-05-20 00:00:00"],
        )
        .unwrap();
    }

    /// Insert a row. `None` binds NULL and an EMPTY STRING binds `''` — the two are different in
    /// this database, and the real one uses `''`.
    pub(crate) fn put(conn: &Connection, c: &Cutter) {
        conn.execute(
            "INSERT INTO t_MakeraCutterList (cutterId, groupId, cutterName, cutterNumber, \
             cutterCategoryId, cutterDiameter, cutterStickoutLength, cutterShoulderLength, \
             cutterFluteLength, cutterMaxDiameter, cutterTipDiameter, cutterCornerRadius, \
             cutterAngle, cutterHalfAngle, threadSpecification, pitch, threadAngle, drillDiameter, \
             sellProduct, g_ID, metalDuty, lastUpdateDate) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
            rusqlite::params![
                c.cutter_id,
                c.group_id,
                c.name,
                c.number,
                c.category,
                c.diameter,
                c.stickout,
                c.shoulder,
                c.flute,
                c.max_diameter,
                c.tip,
                c.corner,
                c.angle,
                c.half_angle,
                c.thread_spec,
                c.pitch,
                c.thread_angle,
                c.drill,
                c.sell_product,
                c.g_id,
                c.metal_duty,
                c.updated,
            ],
        )
        .unwrap();
    }

    pub(crate) fn temp_db(dir: &Path) -> PathBuf {
        dir.join("makera_library.db")
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;
    use tempfile::TempDir;

    /// The eight categories, with the geometry the real install states for each. Copied from
    /// `/docs/bench/2026-10-08-makera-library-schema.md` and from the rows themselves: getting one of
    /// these numbers wrong here would be describing the import rather than testing it.
    fn a_library() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let path = temp_db(dir.path());
        let conn = db(&path);
        let top = "019c04b5-2e1e-7260-9b67-90fd474c3096";
        let child = "019c04b5-2e1e-7b1e-a93a-a6b564865c50";
        group(&conn, top, "Flat End", None);
        group(&conn, child, "Single Flute Metal", Some(top));

        put(&conn, &Cutter { diameter: Some(3.175), max_diameter: Some(1.0), corner: Some(0.5),
            flute: Some(3.0), shoulder: Some(3.0),
            ..Cutter::new("3.175*1*3mm Ball Nose(Metal)", 0) });
        put(&conn, &Cutter { group_id: child.to_string(), diameter: Some(3.175),
            max_diameter: Some(3.175), tip: Some(3.175), corner: Some(0.0),
            flute: Some(12.0), shoulder: Some(12.0),
            ..Cutter::new("3.175*12mm Flat End(Metal)", 1) });
        put(&conn, &Cutter { diameter: Some(3.175), max_diameter: Some(3.175), tip: Some(0.1),
            angle: Some(90.0), flute: Some(1.6),
            ..Cutter::new("3.175mm*90º Chamfer", 2) });
        put(&conn, &Cutter { diameter: Some(3.175), max_diameter: Some(3.175), tip: Some(0.1),
            half_angle: Some(15.0), flute: Some(5.0),
            ..Cutter::new("3.175*0.1mm*30º Engraving", 3) });
        put(&conn, &Cutter { diameter: Some(3.175), max_diameter: Some(1.0), tip: Some(1.0),
            corner: Some(0.2), flute: Some(4.0),
            ..Cutter::new("3.175*1mm Bull Nose(hypothesis)", 4) });
        put(&conn, &Cutter { diameter: Some(3.175), max_diameter: Some(0.2), tip: Some(0.2),
            flute: Some(3.5), shoulder: Some(3.5),
            ..Cutter::new("3.175*0.2*3.5mm Drill", 5) });
        put(&conn, &Cutter { diameter: Some(3.175), max_diameter: Some(0.73), thread_spec: Some(1.0),
            pitch: Some(0.25), thread_angle: Some(60.0), drill: Some(0.75), flute: Some(3.5),
            shoulder: Some(3.0), metal_duty: Some(1), sell_product: Some(1),
            ..Cutter::new("3.175*M1*3mm Thread", 6) });
        put(&conn, &Cutter { diameter: Some(6.0), max_diameter: Some(6.0), corner: Some(0.25),
            flute: Some(30.5), shoulder: Some(30.5),
            ..Cutter::new("6*0.5*30.5mm Ball Nose Engraving", 7) });
        drop(conn);
        (dir, path)
    }

    fn by_name<'a>(entries: &'a [CatalogueEntry], name: &str) -> &'a CatalogueEntry {
        entries
            .iter()
            .find(|e| e.tool.name == name)
            .unwrap_or_else(|| panic!("{name} was not imported"))
    }

    /// A SQLite sidecar beside `db` — `makera_library.db-journal`, `…-wal`, `…-shm`.
    fn sidecar_of(db: &Path, suffix: &str) -> PathBuf {
        let mut os = db.as_os_str().to_os_string();
        os.push(suffix);
        PathBuf::from(os)
    }

    #[test]
    fn every_category_maps_to_the_geometry_the_cam_view_uses() {
        let (_dir, path) = a_library();
        let imported = read_all(&path).unwrap();
        let e = &imported.entries;
        assert_eq!(e.len(), 8);
        assert!(imported.notes.is_empty(), "{:?}", imported.notes);
        // No feed rows in this fixture's database: a catalogue with no starting numbers is a
        // catalogue, not a problem.
        assert!(imported.feeds.is_empty());

        // A ball nose: the shank is the handle, the ball is the max diameter, and the tip — which
        // the source does not state — is the ball's diameter.
        let ball = by_name(e, "3.175*1*3mm Ball Nose(Metal)");
        assert_eq!(ball.tool.shape, ToolShape::Ball);
        assert_eq!(ball.tool.type_text, "Ball Nose");
        assert_eq!(ball.tool.handle_diameter, Some(3.175));
        assert_eq!(ball.tool.diameter, Some(1.0));
        assert_eq!(ball.tool.tip_diameter, Some(1.0));
        assert_eq!(ball.tool.corner_radius, Some(0.5));

        // A flat end states everything, including a corner radius of ZERO, which is a number and
        // must not become "unknown" on the way through.
        let flat = by_name(e, "3.175*12mm Flat End(Metal)");
        assert_eq!(flat.tool.shape, ToolShape::Flat);
        assert_eq!(flat.tool.tip_diameter, Some(3.175));
        assert_eq!(flat.tool.diameter, Some(3.175));
        assert_eq!(flat.tool.corner_radius, Some(0.0));
        assert_eq!(flat.tool.flute_length, Some(12.0));
        assert_eq!(flat.tool.shoulder_length, Some(12.0));

        // A chamfer's `angle` is the INCLUDED angle; `halfAngle` is empty in the row.
        let chamfer = by_name(e, "3.175mm*90º Chamfer");
        assert_eq!(chamfer.tool.shape, ToolShape::Chamfer);
        assert_eq!(chamfer.tool.angle, Some(90.0));
        assert_eq!(chamfer.tool.half_angle, None);
        assert_eq!(chamfer.tool.tip_diameter, Some(0.1));

        // An engraver's half angle is stated and its `angle` is not — the opposite way round.
        let v = by_name(e, "3.175*0.1mm*30º Engraving");
        assert_eq!(v.tool.shape, ToolShape::Engraving);
        assert_eq!(v.tool.half_angle, Some(15.0), "30º in the name is the INCLUDED angle");
        assert_eq!(v.tool.angle, None);
        assert_eq!(v.tool.tip_diameter, Some(0.1));

        // A bull nose (the §3 hypothesis: no real row uses category 4 yet) has a corner radius that
        // is a CORNER, not a ball — so the tip is what the row says and nothing is derived from it.
        let bull = by_name(e, "3.175*1mm Bull Nose(hypothesis)");
        assert_eq!(bull.tool.shape, ToolShape::Bull);
        assert_eq!(bull.tool.tip_diameter, Some(1.0));
        assert_eq!(bull.tool.corner_radius, Some(0.2));

        let drill = by_name(e, "3.175*0.2*3.5mm Drill");
        assert_eq!(drill.tool.shape, ToolShape::Drill);
        assert_eq!(drill.tool.diameter, Some(0.2));
        assert_eq!(drill.tool.tip_diameter, Some(0.2));

        // A thread mill's cutting diameter is the max; its pitch, angle and thread size are not
        // tool geometry at all and live in the extras.
        let thread = by_name(e, "3.175*M1*3mm Thread");
        assert_eq!(thread.tool.shape, ToolShape::Thread);
        assert_eq!(thread.tool.diameter, Some(0.73));
        assert_eq!(thread.tool.tip_diameter, None);
        assert_eq!(thread.extras.pitch, Some(0.25));
        assert_eq!(thread.extras.thread_angle, Some(60.0));
        assert_eq!(thread.extras.thread_specification, Some(1.0));
        assert_eq!(thread.extras.drill_diameter, Some(0.75));

        // A ball-nose engraver parks its ball in the corner radius and its 6 mm SHANK in the max
        // diameter: reading the max as the cutting diameter would call this a 6 mm cutter.
        let engraver = by_name(e, "6*0.5*30.5mm Ball Nose Engraving");
        assert_eq!(engraver.tool.shape, ToolShape::Ball);
        assert_eq!(engraver.tool.type_text, "Ball Nose Engraving");
        assert_eq!(engraver.tool.handle_diameter, Some(6.0));
        assert_eq!(engraver.tool.diameter, Some(6.0), "the shank, as the header writes it");
        assert_eq!(engraver.tool.tip_diameter, Some(0.5), "2 × the 0.25 corner radius");
        assert_eq!(engraver.tool.corner_radius, Some(0.25));

        // Two things the catalogue never states are absent from every row, never guessed.
        for entry in e {
            assert_eq!(entry.tool.stickout, None, "{} claimed a stick-out", entry.key);
            assert_eq!(entry.tool.centre_cutting, None, "{} claimed a plunge", entry.key);
        }
    }

    #[test]
    fn a_row_carries_its_own_identity_and_the_group_the_vendor_filed_it_under() {
        let (_dir, path) = a_library();
        let imported = read_all(&path).unwrap();
        let flat = by_name(&imported.entries, "3.175*12mm Flat End(Metal)");
        assert_eq!(flat.key, format!("cat:{}", flat.extras.cutter_id));
        assert_eq!(flat.extras.category_id, 1);
        assert_eq!(flat.extras.category_name, "Flat End");
        // The header's `id=` is the 12-digit g_ID, and the key is the UUID: they are different keys
        // for the same cutter and both are needed.
        let g_id = flat.tool.id.clone().unwrap();
        assert_eq!(g_id.len(), 12);
        assert_eq!(flat.provenance, format!("Makera catalogue {g_id}"));
        assert_eq!(flat.extras.group_name.as_deref(), Some("Single Flute Metal"));
        assert_eq!(flat.extras.group_family.as_deref(), Some("Flat End"));
        // A top-level group has no family, which is what makes the two distinct.
        let ball = by_name(&imported.entries, "3.175*1*3mm Ball Nose(Metal)");
        assert_eq!(ball.extras.group_name, None);
        assert_eq!(ball.extras.group_family, None);
        flat.validate().unwrap();
    }

    #[test]
    fn an_empty_string_is_not_a_number_and_not_a_zero() {
        // Every geometry column empty, which is how Studio writes "unset" — including into REAL
        // columns, where SQLite keeps it as TEXT. A plain `get::<Option<f64>>` fails on this row,
        // and that is the row shape that matters: every ball nose, engraver and thread mill in the
        // real install has at least one.
        let dir = TempDir::new().unwrap();
        let path = temp_db(dir.path());
        let conn = db(&path);
        put(&conn, &Cutter::new("3.175mm mystery", 3));
        drop(conn);

        let imported = read_all(&path).unwrap();
        let only = &imported.entries[0];
        assert_eq!(only.tool.handle_diameter, None);
        assert_eq!(only.tool.tip_diameter, None);
        assert_eq!(only.tool.diameter, None);
        assert_eq!(only.tool.corner_radius, None);
        assert_eq!(only.tool.angle, None);
        assert_eq!(only.tool.half_angle, None);
        assert_eq!(only.tool.flute_length, None);
        assert_eq!(only.tool.shoulder_length, None);
        assert_eq!(only.extras.vendor_stickout_length, None);
    }

    #[test]
    fn a_category_this_build_does_not_know_is_served_as_unknown_and_reported() {
        let dir = TempDir::new().unwrap();
        let path = temp_db(dir.path());
        let conn = db(&path);
        put(&conn, &Cutter { diameter: Some(3.0), ..Cutter::new("something new", 9) });
        put(&conn, &Cutter { diameter: Some(3.0), ..Cutter::new("another one", 9) });
        drop(conn);

        let imported = read_all(&path).unwrap();
        assert_eq!(imported.entries.len(), 2, "an unknown category is not dropped");
        assert_eq!(imported.entries[0].tool.shape, ToolShape::Unknown);
        assert_eq!(imported.entries[0].tool.type_text, "Category 9");
        assert_eq!(imported.notes.len(), 1);
        assert!(imported.notes[0].text.contains("2 cutters"), "{:?}", imported.notes[0]);
        assert!(imported.notes[0].text.contains("9"), "{:?}", imported.notes[0]);
        // Information, not loss (#328): the cutters are served, just without a name for their kind.
        assert_eq!(imported.notes[0].kind, SyncNoteKind::Info);
        assert_eq!(
            serde_json::to_value(&imported.notes[0]).unwrap()["kind"],
            serde_json::json!("info"),
            "the kind goes on the wire lowercase, which is what the client's enum reads"
        );
    }

    #[test]
    fn the_rows_come_back_in_catalogue_order() {
        let (_dir, path) = a_library();
        let imported = read_all(&path).unwrap();
        let order: Vec<(i64, &str)> = imported
            .entries
            .iter()
            .map(|e| (e.extras.category_id, e.tool.name.as_str()))
            .collect();
        // Category, then name: the same order every sync, which is what lets a diff and the served
        // `ETag` be stable rather than merely equal.
        assert_eq!(
            order.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4, 5, 6, 7]
        );
        let mut sorted = order.clone();
        sorted.sort();
        assert_eq!(order, sorted);
    }

    #[test]
    fn the_read_leaves_the_vendors_database_exactly_as_it_was() {
        let (dir, path) = a_library();
        let before = std::fs::read(&path).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();

        // The scratch copy is made in this test's OWN directory (#327). It is the same directory the
        // vendor's fixture lives in, so the listing below reports the copy and any `-journal`, `-wal`
        // or `-shm` beside it as well: one assertion, no race with the tests reading in parallel.
        read_all_in(&path, dir.path()).unwrap();
        read_all_in(&path, dir.path()).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified);
        // Nothing of ours is left beside it, and no journal or WAL was created by opening it.
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["makera_library.db".to_string()], "{names:?}");
    }

    #[test]
    fn a_file_that_is_not_a_makera_library_is_refused_by_name() {
        let dir = TempDir::new().unwrap();
        let path = temp_db(dir.path());
        // A perfectly good SQLite database with nothing in it that we read.
        rusqlite::Connection::open(&path).unwrap();

        let err = read_all(&path).unwrap_err();
        assert!(err.contains("not a Makera Studio library"), "{err}");
        assert!(err.contains("makera_library.db"), "{err}");

        let missing = dir.path().join("nowhere.db");
        let err = read_all(&missing).unwrap_err();
        assert!(err.contains("is not there"), "{err}");

        // A file that is not a database at all gets a DIFFERENT answer (#327): a valid database that
        // has never heard of Makera is the wrong file, and a file whose pages cannot be read at all is
        // damage. Telling a user the second thing is the first sends them looking for the wrong fix.
        let garbage = dir.path().join("a-sentence.db");
        std::fs::write(&garbage, b"this is not a database, it is a sentence").unwrap();
        let err = read_all(&garbage).unwrap_err();
        assert!(err.contains("did not verify"), "{err}");
        assert!(!err.contains("not a Makera Studio library"), "{err}");
    }

    #[test]
    fn a_resync_reports_what_was_added_removed_and_changed() {
        let (_dir, path) = a_library();
        let first = read_all(&path).unwrap().entries;
        let mut second = first.clone();

        // One row gone, one row's geometry moved, one row added, and one row's vendor timestamp
        // bumped without a number changing.
        second.remove(0);
        let changed_key = second[0].key.clone();
        second[0].tool.diameter = Some(9.9);
        second[0].content_hash = "different".to_string();
        let mut a_new_row = first[0].clone();
        a_new_row.key = "cat:019c049a-8169-7a1e-ace2-ffffffffffff".to_string();
        second.push(a_new_row);

        let change = diff(&first, &second);
        assert_eq!(change.added, vec!["cat:019c049a-8169-7a1e-ace2-ffffffffffff"]);
        assert_eq!(change.removed, vec![first[0].key.clone()]);
        assert_eq!(change.changed, vec![changed_key]);
        assert_eq!(change.unchanged, second.len() - 2);
    }

    #[test]
    fn a_vendor_timestamp_alone_is_not_a_change() {
        // The whole reason `lastUpdateDate` is not in the hash: Studio touching a row says nothing
        // about the cutter, and a report that cried "changed" on every sync would be one nobody
        // reads.
        let dir = TempDir::new().unwrap();
        let path = temp_db(dir.path());
        let conn = db(&path);
        put(&conn, &Cutter { diameter: Some(3.175), tip: Some(3.175),
            ..Cutter::new("3.175*12mm Flat End(Metal)", 1) });
        drop(conn);
        let first = read_all(&path).unwrap().entries;

        rusqlite::Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE t_MakeraCutterList SET lastUpdateDate = '2027-01-01 00:00:00'",
                [],
            )
            .unwrap();
        let second = read_all(&path).unwrap().entries;

        assert_ne!(first[0].extras.vendor_updated_at, second[0].extras.vendor_updated_at);
        let change = diff(&first, &second);
        assert_eq!(change.unchanged, 1);
        assert_eq!(change.changed, Vec::<String>::new());
    }

    #[test]
    fn a_library_with_a_pending_write_beside_it_is_refused_rather_than_copied() {
        // #327. Rollback mode holds the ORIGINAL pages in `-journal` while the main file already
        // carries the new ones, and WAL holds commits in `-wal` until a checkpoint — so a copy of the
        // main file ALONE can be a database missing a transaction, and the cutters it holds arrive as
        // `removed`.
        let (_dir, path) = a_library();
        let journal = sidecar_of(&path, "-journal");
        std::fs::write(&journal, b"the pages this transaction replaced").unwrap();

        let err = read_all(&path).unwrap_err();
        assert!(err.contains("makera_library.db-journal"), "{err}");
        assert!(err.contains("reported removed"), "the consequence must be stated: {err}");

        // An EMPTY sidecar is the at-rest state rather than a pending write: `journal_mode=PERSIST`
        // leaves an empty journal behind after every commit, and a checkpointed `-wal` can be empty
        // too. Size is the test, so a Studio that leaves files about still syncs.
        std::fs::write(&journal, b"").unwrap();
        assert_eq!(read_all(&path).unwrap().entries.len(), 8);

        std::fs::remove_file(&journal).unwrap();
        let wal = sidecar_of(&path, "-wal");
        std::fs::write(&wal, b"").unwrap();
        assert_eq!(read_all(&path).unwrap().entries.len(), 8, "a checkpointed WAL is not a pending write");

        std::fs::write(&wal, b"frames").unwrap();
        let err = read_all(&path).unwrap_err();
        assert!(err.contains("makera_library.db-wal"), "{err}");
    }

    #[test]
    fn a_pending_write_that_appears_after_the_copy_is_refused_too() {
        // #339. The check before the copy is a point-in-time answer: a commit that begins between it
        // and the copy leaves a sidecar the first look never saw, and a copy that may be missing
        // the transaction's pages. The second look is what catches it, so the hook puts the journal
        // there AFTER the copy has been taken — the window the first check cannot see into.
        let (dir, path) = a_library();
        let journal = sidecar_of(&path, "-journal");
        let err = read_all_around(&path, dir.path(), || {
            std::fs::write(&journal, b"the pages this transaction replaced").unwrap();
        })
        .unwrap_err();
        assert!(err.contains("makera_library.db-journal"), "{err}");
        assert!(err.contains("reported removed"), "the same sentence as the first check: {err}");

        // And the refused copy is still cleaned up: nothing of ours is left in the scratch directory.
        let ours: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("casemaker-studio-"))
            .collect();
        assert!(ours.is_empty(), "{ours:?}");

        // An EMPTY sidecar appearing after the copy is the at-rest state, as it is before the copy.
        std::fs::remove_file(&journal).unwrap();
        let imported = read_all_around(&path, dir.path(), || {
            std::fs::write(&journal, b"").unwrap();
        })
        .unwrap();
        assert_eq!(imported.entries.len(), 8);
    }

    #[test]
    fn a_torn_copy_is_refused_rather_than_read_short() {
        // The half the sidecar check cannot see: the copy is short or malformed for a reason that is
        // not a sidecar — a write landed mid-copy, or the disk truncated it. The outcome to refuse is
        // the one that still parses, because that is the one that reports cutters as `removed`.
        let (_dir, path) = a_library();
        let full = std::fs::read(&path).unwrap();
        std::fs::write(&path, &full[..full.len() / 2]).unwrap();

        let err = read_all(&path).unwrap_err();
        assert!(err.contains("did not verify"), "{err}");
        assert!(err.contains("partial catalogue"), "{err}");
    }

    #[test]
    fn a_stored_entry_must_still_name_the_cutter_row_it_came_from() {
        let (_dir, path) = a_library();
        let mut entry = read_all(&path).unwrap().entries.remove(0);
        entry.validate().unwrap();
        entry.key = "cat:somebody-elses-uuid".to_string();
        assert!(matches!(entry.validate(), Err(HouseError::BadEntry(_))));

        let mut piped = read_all(&path).unwrap().entries.remove(0);
        piped.key.push('|');
        assert!(matches!(piped.validate(), Err(HouseError::BadEntry(_))));
    }

    // — the feed matrix (#310) ---------------------------------------------------------------------

    /// One flat end with a feed row in each of three materials: the two this app has stock for, and
    /// one it deliberately does not (`PLA` is not even a Makera material; `6061 Aluminum` is, and
    /// both are served to a client that refuses them).
    fn a_library_with_feeds() -> (TempDir, PathBuf, String) {
        let dir = TempDir::new().unwrap();
        let path = temp_db(dir.path());
        let conn = db(&path);
        let flat = Cutter {
            diameter: Some(3.175),
            max_diameter: Some(3.175),
            tip: Some(3.175),
            flute: Some(12.0),
            shoulder: Some(12.0),
            ..Cutter::new("3.175*12mm Flat End(Metal)", 1)
        };
        put(&conn, &flat);
        material(&conn, "mat-1", "Hardwood");
        material(&conn, "mat-2", "Softwood");
        material(&conn, "mat-3", "6061 Aluminum");
        for (id, material_id, feed, step_down) in [
            ("prop-1", "mat-1", 900_i64, 1.2),
            ("prop-2", "mat-2", 950_i64, 1.5),
            ("prop-3", "mat-3", 500_i64, 0.4),
        ] {
            put_feed(
                &conn,
                &Feed {
                    id: id.to_string(),
                    material_id: material_id.to_string(),
                    cutter_id: flat.cutter_id.clone(),
                    rpm: Some(12000),
                    feed: Some(feed),
                    plunge: Some(300.0),
                    step_down: Some(step_down),
                },
            );
        }
        drop(conn);
        (dir, path, flat.g_id.clone())
    }

    #[test]
    fn the_feed_matrix_imports_keyed_by_the_cutter_and_the_materials_own_name() {
        let (_dir, path, g_id) = a_library_with_feeds();
        let imported = read_all(&path).unwrap();
        assert!(imported.notes.is_empty(), "{:?}", imported.notes);
        assert_eq!(imported.feeds.len(), 3);

        // Keyed by the CUTTER's own id — the 12-digit `g_ID` the `.nc` header and the client use —
        // and by the vendor's material name VERBATIM, including the ones this app cannot use: the
        // refusal lives in the client's map, so the service serves what Makera says.
        for row in &imported.feeds {
            assert_eq!(row.cutter_id, g_id);
            assert_eq!(row.rpm, 12000.0);
            assert_eq!(row.plunge_feed, 300.0);
        }
        assert_eq!(
            imported
                .feeds
                .iter()
                .map(|r| (r.material.as_str(), r.feed, r.step_down))
                .collect::<Vec<_>>(),
            vec![("6061 Aluminum", 500.0, 0.4), ("Hardwood", 900.0, 1.2), ("Softwood", 950.0, 1.5)]
        );

        // FOUR numbers on the wire, and exactly the six keys the client's schema reads: the vendor's
        // step-over and coolant are not among them, and a change here would be a change to what the
        // client believes Makera said.
        let json = serde_json::to_value(&imported.feeds[0]).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["cutterId", "feed", "material", "plungeFeed", "rpm", "stepDown"]
        );
    }

    #[test]
    fn a_row_that_is_not_complete_is_dropped_and_named() {
        // The empty-string trap again, on the feed table: Studio writes `''` for "unset", and a
        // served row with a null would fail the client's parse of the WHOLE document — costing every
        // starting number rather than one row's.
        let (_dir, path, _g_id) = a_library_with_feeds();
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE t_MakeraCutterProperties SET plungeFeedRate = '' WHERE propertiesId = 'prop-1'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE t_MakeraCutterProperties SET spindleSpeed = NULL WHERE propertiesId = 'prop-2'",
            [],
        )
        .unwrap();
        drop(conn);

        let imported = read_all(&path).unwrap();
        assert_eq!(imported.feeds.len(), 1, "the rows that DO state everything are served");
        assert_eq!(imported.feeds[0].material, "6061 Aluminum");
        assert_eq!(imported.notes.len(), 1, "{:?}", imported.notes);
        assert!(imported.notes[0].text.contains("2 feed rows"), "{:?}", imported.notes[0]);

        // And a cutter whose `g_ID` is empty: its rows have no tool to be served against, so they go
        // the same way — while the CUTTER still imports. A gap in the feed matrix must not cost the
        // tool tier, which is a different document and the one the pickers need.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute("UPDATE t_MakeraCutterList SET g_ID = ''", []).unwrap();
        drop(conn);

        let imported = read_all(&path).unwrap();
        assert!(imported.feeds.is_empty(), "{:?}", imported.feeds);
        assert!(imported.notes[0].text.contains("3 feed rows"), "{:?}", imported.notes[0]);
        assert_eq!(imported.entries.len(), 1);
    }

    #[test]
    fn a_row_that_states_a_number_no_cut_can_use_is_dropped_and_named() {
        // #325. Studio writes a `0` into a numeric column it never filled, and `num()` reads it as a
        // perfectly good `0.0` — so the row would be served, and the client's schema (positive, not
        // merely finite) would refuse the WHOLE array over it. A zero or a negative is therefore not
        // served, exactly like an empty cell.
        let (_dir, path, _g_id) = a_library_with_feeds();
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE t_MakeraCutterProperties SET feedRate = 0 WHERE propertiesId = 'prop-1'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE t_MakeraCutterProperties SET stepDown = -0.4 WHERE propertiesId = 'prop-2'",
            [],
        )
        .unwrap();
        drop(conn);

        let imported = read_all(&path).unwrap();
        assert_eq!(imported.feeds.len(), 1, "the rows with usable numbers are served");
        assert_eq!(imported.feeds[0].material, "6061 Aluminum");
        assert_eq!(imported.notes.len(), 1, "{:?}", imported.notes);
        assert!(imported.notes[0].text.contains("2 feed rows"), "{:?}", imported.notes[0]);
        assert!(
            imported.notes[0].text.contains("not positive"),
            "the note must say WHICH rule dropped them: {:?}",
            imported.notes[0]
        );

        // The other side of the line: an ABSURD-but-positive number is served, not dropped. 32 of
        // Makera's own rows state 15 000 RPM on a 13 000 RPM spindle — a real vendor number for a
        // real cutter — and `feedsFor` clamps it and says so.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE t_MakeraCutterProperties SET spindleSpeed = 24000 WHERE propertiesId = 'prop-3'",
            [],
        )
        .unwrap();
        drop(conn);

        let imported = read_all(&path).unwrap();
        let served: Vec<f64> = imported
            .feeds
            .iter()
            .filter(|r| r.material == "6061 Aluminum")
            .map(|r| r.rpm)
            .collect();
        assert_eq!(served, vec![24000.0], "{:?}", imported.feeds);

        // And a NON-FINITE number, which is the same rule (#326) reached by another door: `num()`
        // reads TEXT, and Rust's `f64` parse accepts "inf" — a number no cut can use, and one
        // serde_json would write as `null`, failing the client's parse of the whole document.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE t_MakeraCutterProperties SET stepDown = ?1 WHERE propertiesId = 'prop-3'",
            rusqlite::params![f64::INFINITY],
        )
        .unwrap();
        drop(conn);

        let imported = read_all(&path).unwrap();
        assert!(
            imported.feeds.is_empty(),
            "a non-finite number is not servable: {:?}",
            imported.feeds
        );
        assert!(
            imported.notes[0].text.contains("not positive and finite"),
            "{:?}",
            imported.notes[0]
        );
    }

    #[test]
    fn a_database_without_the_feeds_table_is_a_catalogue_with_no_starting_numbers() {
        // The case the swallow was there for, kept benign (#326): a Studio build that never held
        // feeds has no `t_MakeraCutterProperties`, and that is an empty matrix with NO note. A note
        // would be a problem report about a catalogue that is exactly what it says it is.
        let dir = TempDir::new().unwrap();
        let path = temp_db(dir.path());
        let conn = db(&path);
        put(&conn, &Cutter::new("3.175*12mm Flat End(Metal)", 1));
        conn.execute("DROP TABLE t_MakeraCutterProperties", []).unwrap();
        drop(conn);

        let imported = read_all(&path).unwrap();
        assert!(imported.feeds.is_empty());
        assert!(imported.notes.is_empty(), "{:?}", imported.notes);
        assert_eq!(imported.entries.len(), 1, "the tool tier is unaffected");
    }

    #[test]
    fn a_feeds_query_that_fails_any_other_way_is_refused_rather_than_emptied() {
        // #326. `let Ok(stmt) = conn.prepare(…) else { empty }` swallowed EVERY prepare error, so a
        // Studio update that renamed one column made the next sync SUCCEED, write `feeds: []` over
        // every starting number and report nothing at all — the user's matrix gone, silently, with
        // the note list empty. Only the absence of the table is benign.
        let (_dir, path, _g_id) = a_library_with_feeds();
        let conn = rusqlite::Connection::open(&path).unwrap();

        // A renamed column: the query names `p.plungeFeedRate`, and the column is gone.
        conn.execute(
            "ALTER TABLE t_MakeraCutterProperties RENAME COLUMN plungeFeedRate TO plungeFeed_new",
            [],
        )
        .unwrap();
        drop(conn);
        let err = read_all(&path).unwrap_err();
        assert!(err.contains("feed matrix"), "{err}");
        assert!(err.contains("plungeFeedRate"), "the column must be named: {err}");

        // And the other silent one: a join table that is not there either. Nothing about that is a
        // catalogue without feeds — the rows exist and cannot be named. The table is named in the
        // check, so this is refused rather than passed off as an empty matrix.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "ALTER TABLE t_MakeraCutterProperties RENAME COLUMN plungeFeed_new TO plungeFeedRate",
            [],
        )
        .unwrap();
        conn.execute("DROP TABLE t_MaterialList", []).unwrap();
        drop(conn);
        let err = read_all(&path).unwrap_err();
        assert!(err.contains("feed matrix"), "{err}");
        assert!(err.contains("t_MaterialList"), "{err}");
    }

    #[test]
    fn a_feed_row_about_a_cutter_that_is_not_there_is_never_served() {
        let (_dir, path, _g_id) = a_library_with_feeds();
        let conn = rusqlite::Connection::open(&path).unwrap();
        put_feed(
            &conn,
            &Feed {
                id: "prop-orphan".to_string(),
                material_id: "mat-1".to_string(),
                cutter_id: "019c049a-8169-7a1e-ace2-00000000dead".to_string(),
                rpm: Some(6000),
                feed: Some(200),
                plunge: Some(100.0),
                step_down: Some(0.2),
            },
        );
        drop(conn);

        let imported = read_all(&path).unwrap();
        assert_eq!(imported.feeds.len(), 3, "the orphan is invisible, not served");
        assert!(imported.notes.is_empty(), "{:?}", imported.notes);
    }
}
