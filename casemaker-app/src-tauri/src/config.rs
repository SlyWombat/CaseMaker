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

impl AppConfig {
    /// Resolve the effective listen address as a string suitable for
    /// `TcpListener::bind` etc.
    pub fn listen_addr(&self) -> String {
        let host = match &self.host {
            Some(h) if !h.is_empty() => h.clone(),
            _ => {
                if self.bind_to_all {
                    "0.0.0.0".to_string()
                } else {
                    "127.0.0.1".to_string()
                }
            }
        };
        format!("{}:{}", host, self.port)
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
    let dir = config_dir();
    fs::create_dir_all(&dir)?;
    let path = dir.join(CONFIG_FILE);
    let bytes = serde_json::to_vec_pretty(cfg)?;
    fs::write(path, bytes)
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
    fn valid_port_range() {
        assert!(valid_port(1024));
        assert!(valid_port(65535));
        assert!(valid_port(8000));
        assert!(!valid_port(1023));
        assert!(!valid_port(0));
    }
}
