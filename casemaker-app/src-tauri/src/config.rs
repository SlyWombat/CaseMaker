use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 8000;
pub const APP_DIR_NAME: &str = "casemaker";
pub const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub bind_to_all: bool,
    /// Optional explicit listen IP (e.g. "192.168.10.16"). When set, takes
    /// precedence over `bind_to_all`. Empty string / None = use the existing
    /// 127.0.0.1 / 0.0.0.0 behaviour.
    ///
    /// #399 — `--host` is a PER-RUN override and does not write this field. A one-off diagnostic
    /// `--host` that persisted could not be seen or cleared in the app (no screen shows the host),
    /// so the field is set by the installer's `/HOST=` or a hand edit and is the address every
    /// later launch binds.
    ///
    /// There is deliberately no `listen_addr` on this struct. `server.rs::start` is the one place
    /// that turns these three fields into a socket address, because it also VALIDATES `host` as an
    /// IP literal and falls back to `bind_to_all`/loopback with a warning when it is not one. A
    /// second, string-returning copy here would take a bad value at face value and hand it to the
    /// resolver instead — the failure mode the live one exists to avoid.
    #[serde(default)]
    pub host: Option<String>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            bind_to_all: false,
            host: None,
        }
    }
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_DIR_NAME)
}

pub fn config_path() -> PathBuf {
    config_dir().join(CONFIG_FILE)
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    load_from(&path).unwrap_or_default()
}

pub fn load_from(path: &Path) -> Option<AppConfig> {
    let bytes = fs::read(path).ok()?;
    let mut cfg: AppConfig = serde_json::from_slice(&bytes).ok()?;
    if !valid_port(cfg.port) {
        cfg.port = DEFAULT_PORT;
    }
    Some(cfg)
}

pub fn save_config(cfg: &AppConfig) -> std::io::Result<()> {
    save_to(&config_path(), cfg)
}

/// Write the settings to a named file (#372).
///
/// The path is a PARAMETER for the same reason `HouseStore::open` takes a directory: the endpoint
/// that writes the settings is served by the running app, and a test that ran it against
/// `config_path()` would rewrite the settings of whichever machine ran the suite. The real callers
/// pass `config_path()`; the tests pass a `TempDir`.
///
/// THE BYTES LAND BY RENAME, NOT BY `fs::write`. A save is a read-modify-write — the endpoint merges
/// into what the file holds, so it read it a moment earlier — and the file carries `host`, which no
/// screen can restore: a write torn by a kill or a full disk leaves the file truncated, `load_from`
/// then reads `None`, and the next launch comes up on the DEFAULTS with the user's `host` silently
/// gone. Writing beside the target and renaming makes the new document appear whole or not at all;
/// `fs::rename` within one directory is atomic on every platform this ships to.
pub fn save_to(path: &Path, cfg: &AppConfig) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(cfg)?;
    let mut scratch = path.as_os_str().to_owned();
    scratch.push(".tmp");
    let scratch = PathBuf::from(scratch);
    // A failed write or rename leaves the real file as it was; the scratch copy goes with it rather
    // than waiting for a later run to trip over it.
    if let Err(e) = fs::write(&scratch, bytes) {
        let _ = fs::remove_file(&scratch);
        return Err(e);
    }
    if let Err(e) = fs::rename(&scratch, path) {
        let _ = fs::remove_file(&scratch);
        return Err(e);
    }
    Ok(())
}

pub fn valid_port(p: u16) -> bool {
    (1024..=65535).contains(&p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn default_is_8000() {
        assert_eq!(AppConfig::default().port, DEFAULT_PORT);
        assert!(!AppConfig::default().bind_to_all);
    }

    #[test]
    fn load_from_missing_returns_none() {
        let path = std::env::temp_dir().join("casemaker-nonexistent-config.json");
        let _ = fs::remove_file(&path);
        assert!(load_from(&path).is_none());
    }

    #[test]
    fn load_from_clamps_invalid_port() {
        let mut tmp = NamedTempFile::new().unwrap();
        tmp.write_all(br#"{"port": 80, "bind_to_all": false}"#).unwrap();
        let cfg = load_from(tmp.path()).unwrap();
        assert_eq!(cfg.port, DEFAULT_PORT);
    }

    #[test]
    fn save_to_leaves_no_scratch_copy_and_replaces_what_is_there() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        save_to(
            &path,
            &AppConfig {
                port: 8000,
                bind_to_all: false,
                host: Some("192.168.10.16".to_string()),
            },
        )
        .unwrap();
        save_to(
            &path,
            &AppConfig {
                port: 8123,
                bind_to_all: true,
                host: Some("192.168.10.16".to_string()),
            },
        )
        .unwrap();

        let cfg = load_from(&path).unwrap();
        assert_eq!(cfg.port, 8123);
        assert!(cfg.bind_to_all);
        assert_eq!(cfg.host.as_deref(), Some("192.168.10.16"));
        // The rename's scratch file is not left beside the settings for a later run to read.
        assert!(!dir.path().join("config.json.tmp").exists());
    }

    #[test]
    fn valid_port_range() {
        assert!(valid_port(1024));
        assert!(valid_port(65535));
        assert!(valid_port(8000));
        assert!(!valid_port(1023));
        assert!(!valid_port(0));
    }
}
