//! Voice channels of a server. Everyone may read them; only the host PC may change them.

use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

pub const CHANNELS_FILE: &str = "channels.json";
pub const MAX_CHANNELS: usize = 50;
const MAX_ID_LEN: usize = 64;
const MAX_NAME_CHARS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Template {
    Friends,
    Work,
    Empty,
}

pub fn template(t: Template) -> Vec<Channel> {
    let pairs: &[(&str, &str)] = match t {
        Template::Friends => &[("general", "Общий"), ("games", "Игры"), ("media", "Кино и музыка"), ("away", "Отошёл")],
        Template::Work => &[("general", "Общий"), ("meeting", "Встреча"), ("quiet", "Тихая комната")],
        Template::Empty => &[("general", "Общий")],
    };
    pairs.iter().map(|(id, name)| Channel { id: id.to_string(), name: name.to_string() }).collect()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Checks a full channel list and returns it with trimmed names.
pub fn validate(list: &[Channel]) -> Result<Vec<Channel>, String> {
    if list.is_empty() {
        return Err("Нужен хотя бы один канал".into());
    }
    if list.len() > MAX_CHANNELS {
        return Err(format!("Каналов может быть не больше {MAX_CHANNELS}"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut checked = Vec::with_capacity(list.len());
    for channel in list {
        if !valid_id(&channel.id) {
            return Err(format!("Неверный идентификатор канала «{}»", channel.id));
        }
        if !seen.insert(channel.id.as_str()) {
            return Err(format!("Канал «{}» повторяется", channel.id));
        }
        let name = channel.name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(format!("Название канала: от 1 до {MAX_NAME_CHARS} символов"));
        }
        checked.push(Channel { id: channel.id.clone(), name: name.to_string() });
    }
    Ok(checked)
}

fn write_atomic(path: &std::path::Path, list: &[Channel]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Не создаётся {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Не записывается {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Не записывается {}: {e}", path.display()))
}

pub struct ChannelStore {
    path: Option<PathBuf>,
    list: RwLock<Vec<Channel>>,
}

impl ChannelStore {
    /// Loads the list from `path`, creating it from the "Friends" template if missing.
    /// `None` keeps the list in memory only (dev mode).
    pub fn open(path: Option<PathBuf>) -> Result<Self, String> {
        let list = match &path {
            Some(path) if path.exists() => {
                let text = std::fs::read_to_string(path)
                    .map_err(|e| format!("Не читается {}: {e}", path.display()))?;
                let list: Vec<Channel> = serde_json::from_str(&text)
                    .map_err(|e| format!("Испорчен {}: {e}", path.display()))?;
                validate(&list)?
            }
            Some(path) => {
                let list = template(Template::Friends);
                write_atomic(path, &list)?;
                list
            }
            None => template(Template::Friends),
        };
        Ok(Self { path, list: RwLock::new(list) })
    }

    pub fn list(&self) -> Vec<Channel> {
        self.list.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Validates and stores a new list; on any error the current list stays.
    pub fn replace(&self, list: Vec<Channel>) -> Result<Vec<Channel>, String> {
        let checked = validate(&list)?;
        let mut current = self.list.write().unwrap_or_else(|e| e.into_inner());
        if let Some(path) = &self.path {
            write_atomic(path, &checked)?;
        }
        *current = checked.clone();
        Ok(checked)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: &str, name: &str) -> Channel {
        Channel { id: id.into(), name: name.into() }
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hv-channels-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join(CHANNELS_FILE)
    }

    #[test]
    fn validate_accepts_templates_and_trims_names() {
        for t in [Template::Friends, Template::Work, Template::Empty] {
            assert_eq!(validate(&template(t)), Ok(template(t)));
        }
        assert_eq!(validate(&[ch("general", "  Общий  ")]), Ok(vec![ch("general", "Общий")]));
    }

    #[test]
    fn templates_match_the_spec() {
        let ids = |t| template(t).into_iter().map(|c| (c.id, c.name)).collect::<Vec<_>>();
        let pairs = |list: &[(&str, &str)]| list.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(
            ids(Template::Friends),
            pairs(&[("general", "Общий"), ("games", "Игры"), ("media", "Кино и музыка"), ("away", "Отошёл")])
        );
        assert_eq!(ids(Template::Work), pairs(&[("general", "Общий"), ("meeting", "Встреча"), ("quiet", "Тихая комната")]));
        assert_eq!(ids(Template::Empty), pairs(&[("general", "Общий")]));
    }

    #[test]
    fn validate_rejects_bad_lists() {
        assert!(validate(&[]).is_err(), "empty list");
        let many: Vec<Channel> = (0..51).map(|i| ch(&format!("c{i}"), "Канал")).collect();
        assert!(validate(&many).is_err(), "51 channels");
        assert!(validate(&[ch("a", "A"), ch("a", "B")]).is_err(), "duplicate id");
        for bad_id in ["Игры", "a b", "", &"x".repeat(65), "Games"] {
            assert!(validate(&[ch(bad_id, "Имя")]).is_err(), "bad id {bad_id:?}");
        }
        assert!(validate(&[ch("a", "   ")]).is_err(), "blank name");
        assert!(validate(&[ch("a", &"я".repeat(33))]).is_err(), "33-char name");
        assert!(validate(&[ch("a", &"я".repeat(32))]).is_ok(), "32-char name is fine");
    }

    #[test]
    fn store_creates_friends_template_and_persists_replacements() {
        let path = temp_file("store");
        let store = ChannelStore::open(Some(path.clone())).unwrap();
        assert_eq!(store.list(), template(Template::Friends));
        assert!(path.exists(), "the default list is written to disk");

        let saved = store.replace(template(Template::Work)).unwrap();
        assert_eq!(saved, template(Template::Work));
        assert_eq!(ChannelStore::open(Some(path.clone())).unwrap().list(), template(Template::Work));

        assert!(store.replace(vec![]).is_err());
        assert_eq!(store.list(), template(Template::Work), "a rejected replace changes nothing");

        let memory = ChannelStore::open(None).unwrap();
        assert_eq!(memory.list(), template(Template::Friends));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
