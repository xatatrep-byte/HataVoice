import { IS_MAC } from "../platform";

// Windows virtual-key codes, as reported by the Rust low-level keyboard hook.
const NAMED_KEYS: Record<number, string> = {
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  16: "Shift",
  17: "Ctrl",
  18: "Alt",
  19: "Pause",
  20: "Caps Lock",
  27: "Esc",
  32: "Пробел",
  33: "Page Up",
  34: "Page Down",
  35: "End",
  36: "Home",
  37: "←",
  38: "↑",
  39: "→",
  40: "↓",
  45: "Insert",
  46: "Delete",
  160: "Левый Shift",
  161: "Правый Shift",
  162: "Левый Ctrl",
  163: "Правый Ctrl",
  164: "Левый Alt",
  165: "Правый Alt",
  186: ";",
  187: "=",
  188: ",",
  189: "-",
  190: ".",
  191: "/",
  192: "`",
  219: "[",
  220: "\\",
  221: "]",
  222: "'",
};

/**
 * A Mac's own names: its hook (ptt_hook_mac.rs) puts Command where the Windows key is and Option where Alt is, so the
 * same codes read as the keys printed on a Mac keyboard.
 */
const MAC_KEYS: Record<number, string> = {
  13: "Return",
  18: "⌥ Option",
  91: "Левый ⌘",
  92: "Правый ⌘",
  164: "Левый ⌥",
  165: "Правый ⌥",
  162: "Левый Control",
  163: "Правый Control",
};

const MOUSE: Record<string, string> = {
  middle: "Колесо мыши",
  x1: "Мышь 4",
  x2: "Мышь 5",
};

function keyName(vk: number, mac: boolean): string {
  if (mac && MAC_KEYS[vk]) return MAC_KEYS[vk];
  if (NAMED_KEYS[vk]) return NAMED_KEYS[vk];
  if (vk === 91 || vk === 92) return vk === 91 ? "Левый Win" : "Правый Win";
  if ((vk >= 48 && vk <= 57) || (vk >= 65 && vk <= 90)) return String.fromCharCode(vk);
  if (vk >= 96 && vk <= 105) return `Num ${vk - 96}`;
  if (vk >= 112 && vk <= 135) return `F${vk - 111}`;
  return `Клавиша ${vk}`;
}

function codeLabel(code: string, mac: boolean): string {
  const [kind, value] = code.split(":");
  if (kind === "key" && value !== undefined && /^\d+$/.test(value)) return keyName(Number(value), mac);
  if (kind === "mouse" && value !== undefined && MOUSE[value]) return MOUSE[value];
  return code;
}

/** A binding in words, with a Mac's key names on a Mac. */
export function bindingLabel(binding: string[], mac = IS_MAC): string {
  if (binding.length === 0) return "Не назначена";
  return binding.map((code) => codeLabel(code, mac)).join(" + ");
}
