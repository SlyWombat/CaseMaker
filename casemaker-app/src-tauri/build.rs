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
/// `git describe --tags --always --dirty` in the package directory: `v1.0.0-825-gbea18572` for a
/// clean tree 825 commits past the tag, `…-dirty` when the working tree has uncommitted changes
/// (a local build), and the short SHA alone when no tag is reachable. With no git at all — a
/// source archive, a container without the CLI — the string is `unknown`: the health endpoint
/// then says it does not know rather than claiming a version nobody built.
///
/// The value is handed to the crate as `CM_BUILD` (`house.rs` reads it with `env!`), and this
/// script reruns when git's HEAD or index moves, so a `cargo run` after a commit does not keep the
/// old string. The frontend's own build string comes from `vite.config.ts`; the two are computed
/// independently at build time from the same tree, and in the desktop app both name the same commit.
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

    let build = git(&["describe", "--tags", "--always", "--dirty"]).unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=CM_BUILD={build}");

    // The inputs `git describe` reads: HEAD (branch switches, detached checkouts) and the index
    // (a file becoming dirty or clean). `--git-path` resolves both through a worktree's `.git` file.
    for name in ["HEAD", "index"] {
        if let Some(path) = git(&["rev-parse", "--git-path", name]) {
            let path = manifest_dir.join(path);
            if path.exists() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}
