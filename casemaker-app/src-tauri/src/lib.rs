use std::net::{IpAddr, Ipv4Addr};

use clap::Parser;
use house::{house_dir, HouseLock};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

// #566 follow-up — the build-string precedence `build.rs` applies, compiled here for its tests
// only: the script and the tests run the same function.
#[cfg(test)]
mod build_stamp;
mod camera_api;
mod catalogue;
mod config;
mod config_api;
mod crash_log;
mod defaults;
mod etag;
mod feeds;
mod finished_programs;
mod guard;
mod house;
mod house_api;
mod location;
mod machine;
mod machine_api;
mod machine_profiles;
mod server;
mod power;
mod stock;
mod tool_copy;
mod wasteboard;

#[derive(Debug, Parser)]
#[command(name = "casemaker", about = "Parametric 3D-printable enclosure designer")]
struct CliArgs {
    /// Bind the embedded HTTP server to 0.0.0.0 instead of 127.0.0.1.
    /// Required for LAN access from other devices. Off by default.
    #[arg(long, default_value_t = false)]
    bind_all: bool,

    /// Serve on this port instead, and save it as the configured port — the override is persisted
    /// (`save_config` runs below), so it applies to later runs too, not just this one.
    #[arg(long)]
    port: Option<u16>,

    /// Use this address for THIS run only; it is not saved. Later runs serve on the host in
    /// config.json (the installer's /HOST, or a hand edit), or loopback. Wins over --bind-all.
    #[arg(long)]
    host: Option<String>,

    /// Print the config file this run would write, then exit.
    #[arg(long, default_value_t = false)]
    print_config: bool,
}

/// The desktop window's permission list, as a document — `capabilities/default.json`, read here
/// rather than restated, because a second copy of a permission list drifts from the first one
/// silently. tauri-build resolves every identifier in that file; see `window_capability` for the
/// one field it cannot fill in (#389).
const CAPABILITY_FILE: &str = include_str!("../capabilities/default.json");

/// The window's grant, for the origin it will actually load (#389).
///
/// `resolve_access` judges every IPC call against the CALLER'S ORIGIN, and this window's origin is
/// its own embedded server: `http://<host>:<port>`, where the port comes from `--port` or the
/// settings file and the host is loopback unless `--host`/`--bind-all` asked for a LAN address. A
/// capability file is read at build time, so all it can do is guess — and that guess was wrong in
/// both directions: with an explicit `--host 192.168.10.16` the window came up on an origin no
/// capability named, so every `machine_*` command answered "not allowed by ACL", while the loopback
/// pattern that replaced it (`http://127.0.0.1:*/*`) also handed the raw UDP/TCP transport to any
/// page on ANY local port. So `capabilities/default.json` holds the permission list and no origin,
/// and this function instantiates it for the one URL the server bound.
///
/// The URL is a URLPattern (Tauri's remote matching), so the path is left open the way the old
/// entry left it; the host and port are exact. The window is built after this runs, so it never
/// exists without its grant.
/// #787 — where the desktop crash log lives: the app's log directory, else its data directory,
/// else the temp directory. One file (`crash.log`), appended by `crash_log::attach`.
fn crash_log_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_log_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("crash.log")
}

/// #787 — the tail of the desktop crash log, for the crash report the page offers to save or send.
/// Empty when no WebView2 process has failed on this machine (or the log cannot be read).
#[tauri::command]
fn crash_log_tail(app: tauri::AppHandle) -> Vec<String> {
    crash_log::tail(&crash_log_path(&app))
}

fn window_capability(origin: &str) -> Result<String, serde_json::Error> {
    let mut document: serde_json::Value = serde_json::from_str(CAPABILITY_FILE)?;
    document["identifier"] = serde_json::Value::from("embedded-server");
    document["remote"] = serde_json::json!({ "urls": [format!("{origin}/*")] });
    Ok(document.to_string())
}

/// The address the window is loaded from — and, since #389, the one its capability grants (#402).
///
/// 127.0.0.1 is the working path for the two cases the app means to serve: the unspecified address,
/// which the OS routes to the loopback path, and the primary loopback itself. Any other bound
/// address is used as it is, because the window's origin has to be an address this machine is known
/// to answer on, and the server bound exactly one.
///
/// That predicate is NOT `is_loopback()`, which is true for the whole of `127.0.0.0/8`: a sibling
/// loopback — `--host 127.0.0.2`, the ordinary way to run a second instance off 127.0.0.1 — was
/// bound and then thrown away, so the window, and with it every `machine_*` grant, pointed at
/// 127.0.0.1, where this run had nothing listening (#402).
///
/// #401 settled V6 by REFUSING it rather than by spelling it: `server.rs`'s `bind_addr_for` never
/// binds an IPv6 address, whether it arrived as `--host` (refused for the run by `host_for_run`
/// below, and never written back since #399) or out of a `config.json` that already holds one
/// (refused at the bind). So no V6 address reaches this function from `run()` any more. The two V6
/// arms stay as this function's total answer to an `IpAddr` — a match has to answer for every arm,
/// and answering "loopback" cannot hand Tauri the unbracketed address it panics on. `server.rs`'s
/// `host_refusal` carries the whole reasoning.
fn webview_host(bind_addr: IpAddr) -> String {
    match bind_addr {
        IpAddr::V4(v4) if v4.is_unspecified() || v4 == Ipv4Addr::LOCALHOST => {
            "127.0.0.1".to_string()
        }
        IpAddr::V6(v6) if v6.is_unspecified() || v6.is_loopback() => "127.0.0.1".to_string(),
        ip => ip.to_string(),
    }
}

/// The `--host` value this run may SERVE on — `Ok` for a host the shell can serve, `Err` with the
/// reason for one it refuses (#401).
///
/// It only decides THIS RUN (#399): the value is never written back, so a one-off diagnostic
/// `--host` cannot become every later launch's bind address. The refusal is still asked here so the
/// run falls to the saved host or loopback with one clear warning, rather than handing the server
/// an address it would discard at bind anyway. Extracted so the decision can be asserted on its own
/// rather than only by starting a process.
fn host_for_run(host: &str) -> Result<&str, &'static str> {
    match server::host_refusal(host) {
        Some(why) => Err(why),
        None => Ok(host),
    }
}

/// Apply this run's CLI overrides to the settings read from disk (#399).
///
/// `--port` and `--bind-all` are SETTINGS the dialog shows and writes back, so their overrides are
/// persisted with the rest of the file — `--port`'s help says so. `--host` is not: no screen shows
/// or clears the host, so a persisted one could neither be seen nor undone in the app, which is the
/// #399 footgun (one diagnostic launch bound every later one). It is this run's listen address only,
/// and the host in the file stands for later runs when the flag is absent or refused.
///
/// Returns the settings to save and the host to serve on.
fn settings_for_run(
    mut saved: config::AppConfig,
    args: &CliArgs,
) -> (config::AppConfig, Option<String>) {
    if args.bind_all {
        saved.bind_to_all = true;
    }
    if let Some(p) = args.port {
        if config::valid_port(p) {
            saved.port = p;
        }
    }
    let run_host = match args.host.as_deref() {
        Some(h) => match host_for_run(h) {
            Ok(host) => Some(host.to_string()),
            Err(why) => {
                log::warn!(
                    "{why}: ignoring --host {h} for this run; the saved host (or loopback) is used instead"
                );
                None
            }
        },
        None => None,
    };
    let run_host = run_host.or_else(|| saved.host.clone());
    (saved, run_host)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::try_init();
    let args = CliArgs::parse();

    let (cfg, run_host) = settings_for_run(config::load_config(), &args);
    if args.print_config {
        println!(
            "{{\"port\":{},\"bind_to_all\":{},\"host\":{}}}",
            cfg.port,
            cfg.bind_to_all,
            cfg.host.as_deref().map(|h| format!("\"{}\"", h)).unwrap_or_else(|| "null".to_string()),
        );
        return;
    }
    // Best-effort persist (ignore IO errors)
    let _ = config::save_config(&cfg);

    let server_cfg = server::ServerConfig {
        requested_port: cfg.port,
        bind_to_all: cfg.bind_to_all,
        host: run_host,
    };

    tauri::Builder::default()
        // #312 — a second launch must not become a second ORIGIN. This plugin must be registered
        // FIRST (its own requirement): the second process reaches the running instance, hands it its
        // argv and exits before any window, store or listener exists, and the closure below raises
        // the window the user actually meant to reach. Without it the second launch would get as far
        // as the house lock, which is a dialog to dismiss rather than the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // #255 — the machine bridge's raw-socket transport. The sockets live in Rust; the protocol
        // lives in TypeScript under the `canDriveMachine` guard. See Z1-Bridge-Protocol.md §7.
        .manage(machine::MachineTransport::default())
        .invoke_handler(tauri::generate_handler![
            machine::machine_udp_listen,
            machine::machine_tcp_connect,
            machine::machine_tcp_write,
            machine::machine_tcp_read,
            machine::machine_tcp_close,
            crash_log_tail,
        ])
        .setup(move |app| {
            // ONE HOUSE, ONE PROCESS (#321). Taken BEFORE the server starts, because refusing here
            // is the only refusal that costs nothing: a window is not built, a store is not opened
            // and no second port is bound. It is what makes "the process serving the house is the
            // process holding its lock" true rather than merely intended — `server::start` takes
            // `&HouseLock` so the compiler agrees. A second Case Maker launch no longer reaches this
            // point at all (the single-instance plugin focuses the first window and exits, #312);
            // the lock is the backstop for a process the plugin cannot see, and on its own it is why
            // a second instance could never have served a second copy of `house.json`. The lock is
            // released when this closure's `app.manage(lock)` state is dropped at exit, and by the OS
            // if the process is killed.
            let lock = match HouseLock::acquire(&house_dir()) {
                Ok(lock) => lock,
                Err(why) => {
                    log::error!("{why}");
                    // `show`, not `blocking_show`: the blocking form must not run on the main
                    // thread (the plugin says so, and this IS the main thread). Nothing else is
                    // built, so the dialog is the whole UI until it is dismissed.
                    app.dialog()
                        .message(&why)
                        .title("Case Maker is already running")
                        .show(|_| std::process::exit(1));
                    return Ok(());
                }
            };

            // `config::config_path()` is the same file this function has just read and written, so
            // the settings dialog (#372) edits the settings the app actually binds from — one file,
            // one reader, and no second copy in the webview's storage where nothing could see it.
            let server_handle = match server::start(server_cfg, &lock, config::config_path()) {
                Ok((handle, _stop_rx)) => {
                    log::info!(
                        "casemaker http server bound to {}:{}",
                        handle.bind_addr,
                        handle.bound_port
                    );
                    handle
                }
                Err(e) => {
                    // NO `tauri://localhost` FALLBACK (#312). That URL is a DIFFERENT origin, so the
                    // window would come up with none of the user's saved settings, library or run
                    // records and would look exactly like a first run — the silent orphan this issue
                    // is about, reached from the other side. A port that cannot be had is a refusal:
                    // name it and exit. `show`, not `blocking_show`, for the same reason as above.
                    log::error!("failed to start http server: {e}");
                    app.dialog()
                        .message(&e.to_string())
                        .title("Case Maker cannot start")
                        .show(|_| std::process::exit(1));
                    return Ok(());
                }
            };

            // The webview reaches the server over loopback whenever the server is listening there:
            // 127.0.0.1 works for `--bind-all` because the OS routes an unspecified-address bind to
            // the loopback path too. An explicit `--host` is the exception, and it needs to be: the
            // window loads its own server at the address the server was told to bind, because that
            // address is the only one this machine is known to answer on. This URL is the app's
            // ORIGIN, and so the identity of every `localStorage` store it has (#312) — which is
            // exactly why it is not allowed to change under a running app, and why the capability
            // that grants it is built from this string rather than guessed (#389).
            // The predicate moved into `webview_host` (#402) so that the address can be tested on
            // its own, and because it is now narrower than `is_loopback()`.
            let window_url = format!(
                "http://{}:{}",
                webview_host(server_handle.bind_addr),
                server_handle.bound_port
            );

            // #389 — the grant, added BEFORE the window exists, because the URL above is what it
            // grants: this window's origin is the embedded server, and Tauri allows a remote origin
            // to call an app command (the machine transport among them) only when a capability
            // names that URL. `window_capability` owns the reasoning; the refusal below is here for
            // the same reason as the two above it: with no console attached on Windows a panic
            // would be a window that never appears, and the list is instantiated at runtime, so a
            // permission identifier the ACL does not know has nowhere else to show up.
            let grant = window_capability(&window_url)
                .map_err(|why| format!("capabilities/default.json: {why}"))
                .and_then(|grant| app.add_capability(grant).map_err(|why| why.to_string()));
            if let Err(why) = grant {
                log::error!("cannot grant the window its own origin ({window_url}): {why}");
                app.dialog()
                    .message(&format!(
                        "Case Maker cannot let its own window reach the machine bridge at {window_url}: {why}"
                    ))
                    .title("Case Maker cannot start")
                    .show(|_| std::process::exit(1));
                return Ok(());
            }

            let url = WebviewUrl::External(window_url.parse()?);
            let window = WebviewWindowBuilder::new(app, "main", url)
                .title("Case Maker")
                .inner_size(1400.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .resizable(true)
                .build()?;
            // #787 — listen for WebView2 process failures (a renderer killed for memory never
            // reaches the page's own recorder). Best-effort: the recorder's marker still earns
            // the next load's banner; this is the detail that says WHY.
            let crash_log_path = crash_log_path(app.handle());
            let _ = window.with_webview(move |wv| crash_log::attach(&wv, crash_log_path));
            app.manage(server_handle);
            // Held in managed state so the lock outlives `setup` — see `HouseLock`'s own note on
            // why this is a lock on the directory and not a pid file.
            app.manage(lock);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Case Maker");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug #402 is about: the server served a sibling loopback and the window was sent to
    /// 127.0.0.1 anyway, where nothing was listening. `is_loopback()` is true for all of
    /// `127.0.0.0/8`; a sibling address has to be used exactly as it was bound.
    #[test]
    fn webview_host_uses_a_sibling_loopback_as_bound() {
        assert_eq!(webview_host("127.0.0.2".parse().unwrap()), "127.0.0.2");
        assert_eq!(webview_host("127.13.9.4".parse().unwrap()), "127.13.9.4");
    }

    /// The two cases where 127.0.0.1 is the working path whatever was bound, and the LAN case
    /// (#389's `--host 192.168.10.16`, where the window must not fall back to loopback).
    #[test]
    fn webview_host_maps_only_what_loopback_serves() {
        assert_eq!(webview_host("127.0.0.1".parse().unwrap()), "127.0.0.1");
        assert_eq!(webview_host("0.0.0.0".parse().unwrap()), "127.0.0.1");
        assert_eq!(
            webview_host("192.168.10.16".parse().unwrap()),
            "192.168.10.16"
        );
    }

    /// #401 refused V6 before it can become `bind_addr`, so `run()` no longer asks this function
    /// about an IPv6 address. The arms are still asserted because they are what the function answers
    /// with if one ever arrives: loopback, never an unbracketed address, which is the pattern Tauri
    /// panics on. The refusal itself is `server::host_refusal` — and `host_for_run` is what stops a
    /// refused `--host` from reaching the server for the run.
    #[test]
    fn webview_host_still_answers_for_a_v6_address_it_is_no_longer_given() {
        assert_eq!(webview_host("::1".parse().unwrap()), "127.0.0.1");
        assert_eq!(webview_host("::".parse().unwrap()), "127.0.0.1");
        assert_eq!(webview_host("2001:db8::5".parse().unwrap()), "2001:db8::5");
    }

    fn args(host: Option<&str>, port: Option<u16>, bind_all: bool) -> CliArgs {
        CliArgs {
            host: host.map(str::to_string),
            port,
            bind_all,
            print_config: false,
        }
    }

    /// #399 — the decision this issue asks for: a one-off `--host` is this run's listen address and
    /// is NOT written back. The saved host (installer /HOST, or a hand edit) is what later runs use,
    /// because no screen shows or clears the field, so a persisted diagnostic value could not be
    /// undone in the app.
    #[test]
    fn a_one_off_host_is_served_but_not_persisted() {
        let saved = config::AppConfig {
            port: 8000,
            bind_to_all: false,
            host: Some("192.168.10.5".to_string()),
        };
        let (to_save, run_host) =
            settings_for_run(saved.clone(), &args(Some("192.168.10.16"), None, false));

        assert_eq!(run_host.as_deref(), Some("192.168.10.16"), "the run uses the flag");
        assert_eq!(to_save.host.as_deref(), Some("192.168.10.5"), "the file keeps its host");
        assert_eq!(to_save.port, saved.port);
    }

    /// With no flag, the file's host is what the run serves on — the unchanged path.
    #[test]
    fn without_the_flag_the_saved_host_is_served() {
        let saved = config::AppConfig {
            port: 8000,
            bind_to_all: false,
            host: Some("192.168.10.5".to_string()),
        };
        let (_, run_host) = settings_for_run(saved, &args(None, None, false));
        assert_eq!(run_host.as_deref(), Some("192.168.10.5"));
    }

    /// #401 still holds, and #399 makes its hazard smaller: a refused host is not served and not
    /// written. Anything that is not an IPv6 literal — including a string that is not an address at
    /// all — is still used for the run, where the bind warns about it as it always did.
    #[test]
    fn a_refused_host_is_neither_served_nor_saved() {
        let saved = config::AppConfig::default();
        for refused in ["::1", "fe80::1", "2001:db8::5"] {
            let (to_save, run_host) = settings_for_run(saved.clone(), &args(Some(refused), None, false));
            assert_eq!(run_host, None, "{refused} must not be served");
            assert_eq!(to_save.host, None, "{refused} must not be written");
        }
        for kept in ["192.168.10.16", "127.0.0.2", "bogus"] {
            let (_, run_host) = settings_for_run(saved.clone(), &args(Some(kept), None, false));
            assert_eq!(run_host.as_deref(), Some(kept));
        }
    }

    /// `--port` and `--bind-all` stay persisted settings — the dialog shows and writes both — and
    /// `--port`'s help says so.
    #[test]
    fn the_dialog_settings_still_persist() {
        let (to_save, run_host) = settings_for_run(
            config::AppConfig::default(),
            &args(None, Some(5399), true),
        );
        assert_eq!(to_save.port, 5399);
        assert!(to_save.bind_to_all);
        assert_eq!(run_host, None);

        // An invalid port is ignored for the run and the file, as before.
        let (to_save, _) = settings_for_run(
            config::AppConfig::default(),
            &args(None, Some(80), false),
        );
        assert_eq!(to_save.port, config::DEFAULT_PORT);
    }
}
