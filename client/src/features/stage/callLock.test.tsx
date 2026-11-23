// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { member } from "../../server/testState";
import { ENCRYPTION_FAILED, NO_CALL, type CallSecurity } from "../../voice/callSecurity";
import { CallLock, tunnelWords } from "./CallLock";

afterEach(cleanup);

const CODE = "12345 67890 00042 99999 01234 55555";
const secure: CallSecurity = { state: "secure", code: CODE, members: ["a000", "me00"], error: null };
const pending: CallSecurity = { ...NO_CALL, state: "pending" };
const failed: CallSecurity = { ...NO_CALL, state: "failed", error: `${ENCRYPTION_FAILED}: ключи не пришли` };

const lock = (security: CallSecurity, over: Partial<Parameters<typeof CallLock>[0]> = {}) =>
  render(<CallLock security={security} members={[]} onRetry={() => {}} {...over} />);

const openLock = (name = "Звонок зашифрован") => {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
};

describe("tunnelWords", () => {
  it("says which way the connection goes, and nothing without a tunnel", () => {
    expect(tunnelWords(null)).toBeNull();
    expect(tunnelWords({ connected: false, direct: false, rtt_ms: null })).toBe("Маршрут: ищем путь до сервера");
    expect(tunnelWords({ connected: true, direct: true, rtt_ms: 12 })).toBe("Маршрут: напрямую, задержка 12 мс");
    expect(tunnelWords({ connected: true, direct: false, rtt_ms: null })).toBe("Маршрут: через ретранслятор");
  });
});

describe("CallLock", () => {
  it("shows each lock state with its words", () => {
    const states: [CallSecurity, string][] = [
      [secure, "Звонок зашифрован"],
      [pending, "Устанавливаю шифрование…"],
      [failed, "Не удалось зашифровать"],
    ];
    for (const [security, words] of states) {
      const { unmount } = lock(security);
      const button = screen.getByRole("button", { name: words });
      // The tone is the state: green, yellow, red.
      expect(button.className).toContain(`lock-${security.state}`);
      unmount();
    }
  });

  it("is not there outside a call", () => {
    const { container } = lock(NO_CALL);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the popover closed until the lock is pressed", () => {
    lock(secure);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Звонок зашифрован" }).getAttribute("aria-expanded")).toBe("false");
    openLock();
    expect(screen.getByRole("button", { name: "Звонок зашифрован" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the call code in six groups", () => {
    lock(secure);
    const dialog = openLock();
    const groups = within(dialog).getAllByText(/^\d{5}$/);
    expect(groups.map((g) => g.textContent)).toEqual(CODE.split(" "));
    expect(within(dialog).getByText("Сверьте вслух пару групп цифр. Совпали значит, посередине никого нет")).toBeTruthy();
    expect(within(dialog).getByText("Соединение с сервером: TLS 1.3, постквантовый обмен ключами")).toBeTruthy();
  });

  it("shows no code until the call has one", () => {
    lock(pending);
    const dialog = openLock("Устанавливаю шифрование…");
    expect(within(dialog).queryAllByText(/^\d{5}$/)).toHaveLength(0);
    // The line about the server connection is true whatever the call is doing.
    expect(within(dialog).getByText("Соединение с сервером: TLS 1.3, постквантовый обмен ключами")).toBeTruthy();
  });

  it("lists who is in the encrypted group", () => {
    const members = [
      member("a000", "Аня"),
      member("k7q3x", "Петя", { fingerprint: "k7q3" }),
      member("c000", "Вася", { name_clash: true, fingerprint: "c000" }),
      member("o000", "Оля"),
    ];
    // «zzzz9» is not in the journal: only its fingerprint can be shown. «o000» is not in the group.
    lock({ ...secure, members: ["a000", "k7q3x", "c000", "zzzz9"] }, { members });
    const dialog = openLock();
    const list = within(dialog).getByRole("list", { name: "В зашифрованной группе" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Аня · a000", "Петя · k7q3", "Вася · c000", "zzzz"]);
    expect(within(dialog).queryByText("Оля")).toBeNull();
  });

  it("offers a retry when encryption failed", () => {
    const onRetry = vi.fn();
    lock(failed, { onRetry });
    const dialog = openLock("Не удалось зашифровать");
    expect(within(dialog).getByText(`${ENCRYPTION_FAILED}: ключи не пришли`)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Повторить" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says the generic failure when the engine gave no reason", () => {
    lock({ ...failed, error: null });
    const dialog = openLock("Не удалось зашифровать");
    expect(within(dialog).getByText(ENCRYPTION_FAILED)).toBeTruthy();
  });

  it("offers no retry while the call is fine or still keying", () => {
    for (const security of [secure, pending]) {
      const { unmount } = lock(security);
      const dialog = openLock(security.state === "secure" ? "Звонок зашифрован" : "Устанавливаю шифрование…");
      expect(within(dialog).queryByRole("button", { name: "Повторить" })).toBeNull();
      unmount();
    }
  });

  it("closes on Escape and on a click outside, not on a click inside", () => {
    render(
      <>
        <CallLock security={secure} members={[]} onRetry={() => {}} />
        <p>вне замка</p>
      </>,
    );
    const dialog = openLock();
    fireEvent.mouseDown(dialog);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.mouseDown(screen.getByText("вне замка"));
    expect(screen.queryByRole("dialog")).toBeNull();
    openLock();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
