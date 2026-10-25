// The app's own IPC commands are declared here so Tauri generates an `allow-<command>` permission
// for each. The window loads the app from the embedded server (http://127.0.0.1:<port>, #312),
// which Tauri treats as a remote origin, and a remote origin may only call app commands that a
// capability grants by name (capabilities/default.json). Keep this list in step with
// `generate_handler!` in lib.rs: a command missing here is refused with "not allowed by ACL".
const COMMANDS: &[&str] = &[
    "machine_udp_listen",
    "machine_tcp_connect",
    "machine_tcp_write",
    "machine_tcp_read",
    "machine_tcp_close",
];

// #566 follow-up — the build-string precedence. The crate compiles the same file under `cfg(test)`
// (lib.rs), so the rule the script runs is the rule its tests pin.
#[path = "src/build_stamp.rs"]
mod build_stamp;

fn main() {
    emit_build_string();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

/// #566 — the COMMIT a binary was built from, which the static crate version cannot say.
///
/// The sources, strongest first (`build_stamp::pick_build` holds the precedence and its tests):
///
/// 1. **`CASEMAKER_BUILD`, when set.** A publish that already knows the sha it is stamping — the
///    k3 rig's `cm_build.sh` builds from a source tree with no git — sets this, so an image whose
///    tag names a commit reports that commit instead of `unknown`.
/// 2. `git describe --tags --always --dirty` in the package directory: `v1.0.0-825-gbea18572` for
///    a clean tree 825 commits past the tag, `…-dirty` when the working tree has uncommitted
///    changes (a local build), and the short SHA alone when no tag is reachable.
/// 3. `unknown` — no stamp and no git (a source archive, a container without the CLI): the health
///    endpoint then says it does not know rather than claiming a version nobody built.
///
/// The value is handed to the crate as `CM_BUILD` (`house.rs` reads it with `env!`), and this
/// script reruns when `CASEMAKER_BUILD` changes or git's state moves, so a `cargo run` after a
/// commit, or after the stamp is set or cleared, does not keep the old string. This is the only
/// commit string the app reports: the health endpoint carries it and the Machines card shows it,
/// while `vite.config.ts` stamps the package version alone.
///
/// #641 — WHAT "GIT'S STATE" IS, as cargo inputs. Watching only HEAD and the index was false for
/// the two common cases: a plain working-tree EDIT touches neither (editing a source file rebuilt
/// a binary still stamped CLEAN), and a commit that leaves the index alone — `--amend -m`,
/// `--allow-empty`, `reset --soft`, a fast-forward — moves only the branch ref or `packed-refs`
/// (the old sha stuck). The inputs are therefore HEAD, the index, `packed-refs`, the ref HEAD
/// names, `refs/heads/`, and the crate's own sources. The rig does not rely on any of this: it
/// stamps with `CASEMAKER_BUILD` (#566).
fn emit_build_string() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let git = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(&manifest_dir)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    };

    // #566 follow-up — an explicit stamp wins, and the variable being set, changed or cleared is
    // itself an input: cargo re-runs this script when it differs from the last build.
    println!("cargo:rerun-if-env-changed=CASEMAKER_BUILD");
    let explicit = std::env::var("CASEMAKER_BUILD").ok();
    let described = git(&["describe", "--tags", "--always", "--dirty"]);
    let build = build_stamp::pick_build(explicit.as_deref(), described.as_deref());
    println!("cargo:rustc-env=CM_BUILD={build}");

    // The inputs `git describe --dirty` reads (#641): HEAD (branch switches, detached checkouts),
    // the index (a file becoming dirty or clean), `packed-refs` and the ref HEAD names together with
    // `refs/heads/` (a commit that does not rewrite the index still moves one of them), and the
    // crate's own sources (a working-tree edit touches none of the git files). `--git-path`
    // resolves each through a worktree's `.git` file. Cargo scans a DIRECTORY argument recursively.
    let mut inputs: Vec<std::path::PathBuf> = Vec::new();
    for name in ["HEAD", "index", "packed-refs", "refs/heads"] {
        if let Some(path) = git(&["rev-parse", "--git-path", name]) {
            inputs.push(manifest_dir.join(path));
        }
    }
    if let Some(sym) = git(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git(&["rev-parse", "--git-path", &sym]) {
            inputs.push(manifest_dir.join(path));
        }
    }
    inputs.push(manifest_dir.join("src"));
    inputs.push(manifest_dir.join("Cargo.toml"));
    inputs.push(manifest_dir.join("build.rs"));
    for path in inputs {
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
