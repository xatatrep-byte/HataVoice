//! The `music` signal: what a friend plays for the call (music together), through the server's group like `watch` and
//! `act` (see `chat.rs`). Only shown, never acted on beyond stopping one's own music when another takes over.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The most characters of a title or an artist.
pub const MAX_TEXT: usize = 200;
/// The most characters of the program's name.
pub const MAX_APP: usize = 60;
/// The most bytes of a cover, a small JPEG as a data URL (the page shrinks it to 96×96).
pub const MAX_COVER: usize = 24 * 1024;
pub const COVER_PREFIX: &str = "data:image/jpeg;base64,";

/// What is played: on or stopped (`on: false`), a take-over (`take`: whoever plays now stops), and what it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MusicWord {
    pub on: bool,
    #[serde(default)]
    pub take: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub app: Option<String>,
    pub cover: Option<String>,
}

fn text_ok(text: &Option<String>, most: usize) -> bool {
    text.as_deref().is_none_or(|t| t.chars().count() <= most && !t.chars().any(char::is_control))
}

fn cover_ok(cover: &Option<String>) -> bool {
    cover.as_deref().is_none_or(|c| {
        c.len() <= MAX_COVER
            && c.strip_prefix(COVER_PREFIX).is_some_and(|data| data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='))
    })
}

impl MusicWord {
    /// Within the limits: sent and taken only so.
    pub fn valid(&self) -> bool {
        text_ok(&self.title, MAX_TEXT) && text_ok(&self.artist, MAX_TEXT) && text_ok(&self.app, MAX_APP) && cover_ok(&self.cover)
    }
}

/// The signal for voice channel `channel`.
pub fn body(channel: &str, word: &MusicWord) -> Value {
    json!({ "t": "music", "ch": channel, "on": word.on, "take": word.take, "title": word.title, "artist": word.artist, "app": word.app, "cover": word.cover })
}

/// The word of a `music` signal, when it is one within the limits.
pub fn read(signal: &Value) -> Option<MusicWord> {
    let text = |key: &str| match &signal[key] {
        Value::Null => Some(None),
        Value::String(s) => Some(Some(s.clone())),
        _ => None,
    };
    let take = match &signal["take"] {
        Value::Null => false,
        Value::Bool(take) => *take,
        _ => return None,
    };
    let word = MusicWord { on: signal["on"].as_bool()?, take, title: text("title")?, artist: text("artist")?, app: text("app")?, cover: text("cover")? };
    word.valid().then_some(word)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> MusicWord {
        MusicWord {
            on: true,
            take: false,
            title: Some("Ночной трамвай".into()),
            artist: Some("Город спит".into()),
            app: Some("Яндекс Музыка".into()),
            cover: Some(format!("{COVER_PREFIX}/9j/4AAQSkZJRg==")),
        }
    }

    #[test]
    fn a_full_word_goes_and_comes_back_whole() {
        let body = body("general", &full());
        assert_eq!(body["t"], "music");
        assert_eq!(body["ch"], "general");
        assert_eq!(read(&body), Some(full()));
        let stop = MusicWord { on: false, ..Default::default() };
        assert_eq!(read(&super::body("general", &stop)), Some(stop));
    }

    #[test]
    fn what_is_too_long_or_odd_is_dropped() {
        let long = |n: usize| "я".repeat(n);
        assert!(read(&body("g", &MusicWord { title: Some(long(MAX_TEXT)), ..full() })).is_some());
        assert_eq!(read(&body("g", &MusicWord { title: Some(long(MAX_TEXT + 1)), ..full() })), None, "title of 201");
        assert_eq!(read(&body("g", &MusicWord { artist: Some(long(MAX_TEXT + 1)), ..full() })), None, "artist of 201");
        assert_eq!(read(&body("g", &MusicWord { app: Some(long(MAX_APP + 1)), ..full() })), None, "app of 61");
        assert_eq!(read(&body("g", &MusicWord { title: Some("a\nb".into()), ..full() })), None, "control characters");
        let big = format!("{COVER_PREFIX}{}", "A".repeat(MAX_COVER));
        assert_eq!(read(&body("g", &MusicWord { cover: Some(big), ..full() })), None, "cover over 24 KB");
        assert_eq!(read(&body("g", &MusicWord { cover: Some("data:image/png;base64,AAAA".into()), ..full() })), None, "not a JPEG");
        assert_eq!(read(&body("g", &MusicWord { cover: Some(format!("{COVER_PREFIX}<script>")), ..full() })), None, "not base64");
        let mut odd = body("g", &full());
        odd["on"] = serde_json::json!("yes");
        assert_eq!(read(&odd), None, "a non-bool «on»");
        let mut untaken = body("g", &full());
        untaken.as_object_mut().unwrap().remove("take");
        assert_eq!(read(&untaken).map(|w| w.take), Some(false), "no «take»: not a take-over");
    }
}
