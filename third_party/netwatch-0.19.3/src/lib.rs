//! Networking related utilities

// HataVoice's copy: built from a path, so cargo shows the warnings it hides for crates from the registry.
#![allow(deprecated)]

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple_route;
pub mod interfaces;
pub mod ip;
mod ip_family;
pub mod netmon;
#[cfg(not(wasm_browser))]
mod udp;

pub use self::ip_family::IpFamily;
#[cfg(not(wasm_browser))]
pub use self::udp::{UdpSender, UdpSocket};
