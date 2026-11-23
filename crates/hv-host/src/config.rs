//! Settings of a self-hosted server, stored in its data directory.

use std::net::IpAddr;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "server.json";
pub const SECRETS_FILE: &str = "secrets.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HostConfig {
    pub name: String,
    /// TCP: HTTP API and proxied LiveKit signaling. Friends connect to this port.
    pub api_port: u16,
    /// TCP: WebRTC over TCP, used when UDP is blocked.
    pub rtc_tcp_port: u16,
    /// UDP: WebRTC media.
    pub rtc_udp_port: u16,
    /// LiveKit's own HTTP port, bound to 127.0.0.1 only.
    pub livekit_port: u16,
    /// Open the three public ports on the router via UPnP.
    pub upnp: bool,
    /// Public IP to advertise when the router can't tell us (no UPnP).
    pub external_ip: Option<IpAddr>,
    /// Let friends reach this server by its key alone, through a tunnel, even without a public address.
    #[serde(default = "yes")]
    pub p2p: bool,
}

fn yes() -> bool {
    true
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            name: "Мой сервер".into(),
            api_port: 7350,
            rtc_tcp_port: 7881,
            rtc_udp_port: 7882,
            livekit_port: 7880,
            upnp: true,
            external_ip: None,
            p2p: true,
        }
    }
}

impl HostConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("Название сервера не указано".into());
        }
        let ports = [
            ("API", self.api_port),
            ("WebRTC TCP", self.rtc_tcp_port),
            ("WebRTC UDP", self.rtc_udp_port),
            ("LiveKit", self.livekit_port),
        ];
        if let Some((name, _)) = ports.iter().find(|(_, port)| *port == 0) {
            return Err(format!("Порт {name} не указан"));
        }
        // UDP and TCP are separate namespaces, so only the TCP ports must differ.
        let tcp = [self.api_port, self.rtc_tcp_port, self.livekit_port];
        if tcp[0] == tcp[1] || tcp[0] == tcp[2] || tcp[1] == tcp[2] {
            return Err("TCP-порты API, WebRTC и LiveKit должны отличаться".into());
        }
        Ok(())
    }

    /// Reads the config, or writes and returns the default one when there is none yet.
    pub fn load_or_create(dir: &Path) -> Result<Self, String> {
        let path = dir.join(CONFIG_FILE);
        if !path.exists() {
            let config = Self::default();
            config.save(dir)?;
            return Ok(config);
        }
        let config: Self = read_json(&path)?;
        config.validate()?;
        Ok(config)
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        self.validate()?;
        write_json(&dir.join(CONFIG_FILE), self)
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Не читается {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("Испорчен {}: {e}", path.display()))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Не создаётся {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    // Write-then-rename, so a crash never leaves a half-written file behind.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Не записывается {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Не записывается {}: {e}", path.display()))
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("Нет источника случайности: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// LiveKit API credentials, generated once per server and never sent to clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Secrets {
    pub livekit_key: String,
    pub livekit_secret: String,
}

impl Secrets {
    pub fn generate() -> Result<Self, String> {
        Ok(Self {
            livekit_key: format!("hv{}", random_hex(8)?),
            livekit_secret: random_hex(32)?,
        })
    }

    pub fn load_or_create(dir: &Path) -> Result<Self, String> {
        let path = dir.join(SECRETS_FILE);
        if path.exists() {
            return read_json(&path);
        }
        let secrets = Self::generate()?;
        write_json(&path, &secrets)?;
        Ok(secrets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hv-host-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn default_config_is_valid_and_uses_the_documented_ports() {
        let cfg = HostConfig::default();
        assert_eq!((cfg.api_port, cfg.rtc_tcp_port, cfg.rtc_udp_port, cfg.livekit_port), (7350, 7881, 7882, 7880));
        assert!(cfg.upnp);
        assert_eq!(cfg.validate(), Ok(()));
    }

    #[test]
    fn rejects_zero_and_clashing_tcp_ports_and_empty_name() {
        let zero = HostConfig { api_port: 0, ..Default::default() };
        assert!(zero.validate().is_err());
        let clash = HostConfig { rtc_tcp_port: 7350, ..Default::default() };
        assert!(clash.validate().is_err());
        let clash_internal = HostConfig { livekit_port: 7881, ..Default::default() };
        assert!(clash_internal.validate().is_err());
        let empty = HostConfig { name: "  ".into(), ..Default::default() };
        assert!(empty.validate().is_err());
    }

    #[test]
    fn udp_port_may_share_a_number_with_a_tcp_port() {
        let cfg = HostConfig { rtc_udp_port: 7350, ..Default::default() };
        assert_eq!(cfg.validate(), Ok(()));
    }

    #[test]
    fn config_is_created_once_then_read_back() {
        let dir = temp_dir("config");
        let created = HostConfig::load_or_create(&dir).unwrap();
        assert_eq!(created, HostConfig::default());

        let changed = HostConfig { name: "Хата".into(), api_port: 9000, ..created };
        changed.save(&dir).unwrap();
        assert_eq!(HostConfig::load_or_create(&dir).unwrap(), changed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_config_is_not_saved() {
        let dir = temp_dir("invalid");
        let bad = HostConfig { api_port: 0, ..Default::default() };
        assert!(bad.save(&dir).is_err());
        assert!(!dir.join(CONFIG_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_are_random_long_and_stable_once_created() {
        let a = Secrets::generate().unwrap();
        let b = Secrets::generate().unwrap();
        assert_ne!(a.livekit_secret, b.livekit_secret);
        assert!(a.livekit_secret.len() >= 32, "LiveKit wants secrets of at least 32 chars");
        assert!(a.livekit_key.chars().all(|c| c.is_ascii_alphanumeric()));

        let dir = temp_dir("secrets");
        let first = Secrets::load_or_create(&dir).unwrap();
        assert_eq!(Secrets::load_or_create(&dir).unwrap(), first);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
