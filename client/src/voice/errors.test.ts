import { describe, expect, it } from "vitest";
import { micErrorMessage } from "./errors";

const domError = (name: string) => Object.assign(new Error("x"), { name });

describe("micErrorMessage", () => {
  it("explains the common microphone failures in plain words", () => {
    expect(micErrorMessage(domError("NotAllowedError"))).toBe(
      "Нет доступа к микрофону. Разреши его в настройках Windows",
    );
    expect(micErrorMessage(domError("NotFoundError"))).toBe("Микрофон не найден. Подключи его и выбери в настройках");
    expect(micErrorMessage(domError("NotReadableError"))).toBe(
      "Микрофон не открывается. Возможно, его заняла другая программа",
    );
  });

  it("falls back to the raw text for anything else", () => {
    expect(micErrorMessage(new Error("устройство сломалось"))).toBe("Микрофон не работает: устройство сломалось");
    expect(micErrorMessage("строка")).toBe("Микрофон не работает: строка");
  });
});
