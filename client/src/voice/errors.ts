import { IS_ANDROID } from "../platform/android";
/**
 * The mic opened but its sound processing (noise suppression, the voice changer, the gate) did not start. Not a busy
 * mic: trying again opens the same mic into the same failure.
 */
export class SoundError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SoundError";
  }
}

/** Turns a getUserMedia / track error into a sentence a person can act on. */
export function micErrorMessage(e: unknown): string {
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  switch (name) {
    case "SoundError":
      return `Обработка звука не запустилась: ${(e as Error).message}`;
    case "NotAllowedError":
    case "SecurityError":
      return IS_ANDROID
        ? "Нет доступа к микрофону. Разреши его ХатаВойсу: настройки телефона → Приложения → ХатаВойс → Разрешения"
        : "Нет доступа к микрофону. Разреши его в настройках Windows";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Микрофон не найден. Подключи его и выбери в настройках";
    case "NotReadableError":
    case "AbortError":
      return "Микрофон не открывается. Возможно, его заняла другая программа";
  }
  const text = e instanceof Error ? e.message : String(e);
  return `Микрофон не работает: ${text}`;
}

/** In a call: the mic did not open and is tried again on its own. */
export const MIC_RETRYING = "Микрофон пока не открылся. Пробую ещё раз…";

/** In a call: still not open after a few tries, which goes on. */
export const MIC_STILL_BUSY =
  "Микрофон всё ещё занят. Закрой программу, которая его держит (DAW, запись звука), или выбери другой микрофон в настройках — я продолжаю пробовать";

export function isMicRetryMessage(text: string | null): boolean {
  return text === MIC_RETRYING || text === MIC_STILL_BUSY;
}
