import { useEffect, useRef, useState } from "react";
import type { RemoteInput } from "../../remote/api";
import { MODIFIERS, pressCombo, type ModifierCode, type ModifierLatch } from "../../remote/modifiers";
import { typeText } from "../../remote/touch";

type Props = {
  send: (input: RemoteInput, lossy: boolean) => void;
  /** Ctrl, Alt, Shift and Win held from the bar, for the next key or click (see `ModifierLatch`). */
  latch?: ModifierLatch;
  /** The one controlled is a phone: what is typed goes as the letters. */
  phone?: boolean;
};

/** Keys a phone's keyboard has not got, for a friend's PC. */
const NAVIGATION: { code: string; label: string }[] = [
  { code: "ArrowLeft", label: "←" },
  { code: "ArrowUp", label: "↑" },
  { code: "ArrowDown", label: "↓" },
  { code: "ArrowRight", label: "→" },
  { code: "Backspace", label: "⌫" },
  { code: "Delete", label: "Del" },
  { code: "Enter", label: "Enter" },
];
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => ({ code: `F${i + 1}`, label: `F${i + 1}` }));
/** What one does with a PC every minute, at one tap. */
const COMBOS: { label: string; modifiers: ModifierCode[]; code: string }[] = [
  { label: "Ctrl+C", modifiers: ["ControlLeft"], code: "KeyC" },
  { label: "Ctrl+V", modifiers: ["ControlLeft"], code: "KeyV" },
  { label: "Ctrl+Z", modifiers: ["ControlLeft"], code: "KeyZ" },
  { label: "Alt+Tab", modifiers: ["AltLeft"], code: "Tab" },
];

/** A key of the bar takes no focus: the phone's keyboard stays up while one presses Ctrl or an arrow. */
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

/**
 * Typing on a friend's PC from a phone: a field that brings up the phone's keyboard, every letter typed in it pressed
 * as the PC's key (by its place, so letters follow the layout switched on that PC), and the keys a phone lacks.
 *
 * A phone's keyboard composes words (suggestions, swipe typing): a word goes over when the keyboard commits it, letters
 * typed one by one at once. Erasing in the empty field is the PC's Backspace.
 */
export function RemoteKeys({ send, latch, phone = false }: Props) {
  const field = useRef<HTMLInputElement>(null);
  const [fkeys, setFkeys] = useState(false);
  const sendRef = useRef(send);
  sendRef.current = send;
  const latchRef = useRef(latch);
  latchRef.current = latch;
  const phoneRef = useRef(phone);
  phoneRef.current = phone;

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    let composing = false;
    const press = (code: string) => {
      sendRef.current({ t: "key", code, down: true }, false);
      sendRef.current({ t: "key", code, down: false }, false);
      latchRef.current?.after();
    };
    const flush = () => {
      const text = el.value;
      el.value = "";
      if (!text) return;
      if (phoneRef.current) sendRef.current({ t: "text", s: text.slice(0, 64) }, false);
      else for (const input of typeText(text)) sendRef.current(input, false);
      latchRef.current?.after();
    };
    const onBefore = (e: InputEvent) => {
      if (e.inputType === "deleteContentBackward" && el.value === "") {
        e.preventDefault();
        press("Backspace");
      } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
        e.preventDefault();
        flush();
        press("Enter");
      }
    };
    const onInput = () => {
      if (!composing) flush();
    };
    const onStart = () => {
      composing = true;
    };
    const onEnd = () => {
      composing = false;
      flush();
    };
    // A real keyboard (Bluetooth, or a phone's that sends real keys): Enter and Backspace as they are.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        flush();
        press("Enter");
      } else if (e.key === "Backspace" && el.value === "") {
        e.preventDefault();
        press("Backspace");
      }
    };
    el.addEventListener("beforeinput", onBefore);
    el.addEventListener("input", onInput);
    el.addEventListener("compositionstart", onStart);
    el.addEventListener("compositionend", onEnd);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("beforeinput", onBefore);
      el.removeEventListener("input", onInput);
      el.removeEventListener("compositionstart", onStart);
      el.removeEventListener("compositionend", onEnd);
      el.removeEventListener("keydown", onKey);
    };
  }, []);

  const press = (code: string) => {
    send({ t: "key", code, down: true }, false);
    send({ t: "key", code, down: false }, false);
    latch?.after();
  };
  const key = (code: string, label: string, wide = false) => (
    <button key={code} type="button" className={wide ? "friend-key wide" : "friend-key"} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => press(code)}>
      {label}
    </button>
  );
  return (
    <div className="friend-keys" role="group" aria-label="Клавиатура ПК друга">
      <input
        ref={field}
        className="friend-keys-field"
        aria-label="Печатать на ПК друга"
        placeholder="Печатай здесь — буквы уходят на ПК"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
      />
      <div className="friend-keys-row">
        {latch &&
          MODIFIERS.map((m) => {
            const state = latch.state[m.code];
            return (
              <button
                key={m.code}
                type="button"
                className={`friend-key modifier ${state}`}
                aria-pressed={state !== "off"}
                title={state === "locked" ? `${m.label} зажат, нажми ещё раз — отпустить` : `${m.label}: для следующей клавиши или клика; два раза — держать`}
                onPointerDown={keepFocus}
                onMouseDown={keepFocus}
                onClick={() => latch.tap(m.code, performance.now())}
              >
                {m.label}
              </button>
            );
          })}
        {key("Escape", "Esc")}
        {key("Tab", "Tab")}
      </div>
      <div className="friend-keys-row">{fkeys ? FUNCTION_KEYS.map((k) => key(k.code, k.label)) : NAVIGATION.map((k) => key(k.code, k.label, k.code === "Enter"))}</div>
      <div className="friend-keys-row">
        {COMBOS.map((c) => (
          <button
            key={c.label}
            type="button"
            className="friend-key"
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={() => {
              pressCombo(send, c.modifiers, c.code);
              latch?.after();
            }}
          >
            {c.label}
          </button>
        ))}
        <button type="button" className={fkeys ? "friend-key on" : "friend-key"} aria-pressed={fkeys} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => setFkeys((on) => !on)}>
          F1–F12
        </button>
      </div>
    </div>
  );
}
