// An optional, controllable power switch on a machine record (#416, decision Q5: "full control, but
// don't assume that there is a controllable switch, most people will not").
//
// NONE IS THE DEFAULT. A machine record carries `power: null` unless the user sets one up, and with
// none nothing anywhere refers to power. A configured switch names a PROVIDER — Home Assistant is the
// first, and the enum is where a second would go — plus that provider's own address for the plug.
//
// THE TOKEN IS NEVER IN THE DOCUMENT. It lives in the desktop's secure store (Windows Credential
// Manager / macOS Keychain, through `keyring`), keyed by the machine's id, behind the `SecretStore`
// trait so no test ever reaches the real store. It is not in `location.json`, the export, `/location`,
// a log line or an error string; a read only answers whether one is saved. On a platform with no
// secure store this build knows, saving one is REFUSED — there is no in-memory fallback that would
// quietly lose it at the next launch.
//
// THE CALLS ARE `tools/z1/power.sh`'s. `GET /api/states/<entity>` reads the plug, and `POST
// /api/services/switch/turn_on|turn_off` with `{"entity_id": …}` switches it, each with `Authorization:
// Bearer <token>`. They go over a deliberately small HTTP/1.0 client on a plain TCP socket: HTTP/1.0
// with `Connection: close` means the answer is never chunked and ends at EOF, which is all a parser
// this size needs to be right about. `https://` is refused with a reason rather than sent in clear
// to a server that expects TLS.
//
// WHAT IS NOT HERE: the GUARDS. "Never off while running; off only after Idle and a home" needs the
// controller's status line, which only the client can read (its framing is `protocol.ts`), so the
// rules are pure functions in `store/powerStore.ts` that are handed the evidence.

use crate::house::HouseError;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};

/// Who switches the plug. One provider today; the next one is a new variant, not a new field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PowerProvider {
    HomeAssistant,
}

/// A configured switch, as the machine record stores it. No secret in it, ever.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PowerSwitch {
    pub provider: PowerProvider,
    /// `http://host:port` of the Home Assistant instance.
    pub base_url: String,
    /// The plug's entity, `switch.makera_cnc`.
    pub entity_id: String,
}

impl PowerSwitch {
    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        let bad = |why: String| Err(HouseError::BadEntry(format!("the power switch: {why}")));
        if self.base_url.starts_with("https://") {
            return bad(
                "https:// is not supported yet — this build talks to Home Assistant over plain http on \
                 the LAN; use its http:// address"
                    .into(),
            );
        }
        if parse_http_url(&self.base_url).is_err() {
            return bad(format!("{:?} is not an http://host[:port] address", self.base_url));
        }
        let ok_entity = self
            .entity_id
            .split_once('.')
            .is_some_and(|(domain, object)| {
                domain == "switch"
                    && !object.is_empty()
                    && object.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            });
        if !ok_entity {
            return bad(format!(
                "{:?} is not a switch entity — it looks like switch.makera_cnc",
                self.entity_id
            ));
        }
        Ok(())
    }
}

/// `http://host[:port][/]` → (host, port). Nothing else is accepted: no path, no query, no userinfo.
pub(crate) fn parse_http_url(url: &str) -> Result<(String, u16), String> {
    let rest = url.strip_prefix("http://").ok_or("not http://")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', ' ']) {
        return Err("not a bare host".into());
    }
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let (addr, after) = v6.split_once(']').ok_or("an unclosed [")?;
        (addr, after.strip_prefix(':'))
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        }
    };
    let port = match port {
        Some(p) => p.parse::<u16>().map_err(|_| "bad port")?,
        None => 80,
    };
    if host.is_empty() || port == 0 {
        return Err("no host, or port 0".into());
    }
    Ok((host.to_string(), port))
}

// — the secure store ----------------------------------------------------------------------------

/// Where a switch's token is kept. The OS store in the app; an in-memory one in every test.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The service name the OS store files the tokens under.
#[cfg_attr(test, allow(dead_code))]
const SECRET_SERVICE: &str = "Case Maker";

/// The account a machine's token is filed under: the machine AND the provider AND the exact
/// `host:port` it was saved for (#416 review). A token is a credential for ONE server; filed this way
/// it can never be sent anywhere else — a switch whose address is changed (by a hand edit, an import,
/// anything) simply has no token until one is saved for the new address. The store also deletes the
/// old one whenever the address moves (`house.rs`), so nothing is left behind either.
pub fn token_account(machine_id: &str, sw: &PowerSwitch) -> String {
    let (host, port) = parse_http_url(&sw.base_url).unwrap_or_else(|_| (sw.base_url.clone(), 0));
    let provider = match sw.provider {
        PowerProvider::HomeAssistant => "home-assistant",
    };
    format!("power-switch:{machine_id}@{provider}:{host}:{port}")
}

/// Whether two configs point the token at the same server: same provider, same host and port.
pub fn same_server(a: &PowerSwitch, b: &PowerSwitch) -> bool {
    a.provider == b.provider && parse_http_url(&a.base_url).ok() == parse_http_url(&b.base_url).ok()
}

/// The desktop's own store: Credential Manager on Windows, the Keychain on macOS. Anywhere else this
/// build has none, and says so rather than keeping a token somewhere that forgets it.
#[cfg_attr(test, allow(dead_code))]
pub struct OsSecretStore;

#[cfg(any(windows, target_os = "macos"))]
impl SecretStore for OsSecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SECRET_SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("the secure store could not be read: {e}")),
        }
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(SECRET_SERVICE, account)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| format!("the secure store would not keep it: {e}"))
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SECRET_SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("the secure store could not remove it: {e}")),
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
impl SecretStore for OsSecretStore {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn set(&self, _account: &str, _secret: &str) -> Result<(), String> {
        let _ = SECRET_SERVICE;
        Err("this platform has no secure store this build can use, so the token is not saved — \
             a power switch needs the Windows or macOS desktop build"
            .into())
    }
    fn delete(&self, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

/// An in-memory store, for tests. Not even compiled into the app.
#[cfg(test)]
#[derive(Default)]
pub struct MemorySecretStore(Mutex<HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.into(), secret.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

// — the provider ---------------------------------------------------------------------------------

/// What the plug says. `Other` carries the provider's own word (`unavailable` when HA cannot reach it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum PlugState {
    On,
    Off,
    Other(String),
}

const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
/// The most a provider's answer may be. A state read is a few hundred bytes.
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;

/// One request. Returns the status code and body. The token goes in a header and nowhere else: no
/// error string built here contains the request.
async fn http(
    base_url: &str,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let (host, port) = parse_http_url(base_url)?;
    let work = async {
        let mut stream = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("{base_url} did not accept a connection: {e}"))?;
        let body = body.unwrap_or("");
        let request = format!(
            "{method} {path} HTTP/1.0\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| format!("{base_url} closed the connection: {e}"))?;
        // Capped (#416 review): a server that never stops talking cannot grow this without bound.
        let mut raw = Vec::new();
        (&mut stream)
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut raw)
            .await
            .map_err(|e| format!("{base_url} stopped answering: {e}"))?;
        if raw.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(format!("{base_url} answered with more than {MAX_RESPONSE_BYTES} bytes"));
        }
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (head, rest) = text.split_once("\r\n\r\n").ok_or("the answer was not HTTP")?;
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .ok_or("the answer had no status")?;
        Ok::<_, String>((status, rest.to_string()))
    };
    timeout(HTTP_TIMEOUT, work)
        .await
        .map_err(|_| format!("{base_url} did not answer within {} s", HTTP_TIMEOUT.as_secs()))?
}

fn explain(status: u16, what: &str) -> String {
    match status {
        401 | 403 => format!("Home Assistant refused the token ({status}) — save a new one"),
        404 => format!("Home Assistant has no {what} (404)"),
        _ => format!("Home Assistant answered {status} for {what}"),
    }
}

/// Read the plug. `GET /api/states/<entity>` — power.sh's `plug_state`.
pub async fn plug_state(sw: &PowerSwitch, token: &str) -> Result<PlugState, String> {
    let (status, body) = http(&sw.base_url, token, "GET", &format!("/api/states/{}", sw.entity_id), None).await?;
    if status != 200 {
        return Err(explain(status, &sw.entity_id));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "Home Assistant's answer was not JSON".to_string())?;
    Ok(match v.get("state").and_then(|s| s.as_str()) {
        Some("on") => PlugState::On,
        Some("off") => PlugState::Off,
        Some(other) => PlugState::Other(other.to_string()),
        None => return Err("Home Assistant's answer had no state".into()),
    })
}

/// Switch the plug. `POST /api/services/switch/turn_on|turn_off` — power.sh's `plug_set`.
pub async fn plug_set(sw: &PowerSwitch, token: &str, on: bool) -> Result<(), String> {
    let service = if on { "turn_on" } else { "turn_off" };
    let body = serde_json::json!({ "entity_id": sw.entity_id }).to_string();
    let (status, _) = http(
        &sw.base_url,
        token,
        "POST",
        &format!("/api/services/switch/{service}"),
        Some(&body),
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(explain(status, &format!("switch/{service}")));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::net::TcpListener;

    /// A fake Home Assistant on a local port: records each request's first line, its bearer and its
    /// body, and answers like HA does. The plug's state flips on the switch calls. Nothing here, or
    /// anywhere in the tests, reaches the real Home Assistant.
    pub(crate) struct FakeHa {
        pub base_url: String,
        pub seen: Arc<Mutex<Vec<String>>>,
    }

    pub(crate) async fn fake_ha(token: &'static str) -> FakeHa {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let state = Arc::new(Mutex::new("off".to_string()));
        let (seen2, state2) = (seen.clone(), state.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let (seen, state) = (seen2.clone(), state2.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let mut got = Vec::new();
                    // Read the head, then as much body as Content-Length says.
                    loop {
                        let n = sock.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        got.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&got).to_string();
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("Content-Length: "))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            if body.len() >= len {
                                break;
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&got).to_string();
                    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                    let first = head.lines().next().unwrap_or("").to_string();
                    let authed = head.lines().any(|l| l == format!("Authorization: Bearer {token}"));
                    seen.lock().unwrap().push(format!("{first} | {body}"));
                    let (code, reply) = if !authed {
                        (401, "{\"message\":\"Invalid authentication\"}".to_string())
                    } else if first.starts_with("GET /api/states/switch.makera_cnc ") {
                        let s = state.lock().unwrap().clone();
                        (200, format!("{{\"entity_id\":\"switch.makera_cnc\",\"state\":\"{s}\"}}"))
                    } else if first.starts_with("POST /api/services/switch/turn_on ") {
                        *state.lock().unwrap() = "on".into();
                        (200, "[]".into())
                    } else if first.starts_with("POST /api/services/switch/turn_off ") {
                        *state.lock().unwrap() = "off".into();
                        (200, "[]".into())
                    } else {
                        (404, "{}".into())
                    };
                    let res = format!(
                        "HTTP/1.0 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{reply}",
                        reply.len()
                    );
                    let _ = sock.write_all(res.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        FakeHa { base_url, seen }
    }

    pub(crate) fn a_switch(base_url: &str) -> PowerSwitch {
        PowerSwitch {
            provider: PowerProvider::HomeAssistant,
            base_url: base_url.to_string(),
            entity_id: "switch.makera_cnc".into(),
        }
    }

    #[tokio::test]
    async fn it_makes_power_sh_calls_against_a_fake_home_assistant() {
        let ha = fake_ha("tok-123").await;
        let sw = a_switch(&ha.base_url);
        assert_eq!(plug_state(&sw, "tok-123").await.unwrap(), PlugState::Off);
        plug_set(&sw, "tok-123", true).await.unwrap();
        assert_eq!(plug_state(&sw, "tok-123").await.unwrap(), PlugState::On);
        plug_set(&sw, "tok-123", false).await.unwrap();
        let seen = ha.seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            [
                "GET /api/states/switch.makera_cnc HTTP/1.0 | ",
                "POST /api/services/switch/turn_on HTTP/1.0 | {\"entity_id\":\"switch.makera_cnc\"}",
                "GET /api/states/switch.makera_cnc HTTP/1.0 | ",
                "POST /api/services/switch/turn_off HTTP/1.0 | {\"entity_id\":\"switch.makera_cnc\"}",
            ]
        );
    }

    #[tokio::test]
    async fn a_refused_token_is_named_and_the_token_is_not() {
        let ha = fake_ha("right").await;
        let err = plug_state(&a_switch(&ha.base_url), "wrong-secret").await.unwrap_err();
        assert!(err.contains("refused the token"), "{err}");
        assert!(!err.contains("wrong-secret"), "the token leaked into {err}");
    }

    #[test]
    fn a_switch_config_is_held_to_its_rules() {
        a_switch("http://homeassistant.local:8123").validate().unwrap();
        a_switch("http://192.168.10.5:8123/").validate().unwrap();
        for (why, sw) in [
            ("https", a_switch("https://ha.example:8123")),
            ("a path", a_switch("http://ha.local:8123/api")),
            ("no scheme", a_switch("ha.local:8123")),
            (
                "a light, not a switch",
                PowerSwitch { entity_id: "light.kitchen".into(), ..a_switch("http://ha:8123") },
            ),
            ("no object id", PowerSwitch { entity_id: "switch.".into(), ..a_switch("http://ha:8123") }),
        ] {
            assert!(sw.validate().is_err(), "{why} was accepted");
        }
        assert!(a_switch("https://x").validate().unwrap_err().to_string().contains("https"));
        assert_eq!(parse_http_url("http://ha.local:8123").unwrap(), ("ha.local".into(), 8123));
        assert_eq!(parse_http_url("http://ha.local").unwrap(), ("ha.local".into(), 80));
    }

    #[test]
    fn the_memory_store_keeps_and_forgets() {
        let s = MemorySecretStore::default();
        assert_eq!(s.get("a").unwrap(), None);
        s.set("a", "x").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("x"));
        s.delete("a").unwrap();
        assert_eq!(s.get("a").unwrap(), None);
    }
}
