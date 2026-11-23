//! «Проверить на VirusTotal»: a file of the chat looked up by its fingerprint (SHA-256), with the person's own free key
//! of the site, and the answer shown in the program (how many antivirus engines call it dangerous). Without a key only
//! the fingerprint goes, to the site in the browser. A file the site has never seen is sent to it only when the person
//! asks for that file, having been told it becomes the site's and its partners'. Nothing of the chat ever goes.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::chat::Chats;

const API: &str = "https://www.virustotal.com/api/v3";
const KEY_FILE: &str = "virustotal.key";
/// What the site takes in one request; a bigger file goes to an upload address it gives.
const DIRECT_UPLOAD: usize = 32 * 1024 * 1024;
/// The most this program sends to the site (the file is opened in memory for it).
pub const MAX_UPLOAD: u64 = 200 * 1024 * 1024;

/// An engine that called the file dangerous or doubtful, and what it called it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Flag {
    pub engine: String,
    pub result: String,
    pub malicious: bool,
}

/// What the site says of a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Report {
    /// No key yet: the fingerprint alone, for the site in the browser.
    NoKey { sha256: String },
    /// The site has never seen it.
    Unknown { sha256: String },
    Known {
        sha256: String,
        malicious: u32,
        suspicious: u32,
        /// All the engines that gave a verdict.
        engines: u32,
        flagged: Vec<Flag>,
        /// When the site last looked at it (unix seconds).
        analysed_at: Option<u64>,
    },
}

/// The site's answer for `/files/{sha256}`, read; `None` when it is not one.
pub fn report_from(sha256: &str, body: &Value) -> Option<Report> {
    let attributes = &body["data"]["attributes"];
    let stats = attributes["last_analysis_stats"].as_object()?;
    let count = |name: &str| stats.get(name).and_then(Value::as_u64).unwrap_or(0) as u32;
    let (malicious, suspicious) = (count("malicious"), count("suspicious"));
    let engines = malicious + suspicious + count("undetected") + count("harmless");
    let mut flagged: Vec<Flag> = attributes["last_analysis_results"]
        .as_object()
        .map(|results| {
            results
                .iter()
                .filter_map(|(engine, result)| {
                    let category = result["category"].as_str()?;
                    if category != "malicious" && category != "suspicious" {
                        return None;
                    }
                    let said = result["result"].as_str().unwrap_or(category).chars().take(120).collect();
                    let engine = result["engine_name"].as_str().unwrap_or(engine).chars().take(60).collect();
                    Some(Flag { engine, result: said, malicious: category == "malicious" })
                })
                .collect()
        })
        .unwrap_or_default();
    flagged.sort_by(|a, b| b.malicious.cmp(&a.malicious).then_with(|| a.engine.cmp(&b.engine)));
    Some(Report::Known { sha256: sha256.to_string(), malicious, suspicious, engines, flagged, analysed_at: attributes["last_analysis_date"].as_u64() })
}

/// Whether the site's answer for `/analyses/{id}` says it is done looking.
pub fn analysis_done(body: &Value) -> bool {
    body["data"]["attributes"]["status"].as_str() == Some("completed")
}

/// A key as the site gives them: 64 hex characters.
pub fn is_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A request body of one file, `multipart/form-data` with `boundary`. The name goes plain: the site sees the file anyway.
pub fn form_body(boundary: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
    let name: String = name.chars().map(|c| if c == '"' || c == '\r' || c == '\n' || c == '\\' { '_' } else { c }).collect();
    let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(600)).user_agent("HataVoice").build().map_err(|e| e.to_string())
}

fn key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join(KEY_FILE))
}

fn key_of(app: &tauri::AppHandle) -> Option<String> {
    let key = std::fs::read_to_string(key_path(app).ok()?).ok()?;
    let key = key.trim().to_string();
    is_key(&key).then_some(key)
}

/// The site's refusal, in words.
fn refusal(status: u16, body: &Value) -> String {
    match status {
        401 | 403 => "VirusTotal не принял ключ — проверь его в настройках проверки".into(),
        429 => "Ключ VirusTotal исчерпал проверки (бесплатно — 4 в минуту и 500 в день). Подожди немного".into(),
        _ => match body["error"]["message"].as_str() {
            Some(message) => format!("VirusTotal ответил {status}: {message}"),
            None => format!("VirusTotal ответил {status}"),
        },
    }
}

fn offline(error: reqwest::Error) -> String {
    format!("Нет связи с VirusTotal: {error}")
}

/// Whether a key of the site is kept here.
#[tauri::command]
pub fn vt_has_key(app: tauri::AppHandle) -> bool {
    key_of(&app).is_some()
}

/// Keeps the person's key of the site (on this PC only), or forgets it (`None`).
#[tauri::command]
pub fn vt_set_key(app: tauri::AppHandle, key: Option<String>) -> Result<(), String> {
    let path = key_path(&app)?;
    match key.map(|k| k.trim().to_string()) {
        None => {
            let _ = std::fs::remove_file(path);
            Ok(())
        }
        Some(key) if is_key(&key) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(path, key).map_err(|e| format!("Ключ не сохранился: {e}"))
        }
        Some(_) => Err("Это не ключ VirusTotal: в нём 64 знака, цифры и буквы a–f".into()),
    }
}

/// What the site says of a file of the chat, by its fingerprint.
#[tauri::command]
pub async fn vt_check(app: tauri::AppHandle, chats: tauri::State<'_, Chats>, address: String, blob: String) -> Result<Report, String> {
    let sha256 = chats.file_fingerprint(&address, &blob).await?;
    let Some(key) = key_of(&app) else {
        return Ok(Report::NoKey { sha256 });
    };
    let response = http()?.get(format!("{API}/files/{sha256}")).header("x-apikey", key).send().await.map_err(offline)?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    match status {
        200 => report_from(&sha256, &body).ok_or_else(|| "VirusTotal ответил непонятно".into()),
        404 => Ok(Report::Unknown { sha256 }),
        _ => Err(refusal(status, &body)),
    }
}

/// Sends a file of the chat to the site to be looked at (the person asked for it, told it becomes the site's): the
/// id of the look, to ask after with `vt_analysis`.
#[tauri::command]
pub async fn vt_upload(app: tauri::AppHandle, chats: tauri::State<'_, Chats>, address: String, blob: String, name: String) -> Result<String, String> {
    let key = key_of(&app).ok_or("Сначала добавь ключ VirusTotal")?;
    let bytes = chats.file_whole(&address, &blob, MAX_UPLOAD).await?;
    let http = http()?;
    let url = if bytes.len() <= DIRECT_UPLOAD {
        format!("{API}/files")
    } else {
        let response = http.get(format!("{API}/files/upload_url")).header("x-apikey", &key).send().await.map_err(offline)?;
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status != 200 {
            return Err(refusal(status, &body));
        }
        let url = body["data"].as_str().ok_or("VirusTotal не дал адреса для большого файла")?;
        if !url.starts_with("https://www.virustotal.com/") {
            return Err("VirusTotal дал странный адрес для большого файла".into());
        }
        url.to_string()
    };
    let boundary = format!("hatavoice{}", hv_roster::keys::random_bytes::<8>()?.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let response = http
        .post(url)
        .header("x-apikey", &key)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(form_body(&boundary, &name, &bytes))
        .send()
        .await
        .map_err(offline)?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status != 200 {
        return Err(refusal(status, &body));
    }
    body["data"]["id"].as_str().map(str::to_string).ok_or_else(|| "VirusTotal не сказал, как следить за проверкой".into())
}

/// Whether the site is done looking at a file sent to it.
#[tauri::command]
pub async fn vt_analysis(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let key = key_of(&app).ok_or("Сначала добавь ключ VirusTotal")?;
    if id.is_empty() || id.len() > 200 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'=' || b == b'-' || b == b'_') {
        return Err("Странный номер проверки".into());
    }
    let response = http()?.get(format!("{API}/analyses/{id}")).header("x-apikey", key).send().await.map_err(offline)?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status != 200 {
        return Err(refusal(status, &body));
    }
    Ok(analysis_done(&body))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_known_file_says_how_many_engines_call_it_what() {
        let body = json!({ "data": { "attributes": {
            "last_analysis_date": 1_800_000_000u64,
            "last_analysis_stats": { "malicious": 2, "suspicious": 1, "undetected": 60, "harmless": 7, "timeout": 3, "type-unsupported": 4 },
            "last_analysis_results": {
                "Kaspersky": { "category": "malicious", "engine_name": "Kaspersky", "result": "Trojan.Win32.Agent" },
                "Avast": { "category": "suspicious", "engine_name": "Avast", "result": null },
                "ESET-NOD32": { "category": "malicious", "engine_name": "ESET-NOD32", "result": "Win32/Agent" },
                "DrWeb": { "category": "undetected", "engine_name": "DrWeb", "result": null }
            }
        } } });
        let report = report_from("ab", &body).unwrap();
        let Report::Known { malicious, suspicious, engines, flagged, analysed_at, .. } = report else { panic!("{report:?}") };
        assert_eq!((malicious, suspicious, engines, analysed_at), (2, 1, 70, Some(1_800_000_000)));
        let names: Vec<_> = flagged.iter().map(|f| (f.engine.as_str(), f.result.as_str(), f.malicious)).collect();
        assert_eq!(names, [("ESET-NOD32", "Win32/Agent", true), ("Kaspersky", "Trojan.Win32.Agent", true), ("Avast", "suspicious", false)]);
        assert_eq!(report_from("ab", &json!({ "error": {} })), None);
    }

    #[test]
    fn a_look_is_done_when_the_site_says_completed() {
        assert!(analysis_done(&json!({ "data": { "attributes": { "status": "completed" } } })));
        assert!(!analysis_done(&json!({ "data": { "attributes": { "status": "queued" } } })));
        assert!(!analysis_done(&json!(null)));
    }

    #[test]
    fn a_key_is_64_hex_characters() {
        assert!(is_key(&"a1".repeat(32)));
        assert!(!is_key(&"a1".repeat(31)));
        assert!(!is_key(&"zz".repeat(32)));
    }

    #[test]
    fn the_file_goes_as_one_field_whose_name_can_not_break_the_form() {
        let body = form_body("XYZ", "evil\"\r\nname.exe", b"MZ\x90\0");
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"evil___name.exe\"\r\n"), "{text}");
        assert!(body.windows(4).any(|w| w == b"MZ\x90\0"));
        assert!(text.ends_with("\r\n--XYZ--\r\n"));
    }
}
