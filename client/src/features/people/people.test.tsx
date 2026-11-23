// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RoleDef } from "../../server/session";
import { channel, member, serverState } from "../../server/testState";
import { People } from "./People";

afterEach(cleanup);

const roles: RoleDef[] = [
  { id: "everyone", name: "@все", color: null, permissions: ["connect", "speak", "stream"] },
  { id: "moderator", name: "Модератор", color: "#3e9bff", permissions: ["mute_members"] },
  { id: "admin", name: "Админ", color: "#e5484d", permissions: [] },
];

const state = serverState({
  roles,
  channels: [channel("games", "Игры")],
  members: [
    member("own0", "Хозяин", { is_owner: true, rank: 4294967295 }),
    member("adm0", "Аня", { roles: ["admin", "moderator"], rank: 2 }),
    member("mod0", "Вася", { roles: ["moderator"], rank: 1, channel: "games" }),
    member("usr0", "Петя", { activity: "CS2" }),
    member("usr1", "Васька"),
  ],
});

describe("People", () => {
  it("the page of people groups them by top role and finds them by name", () => {
    const onPerson = vi.fn();
    render(<People state={state} onPerson={onPerson} />);
    const groups = screen.getAllByRole("group").map((g) => [
      within(g).getByRole("heading").textContent,
      within(g).getAllByRole("button").map((b) => b.querySelector(".person-name")?.textContent),
    ]);
    expect(groups).toEqual([
      ["Владелец 1", ["Хозяин"]],
      ["Админ 1", ["Аня"]],
      ["Модератор 1", ["Вася"]],
      ["Участники 2", ["Петя", "Васька"]],
    ]);
    expect(screen.getByText("в «Игры»")).toBeTruthy();
    expect(screen.getByText("играет в CS2")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Найти по нику"), { target: { value: "вас" } });
    expect(screen.queryByText("Аня")).toBeNull();
    expect(screen.getByText("Вася")).toBeTruthy();
    expect(screen.getByText("Васька")).toBeTruthy();

    fireEvent.click(screen.getByText("Васька"));
    expect(onPerson).toHaveBeenCalledWith("usr1");
  });
});
