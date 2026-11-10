// #1126 slice 1 — CNC GENERATION RUNS ON THE HOUSE.
//
// The browser posts a job; this module writes it to a scratch directory, spawns the Node CLI
// (`casemaker cut`, the same engine the app runs in-page) with an argv array, streams the CLI's
// `--events` progress lines, and serves the receipt and the posted programs. The decisions that
// matter:
//
//   - NEVER A SHELL. The child is `Command::new(node).arg(cli).arg("cut").arg(job_path)…` with an
//     argv array; the job is a FILE, never interpolated into a command line. The scratch directory
//     and the run id are the service's own (the id is generated here, never taken from the client).
//   - THE PATHS COME FROM THE SERVICE, NEVER THE LOCATION DOCUMENT. `CASEMAKER_NODE` /
//     `CASEMAKER_CLI` (with the build's install-path default), because the location is data any LAN
//     client may PUT, and letting it name an executable would turn a document write into code
//     execution. Missing or non-executable => the runs capability reads false (health) and POST
//     /runs answers a plain sentence; no path is ever guessed.
//   - A BOUNDED QUEUE. Concurrency and a maximum queue length; a full queue is a 429 with a plain
//     sentence. A wall-clock cap kills a runaway child and records the finding.
//   - THE KEY IS (jobSha, build) — never the location's ETag (it moves on every finished-program
//     write, #1123-11); the shop ETag is a submit-time precondition only, checked by `house_api`
//     before `submit` is called (it owns the store that serves the location).
//   - RETENTION: scratch directories are pruned after the configured window; a completed run's
//     directory is what serves its programs by name.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_util::stream::{self, Stream, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::broadcast;
use tokio::time::timeout;

const NODE_ENV: &str = "CASEMAKER_NODE";
const CLI_ENV: &str = "CASEMAKER_CLI";
const ROOT_ENV: &str = "CASEMAKER_RUNS_ROOT";
/// How many runs may hold memory at once. ONE WORKER'S BUDGET (E's #1147 measurements, 2026-11-10):
/// after the stamp-cache fix the peak is the program SWEEP, not the plan — ~660 MiB of array buffers
/// at `sweep:checkpoint`, RSS ~2.8 GiB including the wasm heap. Before the fix a worker holds ~2 GiB
/// at the chain. A sidecar therefore keeps 1; k3's 30 GB box runs 3. The queue below is the pressure
/// valve, not a second pool.
const CONCURRENCY_ENV: &str = "CASEMAKER_RUNS_CONCURRENCY";
const QUEUE_ENV: &str = "CASEMAKER_RUNS_QUEUE";
const WALL_ENV: &str = "CASEMAKER_RUNS_WALL_S";
const RETENTION_ENV: &str = "CASEMAKER_RUNS_RETENTION_S";

/// The request body cap: a job document is a few hundred kilobytes; 16 MiB is generous and bounded.
/// `house_api` applies it to the route it owns, because axum's default is 2 MB.
pub const MAX_RUN_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl RunState {
    fn terminal(self) -> bool {
        matches!(self, RunState::Done | RunState::Failed | RunState::Cancelled)
    }
}

/// One progress frame, exactly as the CLI wrote it (#1126): the engine's own `EngraveProgress`
/// object — `{ stage, label?, done?, total? }` — or a `{ stage: 'note', label }` frame for a human
/// progress line. Nothing here is re-worded: the panel reads these with the same type it reads the
/// browser worker's progress with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProgress {
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RunProgram {
    pub name: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub id: String,
    pub state: RunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<usize>,
    pub progress: Option<RunProgress>,
    pub receipt: Option<Value>,
    pub programs: Vec<RunProgram>,
    pub finding: Option<String>,
}

/// The service's own configuration, from the environment with a build-time default for the paths.
#[derive(Debug, Clone)]
pub struct RunsConfig {
    pub node: PathBuf,
    pub cli: PathBuf,
    pub root: PathBuf,
    pub concurrency: usize,
    pub max_queue: usize,
    pub wall_clock: Duration,
    pub retention: Duration,
}

impl RunsConfig {
    /// Resolve from the environment; Err is the sentence the service answers with.
    pub fn resolve(env: &dyn Fn(&str) -> Option<String>) -> Result<RunsConfig, String> {
        let node = env(NODE_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(default_node()));
        let cli = env(CLI_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(default_cli()));
        if !node.is_file() {
            return Err(format!(
                "the house's Node is not at {} — set {NODE_ENV} to the node binary, or install the house package",
                node.display()
            ));
        }
        if !cli.is_file() {
            return Err(format!(
                "the house's casemaker CLI is not at {} — set {CLI_ENV} to the built scripts entry",
                cli.display()
            ));
        }
        let root = env(ROOT_ENV).map(PathBuf::from).unwrap_or_else(default_root);
        let number = |key: &str, default: u64| -> Result<u64, String> {
            match env(key) {
                None => Ok(default),
                Some(raw) => raw
                    .trim()
                    .parse::<u64>()
                    .map_err(|_| format!("{key} is \"{raw}\", which is not a whole number")),
            }
        };
        Ok(RunsConfig {
            node,
            cli,
            root,
            concurrency: (number(CONCURRENCY_ENV, 1)? as usize).max(1),
            max_queue: number(QUEUE_ENV, 8)? as usize,
            wall_clock: Duration::from_secs(number(WALL_ENV, 3600)?.max(1)),
            retention: Duration::from_secs(number(RETENTION_ENV, 7 * 24 * 3600)?.max(60)),
        })
    }
}

fn default_node() -> &'static str {
    option_env!("CASEMAKER_NODE_DEFAULT").unwrap_or("/usr/bin/node")
}

/// Bundling Node and the scripts into the installer is slice 3; until then a deb answers "not
/// installed" rather than guessing, and the operator sets `CASEMAKER_CLI`.
fn default_cli() -> &'static str {
    option_env!("CASEMAKER_CLI_DEFAULT")
        .unwrap_or("/usr/lib/casemaker/casemaker-app/scripts/casemaker.mjs")
}

fn default_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("casemaker")
        .join("runs")
}

/// The service build the run key carries: the same label health reports (#566).
fn build_label() -> String {
    option_env!("CASEMAKER_BUILD")
        .map(str::to_owned)
        .unwrap_or_else(|| "unknown".to_owned())
}

struct RunEntry {
    state: RunState,
    queue_position: Option<usize>,
    progress: Option<RunProgress>,
    receipt: Option<Value>,
    programs: Vec<RunProgram>,
    finding: Option<String>,
    log: Vec<RunProgress>,
    events: broadcast::Sender<RunProgress>,
    dir: PathBuf,
    task: Option<tokio::task::JoinHandle<()>>,
    /// When the run was submitted — the clock retention reads, so a long-lived service does not
    /// keep every settled entry in memory for the life of the process.
    created: SystemTime,
}

struct Inner {
    runs: HashMap<String, RunEntry>,
    order: Vec<String>,
    queue: VecDeque<String>,
    active: usize,
}

pub struct Runs {
    config: RunsConfig,
    inner: Mutex<Inner>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReply {
    pub run_id: String,
    pub queue_position: usize,
    pub key: SubmitKey,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitKey {
    pub job_sha: String,
    pub build: String,
}

pub enum SubmitOutcome {
    Accepted(SubmitReply),
    QueueFull,
    Unavailable(String),
    BadRequest(String),
}

static RUNS: OnceLock<Result<Arc<Runs>, String>> = OnceLock::new();
static RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn manager() -> &'static Result<Arc<Runs>, String> {
    RUNS.get_or_init(|| RunsConfig::resolve(&env_lookup).map(|config| Arc::new(Runs::new(config))))
}

/// Whether this service can generate: the health field and the gate on POST /runs.
pub fn capability() -> bool {
    manager().is_ok()
}

/// The runs state, applied to the runs router's own state type. `house_api` merges that router
/// AFTER applying its store state, so the two halves never share a state.
#[derive(Clone)]
struct RunsState {
    runs: Option<Arc<Runs>>,
    unavailable: Option<String>,
}

/// POST /runs, called by `house_api` once the shop ETag has been checked against the store.
pub fn submit(body: &Value) -> Response<Body> {
    let state = match manager() {
        Ok(runs) => RunsState {
            runs: Some(runs.clone()),
            unavailable: None,
        },
        Err(sentence) => RunsState {
            runs: None,
            unavailable: Some(sentence.clone()),
        },
    };
    submit_with(&state, body)
}

/// The submit itself, against whichever manager the state carries (the test drives this with its
/// own; `house_api` reaches it through the global one).
fn submit_with(state: &RunsState, body: &Value) -> Response<Body> {
    let Some(runs) = state.runs.clone() else {
        return unavailable(state);
    };
    runs.prune();
    match runs.submit_body(body) {
        SubmitOutcome::Accepted(reply) => json_body(
            StatusCode::ACCEPTED,
            serde_json::to_value(reply).unwrap_or(Value::Null),
        ),
        SubmitOutcome::QueueFull => error_sentence(
            StatusCode::TOO_MANY_REQUESTS,
            "the house queue is full — try again when a run finishes".to_owned(),
        ),
        SubmitOutcome::Unavailable(sentence) => {
            error_sentence(StatusCode::SERVICE_UNAVAILABLE, sentence)
        }
        SubmitOutcome::BadRequest(sentence) => error_sentence(StatusCode::BAD_REQUEST, sentence),
    }
}

/// The read/follow/cancel/program routes, merged into the house API after its own state is applied.
pub fn router() -> Router {
    let state = match manager() {
        Ok(runs) => RunsState {
            runs: Some(runs.clone()),
            unavailable: None,
        },
        Err(sentence) => RunsState {
            runs: None,
            unavailable: Some(sentence.clone()),
        },
    };
    routes().with_state(state)
}

/// The routes before their state is applied, so a test can drive them with a manager of its own.
fn routes() -> Router<RunsState> {
    Router::new()
        .route("/api/v1/runs/:id", get(read_run))
        .route("/api/v1/runs/:id/events", get(run_events))
        .route("/api/v1/runs/:id/cancel", post(cancel_run))
        .route("/api/v1/runs/:id/programs/:name", get(run_program))
        .route("/api/v1/runs/:id/generated", get(run_generated))
}

fn json_body(status: StatusCode, body: Value) -> Response<Body> {
    let bytes =
        serde_json::to_vec(&body).unwrap_or_else(|_| b"{\"error\":\"unserialisable\"}".to_vec());
    let mut res = Response::new(Body::from(bytes));
    *res.status_mut() = status;
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

fn error_sentence(status: StatusCode, message: String) -> Response<Body> {
    json_body(status, json!({ "error": message }))
}

fn valid_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_program_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        && !name.contains("..")
}

fn new_run_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("run-{nanos:x}-{n:x}-{:x}", std::process::id())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn now_stamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl Runs {
    pub fn new(config: RunsConfig) -> Runs {
        Runs {
            config,
            inner: Mutex::new(Inner {
                runs: HashMap::new(),
                order: Vec::new(),
                queue: VecDeque::new(),
                active: 0,
            }),
        }
    }

    /// Submit one run. `body` is the client's `{ job, shopEtag? }` document; the shop ETag has
    /// already been checked by the caller.
    pub fn submit_body(self: &Arc<Self>, body: &Value) -> SubmitOutcome {
        let Some(job) = body.get("job") else {
            return SubmitOutcome::BadRequest("the request has no job document".to_owned());
        };
        let job_bytes = match serde_json::to_vec(job) {
            Ok(b) => b,
            Err(e) => return SubmitOutcome::BadRequest(format!("the job cannot be written: {e}")),
        };
        // Admission first: a full queue refuses before a scratch directory exists.
        {
            let inner = self.inner.lock().expect("runs lock");
            if inner.active >= self.config.concurrency && inner.queue.len() >= self.config.max_queue
            {
                return SubmitOutcome::QueueFull;
            }
        }
        let id = new_run_id();
        let dir = self.config.root.join(&id);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return SubmitOutcome::Unavailable(format!(
                "the house could not make a scratch directory: {e}"
            ));
        }
        if let Err(e) = std::fs::write(dir.join("job.json"), &job_bytes) {
            let _ = std::fs::remove_dir_all(&dir);
            return SubmitOutcome::Unavailable(format!("the house could not write the job: {e}"));
        }
        let (events, _) = broadcast::channel(256);
        let mut inner = self.inner.lock().expect("runs lock");
        let start = inner.active < self.config.concurrency;
        if !start && inner.queue.len() >= self.config.max_queue {
            drop(inner);
            let _ = std::fs::remove_dir_all(&dir);
            return SubmitOutcome::QueueFull;
        }
        inner.runs.insert(
            id.clone(),
            RunEntry {
                state: RunState::Queued,
                queue_position: None,
                progress: None,
                receipt: None,
                programs: Vec::new(),
                finding: None,
                log: Vec::new(),
                events,
                dir,
                task: None,
                created: SystemTime::now(),
            },
        );
        inner.order.push(id.clone());
        let queue_position = if start {
            0
        } else {
            inner.queue.push_back(id.clone());
            inner.queue.len()
        };
        if let Some(e) = inner.runs.get_mut(&id) {
            e.queue_position = if start { None } else { Some(queue_position) };
        }
        if start {
            self.start_locked(&mut inner, &id);
        }
        SubmitOutcome::Accepted(SubmitReply {
            run_id: id,
            queue_position,
            key: SubmitKey {
                job_sha: sha256_hex(&job_bytes),
                build: build_label(),
            },
        })
    }

    /// Start a run whose entry is already in `inner`. Caller holds the lock.
    fn start_locked(self: &Arc<Self>, inner: &mut Inner, id: &str) {
        let Some(entry) = inner.runs.get_mut(id) else {
            return;
        };
        entry.state = RunState::Running;
        entry.queue_position = None;
        let dir = entry.dir.clone();
        let events = entry.events.clone();
        inner.active += 1;
        let runs = Arc::clone(self);
        let id_owned = id.to_owned();
        let handle = tokio::spawn(async move {
            let outcome = runs.run_child(&id_owned, &dir, &events).await;
            runs.finish(&id_owned, outcome);
        });
        if let Some(entry) = inner.runs.get_mut(id) {
            entry.task = Some(handle);
        }
    }

    fn finish(self: &Arc<Self>, id: &str, outcome: ChildOutcome) {
        let mut inner = self.inner.lock().expect("runs lock");
        let was_active = inner
            .runs
            .get(id)
            .map(|e| e.state == RunState::Running)
            .unwrap_or(false);
        if was_active {
            inner.active = inner.active.saturating_sub(1);
        }
        let programs = inner
            .runs
            .get(id)
            .map(|e| collect_programs(&e.dir))
            .unwrap_or_default();
        if let Some(entry) = inner.runs.get_mut(id) {
            entry.task = None;
            match outcome {
                ChildOutcome::Done { receipt } => {
                    entry.state = RunState::Done;
                    entry.receipt = Some(receipt);
                    entry.programs = programs;
                    entry.progress = Some(RunProgress {
                        stage: "done".to_owned(),
                        label: None,
                        done: None,
                        total: None,
                        at: Some(now_stamp()),
                    });
                }
                ChildOutcome::Failed { finding } => {
                    entry.state = RunState::Failed;
                    entry.finding = Some(finding);
                }
            }
        }
        self.start_queued(&mut inner);
    }

    /// Start queued runs while there is room, then renumber the rest. Caller holds the lock.
    fn start_queued(self: &Arc<Self>, inner: &mut Inner) {
        while inner.active < self.config.concurrency {
            let Some(next) = inner.queue.pop_front() else {
                break;
            };
            self.start_locked(inner, &next);
        }
        for (i, queued) in inner.queue.iter().enumerate() {
            if let Some(e) = inner.runs.get_mut(queued) {
                e.queue_position = Some(i + 1);
            }
        }
    }

    pub fn snapshot(&self, id: &str) -> Option<RunSnapshot> {
        let inner = self.inner.lock().expect("runs lock");
        inner.runs.get(id).map(|e| RunSnapshot {
            id: id.to_owned(),
            state: e.state,
            queue_position: e.queue_position,
            progress: e.progress.clone(),
            receipt: e.receipt.clone(),
            programs: e.programs.clone(),
            finding: e.finding.clone(),
        })
    }

    pub fn subscribe(
        &self,
        id: &str,
    ) -> Option<(Vec<RunProgress>, broadcast::Receiver<RunProgress>)> {
        let inner = self.inner.lock().expect("runs lock");
        inner
            .runs
            .get(id)
            .map(|e| (e.log.clone(), e.events.subscribe()))
    }

    /// Publish one progress event to the run's log and its live subscribers.
    fn publish(&self, id: &str, event: RunProgress) {
        let mut inner = self.inner.lock().expect("runs lock");
        if let Some(entry) = inner.runs.get_mut(id) {
            entry.progress = Some(event.clone());
            entry.log.push(event.clone());
            let _ = entry.events.send(event);
        }
    }

    pub fn cancel(self: &Arc<Self>, id: &str) -> bool {
        let mut inner = self.inner.lock().expect("runs lock");
        let Some(entry) = inner.runs.get_mut(id) else {
            return false;
        };
        if entry.state.terminal() {
            return false;
        }
        let was_active = entry.state == RunState::Running;
        entry.state = RunState::Cancelled;
        entry.queue_position = None;
        if let Some(task) = entry.task.take() {
            // Aborting drops the run's future at its next await, which drops the child; the
            // command was spawned with `kill_on_drop`.
            task.abort();
        }
        inner.queue.retain(|q| q != id);
        if was_active {
            inner.active = inner.active.saturating_sub(1);
        }
        self.start_queued(&mut inner);
        true
    }

    pub fn program_path(&self, id: &str, name: &str) -> Option<PathBuf> {
        if !valid_program_name(name) {
            return None;
        }
        let inner = self.inner.lock().expect("runs lock");
        inner
            .runs
            .get(id)
            .map(|e| e.dir.join("out").join(name))
            .filter(|p| p.is_file())
    }

    /// The run's own generated document (#1126): the plain-data result the browser's worker returns,
    /// written by the CLI beside the programs.
    pub fn generated_path(&self, id: &str) -> Option<PathBuf> {
        let inner = self.inner.lock().expect("runs lock");
        inner
            .runs
            .get(id)
            .map(|e| e.dir.join("out").join("generated.json"))
            .filter(|p| p.is_file())
    }

    /// Remove scratch directories older than the retention window.
    pub fn prune(&self) {
        let now = SystemTime::now();
        if let Ok(entries) = std::fs::read_dir(&self.config.root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let age = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| now.duration_since(m).ok());
                if age.is_some_and(|a| a > self.config.retention) {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
        // The entries are memory, and a house service runs for weeks. A settled run older than
        // the retention window loses its entry too — the directory it served is already gone.
        let mut inner = self.inner.lock().expect("runs lock");
        let stale: Vec<String> = inner
            .order
            .iter()
            .filter(|id| {
                inner
                    .runs
                    .get(*id)
                    .map(|e| {
                        e.state.terminal()
                            && e.created
                                .elapsed()
                                .map(|age| age > self.config.retention)
                                .unwrap_or(false)
                    })
                    // An entry the map does not hold is a leftover order id.
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        for id in &stale {
            inner.runs.remove(id);
        }
        inner.order.retain(|id| !stale.contains(id));
    }

    /// Run the child: argv array (never a shell), stderr as progress, stdout as the `--json`
    /// receipt, and the wall-clock cap kills a runaway.
    async fn run_child(
        self: &Arc<Self>,
        id: &str,
        dir: &FsPath,
        events: &broadcast::Sender<RunProgress>,
    ) -> ChildOutcome {
        let out_dir = dir.join("out");
        let _ = std::fs::create_dir_all(&out_dir);
        let mut child = match child_command(&self.config, dir, &out_dir).spawn() {
            Ok(c) => c,
            Err(e) => {
                return ChildOutcome::Failed {
                    finding: format!("the house could not start the planner: {e}"),
                }
            }
        };
        let stderr = child.stderr.take();
        let stdout = child.stdout.take();
        let runs_for_stderr = Arc::clone(self);
        let id_for_stderr = id.to_owned();
        // The child's whole stderr, beside its job in the scratch dir: a failed run's log is what
        // says WHY, and the progress frames alone are not it (they are the last line, not the
        // sequence). Kept for the retention window like everything else under the run.
        let stderr_log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("stderr.log"))
            .ok();
        let stderr_task = tokio::spawn(async move {
            let Some(stderr) = stderr else { return };
            let mut log = stderr_log;
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(file) = log.as_mut() {
                    use std::io::Write;
                    let _ = writeln!(file, "{line}");
                }
                if let Some(event) = parse_progress_line(&line) {
                    runs_for_stderr.publish(&id_for_stderr, event);
                }
            }
        });
        // Kept alive by the entry; the stderr reader publishes through the manager, not this.
        let _ = events;
        let stdout_task = tokio::spawn(async move {
            let Some(mut stdout) = stdout else {
                return String::new();
            };
            let mut buf = String::new();
            let _ = stdout.read_to_string(&mut buf).await;
            buf
        });
        let outcome = match timeout(self.config.wall_clock, child.wait()).await {
            Ok(Ok(status)) if status.success() => {
                let text = stdout_task.await.unwrap_or_default();
                match serde_json::from_str::<Value>(&text) {
                    Ok(receipt) => ChildOutcome::Done { receipt },
                    Err(e) => ChildOutcome::Failed {
                        finding: format!("the planner finished but its receipt cannot be read: {e}"),
                    },
                }
            }
            Ok(Ok(status)) => {
                let _ = stdout_task.await;
                ChildOutcome::Failed {
                    finding: format!(
                        "the planner exited with {status}, and its receipt was not written"
                    ),
                }
            }
            Ok(Err(e)) => ChildOutcome::Failed {
                finding: format!("the planner could not be waited for: {e}"),
            },
            Err(_) => {
                let _ = child.kill().await;
                let _ = stdout_task.await;
                ChildOutcome::Failed {
                    finding: format!(
                        "the run exceeded the house's {} s wall-clock cap and was stopped",
                        self.config.wall_clock.as_secs()
                    ),
                }
            }
        };
        let _ = stderr_task.await;
        outcome
    }
}

enum ChildOutcome {
    Done { receipt: Value },
    Failed { finding: String },
}

/// The child's command line: argv array, no shell, the job as a file path.
fn child_command(config: &RunsConfig, dir: &FsPath, out_dir: &FsPath) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(&config.node);
    command
        .arg(&config.cli)
        .arg("cut")
        .arg(dir.join("job.json"))
        .arg("--out")
        .arg(out_dir)
        .arg("--json")
        .arg("--events")
        // The whole result beside the receipt and the programs: the panel settles a house run with
        // this document, exactly as it settles an in-page one.
        .arg("--generated")
        .arg(out_dir.join("generated.json"))
        // #1137 — E's pick pool sizes itself from this (min(finalists, cores, n)); the service's
        // concurrency is the same number, so one setting fans out the queue and the pool. The CLI
        // ignores it until #1137 lands, which is why it is harmless to set now.
        .env("CASEMAKER_PICK_WORKERS", config.concurrency.to_string())
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

fn collect_programs(dir: &FsPath) -> Vec<RunProgram> {
    let out = dir.join("out");
    let Ok(entries) = std::fs::read_dir(&out) else {
        return Vec::new();
    };
    let mut programs: Vec<RunProgram> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("nc") {
                return None;
            }
            let name = path.file_name()?.to_str()?.to_owned();
            let bytes = std::fs::read(&path).ok()?;
            Some(RunProgram {
                name,
                hash: sha256_hex(&bytes),
            })
        })
        .collect();
    programs.sort_by(|a, b| a.name.cmp(&b.name));
    programs
}

/// One CLI `--events` line: the engine's own `{stage,label,done,total}` object or a
/// `{stage:'note',label}` frame; anything else (a human line, a blank line) is ignored rather than
/// guessed at.
fn parse_progress_line(line: &str) -> Option<RunProgress> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let stage = value.get("stage")?.as_str()?.trim();
    if stage.is_empty() {
        return None;
    }
    Some(RunProgress {
        stage: stage.to_owned(),
        label: value
            .get("label")
            .and_then(|l| l.as_str())
            .map(str::to_owned),
        done: value.get("done").and_then(|d| d.as_f64()),
        total: value.get("total").and_then(|t| t.as_f64()),
        at: value.get("at").and_then(|a| a.as_str()).map(str::to_owned),
    })
}

// — routes —————————————————————————————————————————————————————————————————————————————————————

fn unavailable(state: &RunsState) -> Response<Body> {
    error_sentence(
        StatusCode::SERVICE_UNAVAILABLE,
        state
            .unavailable
            .clone()
            .unwrap_or_else(|| "the house cannot run generation".to_owned()),
    )
}

async fn read_run(State(state): State<RunsState>, Path(id): Path<String>) -> Response<Body> {
    let Some(runs) = state.runs.clone() else {
        return unavailable(&state);
    };
    if !valid_run_id(&id) {
        return error_sentence(StatusCode::NOT_FOUND, "no such run".to_owned());
    }
    match runs.snapshot(&id) {
        Some(snapshot) => json_body(
            StatusCode::OK,
            serde_json::to_value(snapshot).unwrap_or(Value::Null),
        ),
        None => error_sentence(StatusCode::NOT_FOUND, "no such run".to_owned()),
    }
}

async fn cancel_run(State(state): State<RunsState>, Path(id): Path<String>) -> Response<Body> {
    let Some(runs) = state.runs.clone() else {
        return unavailable(&state);
    };
    if !valid_run_id(&id) || !runs.cancel(&id) {
        return error_sentence(
            StatusCode::CONFLICT,
            "the run has already finished, or does not exist".to_owned(),
        );
    }
    json_body(StatusCode::OK, json!({ "state": "cancelled" }))
}

async fn run_program(
    State(state): State<RunsState>,
    Path((id, name)): Path<(String, String)>,
) -> Response<Body> {
    let Some(runs) = state.runs.clone() else {
        return unavailable(&state);
    };
    if !valid_run_id(&id) {
        return error_sentence(StatusCode::NOT_FOUND, "no such program in this run".to_owned());
    }
    let Some(path) = runs.program_path(&id, &name) else {
        return error_sentence(StatusCode::NOT_FOUND, "no such program in this run".to_owned());
    };
    match std::fs::read(&path) {
        Ok(bytes) => {
            let mut res = Response::new(Body::from(bytes));
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            );
            res
        }
        Err(e) => error_sentence(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the program could not be read: {e}"),
        ),
    }
}

async fn run_generated(State(state): State<RunsState>, Path(id): Path<String>) -> Response<Body> {
    let Some(runs) = state.runs.clone() else {
        return unavailable(&state);
    };
    let path = if valid_run_id(&id) {
        runs.generated_path(&id)
    } else {
        None
    };
    let Some(path) = path else {
        return error_sentence(
            StatusCode::NOT_FOUND,
            "this run has no generated document".to_owned(),
        );
    };
    match std::fs::read(&path) {
        Ok(bytes) => {
            let mut res = Response::new(Body::from(bytes));
            res.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            res
        }
        Err(e) => error_sentence(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the generated document could not be read: {e}"),
        ),
    }
}

async fn run_events(State(state): State<RunsState>, Path(id): Path<String>) -> Response<Body> {
    let Some(runs) = state.runs.clone() else {
        return unavailable(&state);
    };
    let sub = if valid_run_id(&id) {
        runs.subscribe(&id)
    } else {
        None
    };
    let Some((log, receiver)) = sub else {
        return error_sentence(StatusCode::NOT_FOUND, "no such run".to_owned());
    };
    let initial = stream::iter(
        log.into_iter()
            .map(|e| Ok::<Event, std::convert::Infallible>(sse_event(&e))),
    );
    let live = stream::unfold(receiver, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    return Some((Ok::<Event, std::convert::Infallible>(sse_event(&event)), rx))
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    let stream: std::pin::Pin<
        Box<dyn Stream<Item = Result<Event, std::convert::Infallible>> + Send>,
    > = Box::pin(initial.chain(live));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

fn sse_event(event: &RunProgress) -> Event {
    Event::default().data(serde_json::to_string(event).unwrap_or_else(|_| "{}".to_owned()))
}

// — tests ———————————————————————————————————————————————————————————————————————————————————————

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_paths_refuse_by_name_and_never_guess() {
        let env = |_key: &str| None::<String>;
        let err = RunsConfig::resolve(&env).expect_err("no node/cli configured");
        assert!(err.contains("Node is not at"), "{err}");
    }

    #[test]
    fn a_progress_line_is_the_engine_object_or_a_note_and_anything_else_is_ignored() {
        let event = parse_progress_line(
            r#"{"stage":"plan","label":"planning the sequence — setup 1","done":3,"total":9}"#,
        )
        .unwrap();
        assert_eq!(event.stage, "plan");
        assert_eq!(event.label.as_deref(), Some("planning the sequence — setup 1"));
        assert_eq!(event.done, Some(3.0));
        assert_eq!(event.total, Some(9.0));
        let note = parse_progress_line(r#"{"stage":"note","label":"  pick      cutter 1"}"#).unwrap();
        assert_eq!(note.stage, "note");
        assert_eq!(note.label.as_deref(), Some("  pick      cutter 1"));
        assert!(parse_progress_line("planning: sequence — setup 1, 35 %").is_none());
        assert!(parse_progress_line(r#"{"label":"no stage"}"#).is_none());
    }

    #[test]
    fn the_key_is_a_sha256_of_the_job_bytes() {
        let sha = sha256_hex(br#"{"id":"j","name":"$(touch PWNED); `id`"}"#);
        assert_eq!(sha.len(), 64);
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(sha, sha256_hex(b"another job"));
    }

    #[test]
    fn the_child_is_an_argv_array_with_the_job_as_a_file_and_never_a_shell() {
        let config = RunsConfig {
            node: PathBuf::from("/usr/bin/node"),
            cli: PathBuf::from("/opt/casemaker/scripts/casemaker.mjs"),
            root: PathBuf::from("/tmp/runs"),
            concurrency: 1,
            max_queue: 1,
            wall_clock: Duration::from_secs(60),
            retention: Duration::from_secs(60),
        };
        let dir = PathBuf::from("/tmp/runs/run-1");
        let out = dir.join("out");
        let command = child_command(&config, &dir, &out);
        let std_command = command.as_std();
        assert_eq!(
            std_command.get_program(),
            std::ffi::OsStr::new("/usr/bin/node")
        );
        let args: Vec<_> = std_command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "/opt/casemaker/scripts/casemaker.mjs",
                "cut",
                "/tmp/runs/run-1/job.json",
                "--out",
                "/tmp/runs/run-1/out",
                "--json",
                "--events",
                "--generated",
                "/tmp/runs/run-1/out/generated.json",
            ]
        );
        // The job is a path here, never its content: shell metacharacters in a job cannot reach a
        // command line because there is no command line to reach.
        assert!(!args.iter().any(|a| a.contains("$(") || a.contains(';')));
        assert!(!args.iter().any(|a| a == "sh" || a == "bash" || a == "-c"));
    }

    #[test]
    fn program_names_and_run_ids_cannot_escape_the_scratch_directory() {
        assert!(valid_program_name("tray-p01.nc"));
        assert!(!valid_program_name("../job.json"));
        assert!(!valid_program_name("a/b.nc"));
        assert!(!valid_program_name(".."));
        assert!(valid_run_id("run-1a2b-3"));
        assert!(!valid_run_id("../x"));
    }

    #[test]
    fn retention_prunes_settled_entries_from_memory_but_never_a_running_one() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let root = dir.path().join("runs");
        std::fs::create_dir_all(&root).expect("the root");
        let runs = Runs::new(RunsConfig {
            node: PathBuf::from("/bin/true"),
            cli: PathBuf::from("/bin/true"),
            root,
            concurrency: 1,
            max_queue: 1,
            wall_clock: Duration::from_secs(5),
            retention: Duration::from_secs(60),
        });
        let entry = |state: RunState| {
            let (events, _) = broadcast::channel(8);
            RunEntry {
                state,
                queue_position: None,
                progress: None,
                receipt: None,
                programs: Vec::new(),
                finding: None,
                log: Vec::new(),
                events,
                dir: dir.path().join("gone"),
                task: None,
                created: SystemTime::now() - Duration::from_secs(3600),
            }
        };
        {
            let mut inner = runs.inner.lock().expect("runs lock");
            inner
                .runs
                .insert("run-done".to_owned(), entry(RunState::Done));
            inner
                .runs
                .insert("run-running".to_owned(), entry(RunState::Running));
            inner.order.push("run-done".to_owned());
            inner.order.push("run-running".to_owned());
        }
        runs.prune();
        assert!(runs.snapshot("run-done").is_none(), "a settled entry past retention is gone");
        assert!(runs.snapshot("run-running").is_some(), "a running entry is never pruned");
    }

    // — the routes, end to end, against a fake node (#1126 amendments 2 and 3) ——————————————

    #[cfg(unix)]
    mod api {
        use super::*;
        use axum::body::to_bytes;
        use axum::http::Request;
        use std::os::unix::fs::PermissionsExt;
        use tower::ServiceExt;

        /// A stand-in for `node <cli> cut …`: writes the program and the generated document where
        /// the service says, reports two progress frames on stderr and one receipt on stdout.
        /// Deliberately a shell script, because the service runs its argv array as-is and this is
        /// the cheapest way to observe exactly what reaches it.
        const FAKE_NODE: &str = r#"#!/bin/sh
set -eu
OUT=""; GEN=""; JOB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --generated) GEN="$2"; shift 2;;
    cut) shift; JOB="$1"; shift;;
    *) shift;;
  esac
done
[ -f "$JOB" ] || { echo "no job file: $JOB" >&2; exit 3; }
mkdir -p "$OUT"
printf 'G0 X0 Y0\n' > "$OUT/tray-p01.nc"
printf '{"ok":true,"nc":"G0 X0 Y0","job":%s}' "$(cat "$JOB")" > "$GEN"
echo '{"stage":"plan","label":"planning","done":1,"total":2}' >&2
echo '{"stage":"note","label":"  pick      cutter 1"}' >&2
printf '{"ok":true,"programs":[{"ncFile":"tray-p01.nc","ncHash":"h1"}]}'
"#;

        /// A stand-in that never finishes on its own: the cancel and queue tests need a child that
        /// is still running when they act.
        const SLOW_NODE: &str = r#"#!/bin/sh
exec sleep 30
"#;

        fn script(dir: &FsPath, body: &str) -> PathBuf {
            let path = dir.join("fake-node.sh");
            std::fs::write(&path, body).expect("write the fake node");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod the fake node");
            path
        }

        fn service(node: PathBuf, root: PathBuf, max_queue: usize) -> Router {
            service_timed(node, root, max_queue, Duration::from_secs(30))
        }

        fn service_timed(
            node: PathBuf,
            root: PathBuf,
            max_queue: usize,
            wall_clock: Duration,
        ) -> Router {
            let config = RunsConfig {
                node: node.clone(),
                cli: node,
                root,
                concurrency: 1,
                max_queue,
                wall_clock,
                retention: Duration::from_secs(60),
            };
            // The production submit route lives in `house_api` (the shop ETag check owns that
            // state); this route calls the same submit against the manager this test built.
            routes()
                .route("/api/v1/runs", post(test_submit))
                .with_state(RunsState {
                    runs: Some(Arc::new(Runs::new(config))),
                    unavailable: None,
                })
        }

        async fn test_submit(
            State(state): State<RunsState>,
            axum::Json(body): axum::Json<Value>,
        ) -> Response<Body> {
            submit_with(&state, &body)
        }

        async fn body_json(res: Response<Body>) -> Value {
            let bytes = to_bytes(res.into_body(), usize::MAX).await.expect("read the body");
            serde_json::from_slice(&bytes).expect("the answer is JSON")
        }

        async fn submit(app: &Router, job: Value) -> (StatusCode, Value) {
            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/v1/runs")
                        .header("content-type", "application/json")
                        .body(Body::from(json!({ "job": job }).to_string()))
                        .expect("the request"),
                )
                .await
                .expect("the route answers");
            let status = res.status();
            (status, body_json(res).await)
        }

        async fn state_of(app: &Router, id: &str) -> Value {
            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/v1/runs/{id}"))
                        .body(Body::empty())
                        .expect("the request"),
                )
                .await
                .expect("the route answers");
            body_json(res).await
        }

        async fn settle(app: &Router, id: &str) -> Value {
            for _ in 0..200 {
                let snap = state_of(app, id).await;
                let state = snap.get("state").and_then(Value::as_str).unwrap_or("");
                if matches!(state, "done" | "failed" | "cancelled") {
                    return snap;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("the run did not settle");
        }

        #[tokio::test]
        async fn a_job_whose_fields_are_shell_metacharacters_plans_inside_its_scratch_dir() {
            let dir = tempfile::tempdir().expect("a temp dir");
            let node = script(dir.path(), FAKE_NODE);
            let root = dir.path().join("runs");
            let app = service(node, root.clone(), 8);

            // The job's own text is hostile; it is written to a file and never becomes an argument.
            let job = json!({ "name": "$(touch pwned); `id`; rm -rf /", "n": 1 });
            let (status, reply) = submit(&app, job.clone()).await;
            assert_eq!(status, StatusCode::ACCEPTED, "{reply}");
            let id = reply["runId"].as_str().expect("a run id").to_owned();
            assert_eq!(reply["key"]["jobSha"].as_str().map(str::len), Some(64));

            let snap = settle(&app, &id).await;
            assert_eq!(snap["state"], "done", "{snap}");
            assert_eq!(snap["programs"], json!([{ "name": "tray-p01.nc", "hash": sha256_hex(b"G0 X0 Y0\n") }]));

            // The program by name, and the whole generated document.
            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/v1/runs/{id}/programs/tray-p01.nc"))
                        .body(Body::empty())
                        .expect("the request"),
                )
                .await
                .expect("the route answers");
            assert_eq!(res.status(), StatusCode::OK);
            let bytes = to_bytes(res.into_body(), usize::MAX).await.expect("the body");
            assert_eq!(&bytes[..], b"G0 X0 Y0\n");

            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/v1/runs/{id}/generated"))
                        .body(Body::empty())
                        .expect("the request"),
                )
                .await
                .expect("the route answers");
            assert_eq!(res.status(), StatusCode::OK);
            let generated = body_json(res).await;
            assert_eq!(generated["ok"], true);
            // The job rode into the fake's output through its FILE, intact.
            assert_eq!(generated["job"]["name"], job["name"], "{generated}");

            // Nothing escaped the scratch directory: no `pwned` anywhere under the current dir.
            assert!(!std::path::Path::new("pwned").exists());

            // A program name that tries to walk out is refused, never served.
            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/v1/runs/{id}/programs/job.json"))
                        .body(Body::empty())
                        .expect("the request"),
                )
                .await
                .expect("the route answers");
            assert_eq!(res.status(), StatusCode::NOT_FOUND);
        }

        #[tokio::test]
        async fn a_run_past_the_wall_clock_is_killed_and_states_the_finding() {
            let dir = tempfile::tempdir().expect("a temp dir");
            let node = script(dir.path(), SLOW_NODE);
            let root = dir.path().join("runs");
            let app = service_timed(node, root, 8, Duration::from_secs(1));

            let (status, reply) = submit(&app, json!({ "name": "slow" })).await;
            assert_eq!(status, StatusCode::ACCEPTED);
            let id = reply["runId"].as_str().expect("a run id").to_owned();
            let started = std::time::Instant::now();
            let snap = settle(&app, &id).await;
            assert_eq!(snap["state"], "failed", "{snap}");
            let finding = snap["finding"].as_str().unwrap_or("");
            assert!(finding.contains("wall-clock cap"), "{finding}");
            // The child was killed, not waited out: the fake sleeps 30 s.
            assert!(started.elapsed() < Duration::from_secs(15), "took {:?}", started.elapsed());
        }

        #[tokio::test]
        async fn a_full_queue_is_a_plain_429_and_a_cancel_stops_the_child() {
            let dir = tempfile::tempdir().expect("a temp dir");
            let node = script(dir.path(), SLOW_NODE);
            let root = dir.path().join("runs");
            let app = service(node, root.clone(), 1);

            let (first, reply) = submit(&app, json!({ "name": "first" })).await;
            assert_eq!(first, StatusCode::ACCEPTED);
            let first_id = reply["runId"].as_str().expect("a run id").to_owned();
            let (second, reply) = submit(&app, json!({ "name": "second" })).await;
            assert_eq!(second, StatusCode::ACCEPTED, "the queue has a slot");
            assert_eq!(reply["queuePosition"], 1);
            let (third, reply) = submit(&app, json!({ "name": "third" })).await;
            assert_eq!(third, StatusCode::TOO_MANY_REQUESTS, "{reply}");
            assert!(reply["error"].as_str().unwrap_or("").contains("queue is full"), "{reply}");

            // Cancel the running child; the state settles `cancelled` and the queued run starts.
            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/api/v1/runs/{first_id}/cancel"))
                        .body(Body::empty())
                        .expect("the request"),
                )
                .await
                .expect("the route answers");
            assert_eq!(res.status(), StatusCode::OK);
            let snap = state_of(&app, &first_id).await;
            assert_eq!(snap["state"], "cancelled", "{snap}");
            // Cancelling a settled run is a 409, not a second kill.
            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/api/v1/runs/{first_id}/cancel"))
                        .body(Body::empty())
                        .expect("the request"),
                )
                .await
                .expect("the route answers");
            assert_eq!(res.status(), StatusCode::CONFLICT);
        }
    }
}
