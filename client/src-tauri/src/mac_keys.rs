//! A Mac's keys in the words push-to-talk is written in: Windows virtual-key codes (`key:162` is the left Ctrl), so
//! one binding and its labels mean the same key on both systems. Pure data, so it is tested on any PC.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// The Windows virtual-key code of a Mac's virtual key code (`kVK_*` of Carbon's Events.h), if it has one. Command
/// takes the Windows key's place and Option the Alt's, as they sit on the keyboard.
pub fn vk_of(mac: u16) -> Option<u32> {
    Some(match mac {
        0x00 => 0x41, // A
        0x01 => 0x53, // S
        0x02 => 0x44, // D
        0x03 => 0x46, // F
        0x04 => 0x48, // H
        0x05 => 0x47, // G
        0x06 => 0x5A, // Z
        0x07 => 0x58, // X
        0x08 => 0x43, // C
        0x09 => 0x56, // V
        0x0A => 0xE2, // § (ISO), the key by the left Shift
        0x0B => 0x42, // B
        0x0C => 0x51, // Q
        0x0D => 0x57, // W
        0x0E => 0x45, // E
        0x0F => 0x52, // R
        0x10 => 0x59, // Y
        0x11 => 0x54, // T
        0x12 => 0x31, // 1
        0x13 => 0x32, // 2
        0x14 => 0x33, // 3
        0x15 => 0x34, // 4
        0x16 => 0x36, // 6
        0x17 => 0x35, // 5
        0x18 => 0xBB, // =
        0x19 => 0x39, // 9
        0x1A => 0x37, // 7
        0x1B => 0xBD, // -
        0x1C => 0x38, // 8
        0x1D => 0x30, // 0
        0x1E => 0xDD, // ]
        0x1F => 0x4F, // O
        0x20 => 0x55, // U
        0x21 => 0xDB, // [
        0x22 => 0x49, // I
        0x23 => 0x50, // P
        0x24 => 0x0D, // Return
        0x25 => 0x4C, // L
        0x26 => 0x4A, // J
        0x27 => 0xDE, // '
        0x28 => 0x4B, // K
        0x29 => 0xBA, // ;
        0x2A => 0xDC, // \
        0x2B => 0xBC, // ,
        0x2C => 0xBF, // /
        0x2D => 0x4E, // N
        0x2E => 0x4D, // M
        0x2F => 0xBE, // .
        0x30 => 0x09, // Tab
        0x31 => 0x20, // Space
        0x32 => 0xC0, // `
        0x33 => 0x08, // Delete (Backspace)
        0x35 => 0x1B, // Escape
        0x36 => 0x5C, // right Command
        0x37 => 0x5B, // left Command
        0x38 => 0xA0, // left Shift
        0x39 => 0x14, // Caps Lock
        0x3A => 0xA4, // left Option
        0x3B => 0xA2, // left Control
        0x3C => 0xA1, // right Shift
        0x3D => 0xA5, // right Option
        0x3E => 0xA3, // right Control
        0x40 => 0x80, // F17
        0x41 => 0x6E, // keypad .
        0x43 => 0x6A, // keypad *
        0x45 => 0x6B, // keypad +
        0x47 => 0x90, // keypad Clear, where Num Lock is
        0x48 => 0xAF, // volume up
        0x49 => 0xAE, // volume down
        0x4A => 0xAD, // mute
        0x4B => 0x6F, // keypad /
        0x4C => 0x0D, // keypad Enter
        0x4E => 0x6D, // keypad -
        0x4F => 0x81, // F18
        0x50 => 0x82, // F19
        0x52 => 0x60, // keypad 0
        0x53 => 0x61,
        0x54 => 0x62,
        0x55 => 0x63,
        0x56 => 0x64,
        0x57 => 0x65,
        0x58 => 0x66,
        0x59 => 0x67, // keypad 7
        0x5A => 0x83, // F20
        0x5B => 0x68, // keypad 8
        0x5C => 0x69, // keypad 9
        0x60 => 0x74, // F5
        0x61 => 0x75, // F6
        0x62 => 0x76, // F7
        0x63 => 0x72, // F3
        0x64 => 0x77, // F8
        0x65 => 0x78, // F9
        0x67 => 0x7A, // F11
        0x69 => 0x7C, // F13
        0x6A => 0x7F, // F16
        0x6B => 0x7D, // F14
        0x6D => 0x79, // F10
        0x6F => 0x7B, // F12
        0x71 => 0x7E, // F15
        0x72 => 0x2D, // Help, where Insert is
        0x73 => 0x24, // Home
        0x74 => 0x21, // Page Up
        0x75 => 0x2E, // forward Delete
        0x76 => 0x73, // F4
        0x77 => 0x23, // End
        0x78 => 0x71, // F2
        0x79 => 0x22, // Page Down
        0x7A => 0x70, // F1
        0x7B => 0x25, // left arrow
        0x7C => 0x27, // right arrow
        0x7D => 0x28, // down arrow
        0x7E => 0x26, // up arrow
        _ => return None,
    })
}

/// For a modifier key, the bit of the event's flags that says it is held: the device-dependent ones, which tell left
/// from right (`NX_DEVICE*KEYMASK`), and Caps Lock's own. A modifier comes as «flags changed», not as a key going down
/// or up, so this is how its state is read.
pub fn modifier_mask(mac: u16) -> Option<u64> {
    Some(match mac {
        0x3B => 0x0000_0001, // left Control
        0x38 => 0x0000_0002, // left Shift
        0x3C => 0x0000_0004, // right Shift
        0x37 => 0x0000_0008, // left Command
        0x36 => 0x0000_0010, // right Command
        0x3A => 0x0000_0020, // left Option
        0x3D => 0x0000_0040, // right Option
        0x3E => 0x0000_2000, // right Control
        0x39 => 0x0001_0000, // Caps Lock
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_keys_are_the_windows_keys_where_they_sit() {
        assert_eq!(vk_of(0x00), Some(0x41), "A");
        assert_eq!(vk_of(0x31), Some(0x20), "Space");
        assert_eq!(vk_of(0x3B), Some(162), "left Control is «Левый Ctrl», as on Windows");
        assert_eq!(vk_of(0x3E), Some(163));
        assert_eq!(vk_of(0x37), Some(0x5B), "Command is where the Windows key is");
        assert_eq!(vk_of(0x3A), Some(164), "Option is the left Alt");
        assert_eq!(vk_of(0x7A), Some(0x70), "F1");
        assert_eq!(vk_of(0x6F), Some(0x7B), "F12");
        assert_eq!(vk_of(0x3F), None, "fn has no Windows key");
    }

    #[test]
    fn letters_and_digits_all_land_on_their_own_code() {
        let mut seen = std::collections::HashSet::new();
        for mac in 0u16..0x80 {
            if let Some(vk) = vk_of(mac) {
                // Return and the keypad's Enter are one key for Windows.
                if mac != 0x4C {
                    assert!(seen.insert(vk), "two Mac keys on {vk:#x}");
                }
            }
        }
        for vk in (0x30..=0x39).chain(0x41..=0x5A) {
            assert!(seen.contains(&vk), "nothing types {vk:#x}");
        }
    }

    #[test]
    fn every_modifier_has_a_flag_and_a_key() {
        for mac in [0x38, 0x3C, 0x3B, 0x3E, 0x3A, 0x3D, 0x37, 0x36, 0x39] {
            assert!(modifier_mask(mac).is_some(), "{mac:#x}");
            assert!(vk_of(mac).is_some(), "{mac:#x}");
        }
        assert_eq!(modifier_mask(0x00), None);
    }
}
