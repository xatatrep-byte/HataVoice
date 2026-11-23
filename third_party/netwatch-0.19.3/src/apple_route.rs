//! <net/route.h> of Apple's systems. libc declares it for macOS only, since the iOS SDK leaves the header out, but an
//! iPhone's kernel has the same routing messages: HataVoice's copy of netwatch takes these names from here so that it
//! builds for iOS (see third_party/README.md). The values are libc's own for macOS.

#[cfg(target_os = "macos")]
pub(crate) use libc::{RTA_IFP, RTAX_DST, RTAX_GATEWAY, RTAX_NETMASK, RTAX_IFP, RTAX_BRD, RTAX_MAX, RTF_GATEWAY, RTF_IFSCOPE, RTM_VERSION, RTM_ADD, RTM_DELETE, RTM_CHANGE, RTM_GET, RTM_LOSING, RTM_REDIRECT, RTM_MISS, RTM_LOCK, RTM_RESOLVE, RTM_NEWADDR, RTM_DELADDR, RTM_IFINFO, RTM_NEWMADDR, RTM_DELMADDR, RTM_IFINFO2, RTM_NEWMADDR2, RTM_GET2};

#[cfg(not(target_os = "macos"))]
mod values {
    use libc::c_int;

    pub(crate) const RTA_IFP: c_int = 0x10;
    pub(crate) const RTAX_DST: c_int = 0;
    pub(crate) const RTAX_GATEWAY: c_int = 1;
    pub(crate) const RTAX_NETMASK: c_int = 2;
    pub(crate) const RTAX_IFP: c_int = 4;
    pub(crate) const RTAX_BRD: c_int = 7;
    pub(crate) const RTAX_MAX: c_int = 8;
    pub(crate) const RTF_GATEWAY: c_int = 0x2;
    pub(crate) const RTF_IFSCOPE: c_int = 0x1000000;
    pub(crate) const RTM_VERSION: c_int = 5;
    pub(crate) const RTM_ADD: c_int = 0x1;
    pub(crate) const RTM_DELETE: c_int = 0x2;
    pub(crate) const RTM_CHANGE: c_int = 0x3;
    pub(crate) const RTM_GET: c_int = 0x4;
    pub(crate) const RTM_LOSING: c_int = 0x5;
    pub(crate) const RTM_REDIRECT: c_int = 0x6;
    pub(crate) const RTM_MISS: c_int = 0x7;
    pub(crate) const RTM_LOCK: c_int = 0x8;
    pub(crate) const RTM_RESOLVE: c_int = 0xb;
    pub(crate) const RTM_NEWADDR: c_int = 0xc;
    pub(crate) const RTM_DELADDR: c_int = 0xd;
    pub(crate) const RTM_IFINFO: c_int = 0xe;
    pub(crate) const RTM_NEWMADDR: c_int = 0xf;
    pub(crate) const RTM_DELMADDR: c_int = 0x10;
    pub(crate) const RTM_IFINFO2: c_int = 0x12;
    pub(crate) const RTM_NEWMADDR2: c_int = 0x13;
    pub(crate) const RTM_GET2: c_int = 0x14;
}

#[cfg(not(target_os = "macos"))]
pub(crate) use values::*;
