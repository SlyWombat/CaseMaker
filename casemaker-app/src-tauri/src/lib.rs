use clap::Parser;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod config;
mod server;

#[derive(Debug, Parser)]
#[command(name = "casemaker", about = "Parametric 3D-printable enclosure designer")]
struct CliArgs {
    /// Bind the embedded HTTP server to 0.0.0.0 instead of 127.0.0.1.
    /// Required for LAN access from other devices. Off by default.
    #[arg(long, default_value_t = false)]
    bind_all: bool,

    /// Override the configured port for this run only.
    #[arg(long)]
    port: Option<u16>,

    /// Print effective config and exit.
    #[arg(long, default_value_t = false)]
    print_config: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::try_init();
    let args = CliArgs::parse();

    let mut cfg = config::load_config();
    if args.bind_all {
        cfg.bind_to_all = true;
    }
    if let Some(p) = args.port {
        if config::valid_port(p) {
            cfg.port = p;
        }
    }
    if args.print_config {
        println!(
            "{{\"port\":{},\"bind_to_all\":{}}}",
            cfg.port, cfg.bind_to_all
        );
        return;
    }
    // Best-effort persist (ignore IO errors)
    let _ = config::save_config(&cfg);

    let server_cfg = server::ServerConfig {
        requested_port: cfg.port,
        bind_to_all: cfg.bind_to_all,
    };

    let server_handle = match server::start(server_cfg) {
        Ok((handle, _stop_rx)) => {
            log::info!(
                "casemaker http server bound to {}:{}",
                handle.bind_addr,
                handle.bound_port
            );
            Some(handle)
        }
        Err(e) => {
            log::error!("failed to start http server: {e}");
            None
        }
    };

    let window_url = match server_handle {
        Some(h) => format!("http://127.0.0.1:{}", h.bound_port),
        None => "tauri://localhost".to_string(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let url = WebviewUrl::External(window_url.parse()?);
            let _window = WebviewWindowBuilder::new(app, "main", url)
                .title("Case Maker")
                .inner_size(1400.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .resizable(true)
                .build()?;
            if let Some(h) = server_handle {
                app.manage(h);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Case Maker");
}
