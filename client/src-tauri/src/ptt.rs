//! Push-to-talk logic, independent of the OS hook that feeds it.

use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

/// A key (Windows virtual-key code) or a mouse button. Serialized as "key:86" / "mouse:x1".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InputCode {
    Key(u32),
    Mouse(MouseButton),
}

impl InputCode {
    pub fn parse(s: &str) -> Option<Self> {
        let (kind, value) = s.split_once(':')?;
        match kind {
            "key" => value.parse().ok().map(InputCode::Key),
            "mouse" => Some(InputCode::Mouse(match value {
                "left" => MouseButton::Left,
                "right" => MouseButton::Right,
                "middle" => MouseButton::Middle,
                "x1" => MouseButton::X1,
                "x2" => MouseButton::X2,
                _ => return None,
            })),
            _ => None,
        }
    }

    pub fn as_string(&self) -> String {
        match self {
            InputCode::Key(vk) => format!("key:{vk}"),
            InputCode::Mouse(button) => {
                let name = match button {
                    MouseButton::Left => "left",
                    MouseButton::Right => "right",
                    MouseButton::Middle => "middle",
                    MouseButton::X1 => "x1",
                    MouseButton::X2 => "x2",
                };
                format!("mouse:{name}")
            }
        }
    }
}

/// Parses a binding sent by the UI; any unknown code makes the whole binding invalid.
pub fn parse_binding(codes: &[String]) -> Result<Vec<InputCode>, String> {
    codes
        .iter()
        .map(|c| InputCode::parse(c).ok_or_else(|| format!("Неизвестная клавиша: {c}")))
        .collect()
}

/// Tracks held inputs and reports when the PTT combo becomes active or inactive.
#[derive(Debug, Default)]
pub struct PttMatcher {
    binding: HashSet<InputCode>,
    held: HashSet<InputCode>,
    active: bool,
}

impl PttMatcher {
    /// Replaces the binding; returns `Some(active)` if that changes the PTT state.
    pub fn set_binding(&mut self, binding: Vec<InputCode>) -> Option<bool> {
        self.binding = binding.into_iter().collect();
        self.update()
    }

    /// Feeds one input event; returns `Some(active)` when the PTT state changes.
    pub fn feed(&mut self, code: InputCode, down: bool) -> Option<bool> {
        if down {
            self.held.insert(code);
        } else {
            self.held.remove(&code);
        }
        self.update()
    }

    fn update(&mut self) -> Option<bool> {
        let active = !self.binding.is_empty() && self.binding.is_subset(&self.held);
        if active == self.active {
            return None;
        }
        self.active = active;
        Some(active)
    }
}

/// Records the next combo the user presses (everything held until all inputs are released).
/// Left and right mouse buttons are ignored so the click on "Назначить" doesn't get captured.
#[derive(Debug, Default)]
pub struct Capture {
    held: HashSet<InputCode>,
    pressed: Vec<InputCode>,
}

impl Capture {
    /// Returns the captured combo once every pressed input has been released.
    pub fn feed(&mut self, code: InputCode, down: bool) -> Option<Vec<InputCode>> {
        if matches!(code, InputCode::Mouse(MouseButton::Left | MouseButton::Right)) {
            return None;
        }
        if down {
            if self.held.insert(code) && !self.pressed.contains(&code) {
                self.pressed.push(code);
            }
            return None;
        }
        if !self.held.remove(&code) || !self.held.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.pressed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V: InputCode = InputCode::Key(86);
    const LCTRL: InputCode = InputCode::Key(162);
    const X1: InputCode = InputCode::Mouse(MouseButton::X1);

    #[test]
    fn codes_round_trip_through_strings() {
        for (text, code) in [
            ("key:86", V),
            ("mouse:x1", X1),
            ("mouse:x2", InputCode::Mouse(MouseButton::X2)),
            ("mouse:middle", InputCode::Mouse(MouseButton::Middle)),
        ] {
            assert_eq!(InputCode::parse(text), Some(code));
            assert_eq!(code.as_string(), text);
        }
        assert_eq!(InputCode::parse("key:abc"), None);
        assert_eq!(InputCode::parse("pedal:1"), None);
    }

    #[test]
    fn binding_with_an_unknown_code_is_rejected() {
        assert_eq!(parse_binding(&["key:162".into(), "mouse:x1".into()]), Ok(vec![LCTRL, X1]));
        assert!(parse_binding(&["key:162".into(), "nonsense".into()]).is_err());
    }

    #[test]
    fn single_key_activates_on_press_and_deactivates_on_release() {
        let mut m = PttMatcher::default();
        m.set_binding(vec![V]);
        assert_eq!(m.feed(V, true), Some(true));
        assert_eq!(m.feed(V, true), None, "auto-repeat must not re-trigger");
        assert_eq!(m.feed(V, false), Some(false));
    }

    #[test]
    fn combo_needs_all_inputs_and_any_release_deactivates() {
        let mut m = PttMatcher::default();
        m.set_binding(vec![LCTRL, X1]);
        assert_eq!(m.feed(LCTRL, true), None);
        assert_eq!(m.feed(X1, true), Some(true));
        assert_eq!(m.feed(LCTRL, false), Some(false));
        assert_eq!(m.feed(X1, false), None);
    }

    #[test]
    fn other_inputs_do_not_affect_ptt() {
        let mut m = PttMatcher::default();
        m.set_binding(vec![X1]);
        assert_eq!(m.feed(V, true), None);
        assert_eq!(m.feed(X1, true), Some(true));
        assert_eq!(m.feed(V, false), None);
    }

    #[test]
    fn empty_binding_never_activates_and_rebinding_releases() {
        let mut m = PttMatcher::default();
        assert_eq!(m.feed(V, true), None);
        m.feed(V, false);

        m.set_binding(vec![V]);
        m.feed(V, true);
        assert_eq!(m.set_binding(vec![]), Some(false), "clearing the binding while held must release PTT");
    }

    #[test]
    fn capture_returns_combo_after_everything_is_released() {
        let mut c = Capture::default();
        assert_eq!(c.feed(LCTRL, true), None);
        assert_eq!(c.feed(X1, true), None);
        assert_eq!(c.feed(LCTRL, true), None, "repeat is not a new input");
        assert_eq!(c.feed(X1, false), None);
        assert_eq!(c.feed(LCTRL, false), Some(vec![LCTRL, X1]));
    }

    #[test]
    fn capture_ignores_left_and_right_clicks_and_stray_releases() {
        let mut c = Capture::default();
        assert_eq!(c.feed(InputCode::Mouse(MouseButton::Left), true), None);
        assert_eq!(c.feed(InputCode::Mouse(MouseButton::Left), false), None);
        assert_eq!(c.feed(V, false), None, "release of a key pressed before capture started");
        assert_eq!(c.feed(X1, true), None);
        assert_eq!(c.feed(X1, false), Some(vec![X1]));
    }
}
