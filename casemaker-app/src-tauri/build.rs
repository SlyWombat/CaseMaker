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
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
