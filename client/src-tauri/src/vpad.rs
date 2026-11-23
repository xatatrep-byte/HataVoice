//! The virtual game pads friends play with on this PC: a Xbox 360 controller per friend, made by the ViGEmBus driver
//! (which the owner installs; the app never does). Behind [`VirtualPads`], so the rest is tested without the driver.

use crate::pads::PadState;

/// One plugged-in virtual pad.
pub type PadId = u32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlugError {
    /// ViGEmBus is not installed (or not running).
    NoDriver,
    /// No XInput place is free for one more pad.
    Full,
    Failed(String),
}

pub trait VirtualPads: Send + Sync {
    /// The driver is there to make pads.
    fn present(&self) -> bool;
    /// Plugs in a new pad: its id and the player it is (its XInput place + 1).
    fn plug(&self) -> Result<(PadId, u8), PlugError>;
    fn update(&self, pad: PadId, state: &PadState) -> Result<(), String>;
    /// Takes the pad out of the PC; nothing it held stays pressed.
    fn unplug(&self, pad: PadId);
}

/// The pads ViGEmBus makes. Its client is opened when first needed and again after a failure (the owner may install
/// the driver while the app runs).
#[cfg(windows)]
pub struct ViGEm {
    client: std::sync::Mutex<Option<std::sync::Arc<vigem_client::Client>>>,
    pads: std::sync::Mutex<std::collections::HashMap<PadId, vigem_client::Xbox360Wired<std::sync::Arc<vigem_client::Client>>>>,
    next: std::sync::atomic::AtomicU32,
}

#[cfg(windows)]
impl Default for ViGEm {
    fn default() -> Self {
        Self { client: Default::default(), pads: Default::default(), next: std::sync::atomic::AtomicU32::new(1) }
    }
}

#[cfg(windows)]
impl ViGEm {
    fn client(&self) -> Option<std::sync::Arc<vigem_client::Client>> {
        let mut client = self.client.lock().unwrap_or_else(|e| e.into_inner());
        if client.is_none() {
            *client = vigem_client::Client::connect().ok().map(std::sync::Arc::new);
        }
        client.clone()
    }
}

#[cfg(windows)]
impl VirtualPads for ViGEm {
    fn present(&self) -> bool {
        self.client().is_some()
    }

    fn plug(&self) -> Result<(PadId, u8), PlugError> {
        use vigem_client::{Error, TargetId, Xbox360Wired};
        let client = self.client().ok_or(PlugError::NoDriver)?;
        let mut target = Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
        target.plugin().map_err(|e| match e {
            Error::NoFreeSlot => PlugError::Full,
            other => {
                // The bus went away: open it again next time.
                *self.client.lock().unwrap_or_else(|e| e.into_inner()) = None;
                PlugError::Failed(format!("{other:?}"))
            }
        })?;
        target.wait_ready().map_err(|e| PlugError::Failed(format!("{e:?}")))?;
        // A new pad shows XInput leftovers on its sticks until it sends a report, and the driver passes on only a
        // report that differs from the last (all zeros at first): a nudge and back makes it start at rest.
        let nudge = vigem_client::XGamepad { thumb_ly: 1, ..Default::default() };
        let _ = target.update(&nudge);
        let _ = target.update(&vigem_client::XGamepad::default());
        // Windows gives the pad its XInput place a moment after it is ready; a fifth pad gets none.
        let mut index = Err(Error::NotPluggedIn);
        for _ in 0..50 {
            index = target.get_user_index();
            if index.is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let player = match index {
            Ok(i) if i < 4 => i as u8 + 1,
            // Dropping the target takes it out again.
            Ok(_) | Err(Error::UserIndexOutOfRange) => return Err(PlugError::Full),
            Err(e) => return Err(PlugError::Failed(format!("{e:?}"))),
        };
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.pads.lock().unwrap_or_else(|e| e.into_inner()).insert(id, target);
        Ok((id, player))
    }

    fn update(&self, pad: PadId, state: &PadState) -> Result<(), String> {
        let mut pads = self.pads.lock().unwrap_or_else(|e| e.into_inner());
        let target = pads.get_mut(&pad).ok_or("Нет такого геймпада")?;
        let gamepad = vigem_client::XGamepad {
            buttons: vigem_client::XButtons { raw: state.buttons },
            left_trigger: state.lt,
            right_trigger: state.rt,
            thumb_lx: state.lx,
            thumb_ly: state.ly,
            thumb_rx: state.rx,
            thumb_ry: state.ry,
        };
        target.update(&gamepad).map_err(|e| format!("{e:?}"))
    }

    fn unplug(&self, pad: PadId) {
        // Dropping the target unplugs it.
        self.pads.lock().unwrap_or_else(|e| e.into_inner()).remove(&pad);
    }
}

/// Where there is no ViGEmBus at all: no pads.
#[cfg(not(windows))]
#[derive(Default)]
pub struct ViGEm;

#[cfg(not(windows))]
impl VirtualPads for ViGEm {
    fn present(&self) -> bool {
        false
    }
    fn plug(&self) -> Result<(PadId, u8), PlugError> {
        Err(PlugError::NoDriver)
    }
    fn update(&self, _pad: PadId, _state: &PadState) -> Result<(), String> {
        Err("Нет драйвера".into())
    }
    fn unplug(&self, _pad: PadId) {}
}
