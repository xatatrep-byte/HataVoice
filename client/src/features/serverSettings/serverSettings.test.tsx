// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string, protocol = "asset") => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import type { MeView, RoleDef, ServerStateView } from "../../server/session";
import { channel, member, serverState } from "../../server/testState";
import { useServers } from "../../state/servers";
import { HouseMenu } from "../shell/TopBar";
import { leaveServer } from "./leave";
import { ServerSettingsModal, visibleTabs } from "./ServerSettingsModal";

const NOW = 1_800_000_000;
const ALL = [
  "manage_server",
  "manage_roles",
  "manage_channels",
  "create_invites",
  "view_audit_log",
  "mute_members",
  "move_members",
  "kick_members",
  "ban_members",
  "connect",
  "speak",
  "stream",
] as const;
const roles: RoleDef[] = [
  { id: "everyone", name: "@все", color: null, permissions: ["connect", "speak", "stream"] },
  { id: "moderator", name: "Модератор", color: null, permissions: ["connect", "speak", "stream", "mute_members", "move_members"] },
  { id: "admin", name: "Админ", color: "#e5484d", permissions: [...ALL] },
];
const owner: MeView = { user_id: "own0", is_owner: true, permissions: [...ALL], rank: 4294967295 };
const people = [
  member("own0", "Хозяин", { is_owner: true, rank: 4294967295 }),
  member("adm0", "Аня", { roles: ["admin"], rank: 2 }),
  member("v000", "Вася", { rank: 0 }),
];

function open(state: ServerStateView, tab?: string) {
  render(<ServerSettingsModal open address="a:1" state={state} clockOffset={0} onClose={() => {}} />);
  if (tab) fireEvent.click(screen.getByRole("tab", { name: tab }));
}

const posted = () => invoke.mock.calls.filter(([c]) => c === "server_post").map(([, args]) => args.body);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ seq: 1 });
});
afterEach(cleanup);

describe("server settings", () => {
  it("shows tabs by rights", () => {
    const plain: MeView = { user_id: "v000", is_owner: false, permissions: ["connect", "speak"], rank: 0 };
    expect(visibleTabs(plain)).toEqual(["members"]);
    expect(visibleTabs({ ...plain, permissions: ["manage_roles", "view_audit_log"] })).toEqual(["roles", "members", "audit"]);
    expect(visibleTabs(owner)).toEqual(["profile", "roles", "members", "channels", "invites", "audit", "limits", "encryption"]);
    expect(visibleTabs({ ...owner, is_owner: false }), "every right, but not the owner").not.toContain("encryption");
    // «Подключение» changes the server on this PC: only its owner, and only on the PC it runs on.
    expect(visibleTabs(owner, true)).toEqual(["profile", "connection", "roles", "members", "channels", "invites", "audit", "limits", "encryption"]);
    expect(visibleTabs({ ...owner, is_owner: false }, true)).not.toContain("connection");
    open(serverState({ me: plain, roles, members: people }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Участники"]);
  });

  it("roles tab edits name, color and rights and saves RoleUpdate", async () => {
    open(serverState({ me: owner, roles, members: people }), "Роли");
    fireEvent.click(screen.getByRole("button", { name: "Модератор" }));
    fireEvent.change(screen.getByLabelText("Название роли"), { target: { value: "Модеры" } });
    fireEvent.click(screen.getByRole("radio", { name: "Зелёный" }));
    fireEvent.click(screen.getByLabelText("Кикать с сервера"));
    fireEvent.click(screen.getByLabelText("Глушить для всех"));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить роль" }));
    await waitFor(() =>
      expect(posted()).toEqual([
        {
          type: "role_update",
          id: "moderator",
          name: "Модеры",
          color: "#30a46c",
          permissions: ["move_members", "kick_members", "connect", "speak", "stream"],
        },
      ]),
    );
  });

  it("cannot tick a right you do not have or edit a role above yours", () => {
    const moderatorMe: MeView = { user_id: "m000", is_owner: false, permissions: ["manage_roles", "mute_members", "connect"], rank: 1 };
    open(serverState({ me: moderatorMe, roles, members: people }), "Роли");
    fireEvent.click(screen.getByRole("button", { name: "@все" }));
    expect((screen.getByLabelText("Кикать с сервера") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Глушить для всех") as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Админ" }));
    expect(screen.getByText("Эту роль меняют только те, чья роль выше")).toBeTruthy();
    expect((screen.getByLabelText("Название роли") as HTMLInputElement).disabled).toBe(true);
  });

  it("dragging a role sends RoleOrder", async () => {
    const withDj: RoleDef[] = [roles[0]!, roles[1]!, { id: "dj", name: "Диджей", color: null, permissions: [] }, roles[2]!];
    open(serverState({ me: owner, roles: withDj, members: people }), "Роли");
    const list = screen.getByRole("list", { name: "Роли по старшинству" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["Админ", "Диджей", "Модератор", "@все"]);
    fireEvent.dragStart(screen.getByRole("button", { name: "Модератор" }));
    fireEvent.dragOver(screen.getByRole("button", { name: "Админ" }));
    fireEvent.drop(screen.getByRole("button", { name: "Админ" }));
    await waitFor(() => expect(posted()).toEqual([{ type: "role_order", ids: ["everyone", "dj", "admin", "moderator"] }]));
  });

  it("channel tab sets the limit and per-role view/connect/speak", async () => {
    open(serverState({ me: owner, roles, members: people, channels: [channel("general", "Общий")] }), "Комнаты");
    fireEvent.click(screen.getByRole("button", { name: "Общий" }));
    fireEvent.change(screen.getByLabelText("Лимит людей (0 значит без лимита)"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("@все — видеть"), { target: { value: "deny" } });
    fireEvent.change(screen.getByLabelText("Модератор — входить"), { target: { value: "allow" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(posted()).toEqual([
        {
          type: "channel_update",
          id: "general",
          name: "Общий",
          user_limit: 8,
          overrides: [
            { role: "everyone", view: "deny", connect: "inherit", speak: "inherit" },
            { role: "moderator", view: "inherit", connect: "allow", speak: "inherit" },
          ],
          kind: "voice",
        },
      ]),
    );
  });

  it("channel tab turns a channel into a text one, with no limit to set", async () => {
    open(serverState({ me: owner, roles, members: people, channels: [channel("general", "Общий", { user_limit: 5 })] }), "Комнаты");
    fireEvent.click(screen.getByRole("button", { name: "Общий" }));
    fireEvent.click(screen.getByRole("button", { name: "Текстовый" }));
    expect(screen.queryByLabelText("Лимит людей (0 значит без лимита)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(posted()).toEqual([expect.objectContaining({ type: "channel_update", id: "general", kind: "text" })]));
  });

  it("invites tab creates a link with roles, uses and expiry, shows it once and revokes", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "invite_create" ? { link: "hatavoice://a:1/#v=1&sk=SK&inv=NEW" } : { seq: 1 },
    );
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const invites = [{ key: "K1", roles: [], max_uses: 5, uses: 2, expires_at: null, by: "own0", at: NOW }];
    open(serverState({ me: owner, roles, members: people, invites }), "Приглашения");
    expect(screen.getByText("2/5")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Модератор"));
    fireEvent.click(screen.getByLabelText("5 раз"));
    fireEvent.click(screen.getByLabelText("1 день"));
    fireEvent.click(screen.getByRole("button", { name: "Создать ссылку" }));
    expect(await screen.findByText("hatavoice://a:1/#v=1&sk=SK&inv=NEW")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("invite_create", {
      address: "a:1",
      shareAddress: "a:1",
      roles: ["moderator"],
      maxUses: 5,
      expiresMinutes: 1440,
    });
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hatavoice://a:1/#v=1&sk=SK&inv=NEW"));
    expect(screen.getByText("Ссылка показывается один раз. Скопируй её сейчас")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Отозвать" }));
    await waitFor(() => expect(posted()).toEqual([{ type: "invite_revoke", invite: "K1" }]));
  });

  it("audit tab filters by person and action", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "audit"
        ? [
            { at: NOW, actor: "own0", kind: "kick", target: "v000", detail: { type: "kick", reason: "спам" }, verified: true },
            { at: NOW - 5, actor: "own0", kind: "ban", target: "v000", detail: { reason: "подделка" }, verified: false },
          ]
        : { seq: 1 },
    );
    open(serverState({ me: owner, roles, members: people }), "Журнал");
    expect(await screen.findByText("Хозяин → Вася: кик — спам")).toBeTruthy();
    const lines = screen.getAllByRole("listitem");
    expect(within(lines[0]!).queryByText(/не подтверждено/)).toBeNull();
    expect(within(lines[1]!).getByText("Нет подписи: это мог подделать сервер")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("audit", { address: "a:1", user: null, kind: null, before: null });
    fireEvent.change(screen.getByLabelText("Человек"), { target: { value: "v000" } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("audit", { address: "a:1", user: "v000", kind: null, before: null }));
    fireEvent.change(screen.getByLabelText("Действие"), { target: { value: "kick" } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("audit", { address: "a:1", user: "v000", kind: "kick", before: null }));
  });

  it("encryption tab asks before the owner starts the chat's group over", async () => {
    open(serverState({ me: owner, roles, members: people }), "Шифрование");
    fireEvent.click(screen.getByRole("button", { name: "Пересоздать группу шифрования" }));
    expect(invoke).not.toHaveBeenCalledWith("chat_reset", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Пересоздать группу шифрования" }));
    expect(screen.getByText("Пересоздать группу шифрования для всех?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Пересоздать" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat_reset", { address: "a:1" }));
  });

  it("the owner picks how much history newcomers get, keeping the AFK settings", async () => {
    const settings = { afk_channel: "away", afk_minutes: 15, history_days: 30 };
    open(serverState({ me: owner, roles, members: people, settings }), "Шифрование");
    const select = screen.getByRole("combobox", { name: "История для новичков" }) as HTMLSelectElement;
    expect(select.value).toBe("30");
    expect([...select.options].map((o) => o.text)).toEqual(["Не передавать", "За неделю", "За месяц", "За 90 дней"]);
    fireEvent.change(select, { target: { value: "0" } });
    await waitFor(() => expect(posted()).toEqual([{ type: "server_settings", afk_channel: "away", afk_minutes: 15, history_days: 0 }]));
  });

  it("limits tab picks the AFK channel and minutes", async () => {
    const channels = [channel("general", "Общий"), channel("away", "Отошёл")];
    open(serverState({ me: owner, roles, members: people, channels }), "Ограничения");
    fireEvent.change(screen.getByLabelText("АФК-комната"), { target: { value: "away" } });
    fireEvent.click(screen.getByLabelText("15 минут"));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(posted()).toEqual([{ type: "server_settings", afk_channel: "away", afk_minutes: 15, history_days: 30 }]));
  });

  it("profile tab uploads an icon and saves the welcome text", async () => {
    const icon = { sha256: "ef".repeat(32), mime: "image/png", size: 900 };
    invoke.mockImplementation(async (command: string) =>
      command === "pick_files" ? [{ token: "t-logo", name: "logo.png", size: 900 }] : command === "media_upload" ? icon : { seq: 1 },
    );
    open(serverState({ me: owner, roles, members: people }), "Профиль");
    fireEvent.click(screen.getByRole("button", { name: "Загрузить иконку…" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("media_upload", { address: "a:1", token: "t-logo", purpose: "icon" }));
    expect(invoke).toHaveBeenCalledWith("pick_files", { kind: "icon", multiple: false, title: null });
    fireEvent.change(screen.getByLabelText("Приветствие для новичков"), { target: { value: "Привет! Не токсичь." } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(posted()).toEqual([{ type: "server_profile", name: "Хата", description: "", welcome: "Привет! Не токсичь.", icon }]),
    );
  });

  it("members tab lists bans with who, why and until, and unbans", async () => {
    const bans = [{ user_id: "bad0", nickname: "Гриф", by: "own0", at: NOW, until: null, reason: "Спам", media: null }];
    open(serverState({ me: owner, roles, members: people, bans }));
    const ban = screen.getByRole("listitem", { name: "Гриф" });
    expect(within(ban).getByText("Спам")).toBeTruthy();
    expect(within(ban).getByText(/забанил Хозяин · навсегда/)).toBeTruthy();
    fireEvent.click(within(ban).getByRole("button", { name: "Разбанить" }));
    await waitFor(() => expect(posted()).toEqual([{ type: "unban", user: "bad0" }]));
  });

  it("gives a person a role below yours", async () => {
    open(serverState({ me: owner, roles, members: people }));
    fireEvent.click(screen.getByLabelText("Вася: Модератор"));
    await waitFor(() => expect(posted()).toEqual([{ type: "member_roles", user: "v000", roles: ["moderator"] }]));
  });

  it("the owner hands over ownership after a confirmation", async () => {
    open(serverState({ me: owner, roles, members: people }));
    fireEvent.change(screen.getByLabelText("Новый владелец"), { target: { value: "adm0" } });
    fireEvent.click(screen.getByRole("button", { name: "Передать владение…" }));
    expect(posted()).toEqual([]);
    expect(screen.getByText("Передать «Хата» участнику Аня? Ты станешь админом, вернуть владение сам не сможешь.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Передать" }));
    await waitFor(() => expect(posted()).toEqual([{ type: "owner_transfer", to: "adm0" }]));
  });

  it("leaving the server asks first and removes it from the list", async () => {
    useServers.setState({ servers: [{ address: "a:1", name: "Хата", color: "blue" }], selected: "a:1" });
    render(
      <HouseMenu server={{ name: "Хата", address: "a:1" }} servers={[]} serversUnread={{}} onSelect={() => {}} onAdd={() => {}} onLeave={() => leaveServer("a:1")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Меню сервера" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Покинуть сервер" }));
    expect(screen.getByText("Покинуть «Хата»? Вернуться можно только по новому приглашению.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Покинуть" }));
    await waitFor(() => expect(useServers.getState().servers).toEqual([]));
    expect(posted()).toEqual([{ type: "leave" }]);
  });

  it("the owner's menu offers deleting the server on this PC, and only taking one hosted elsewhere off the list", () => {
    const onDelete = vi.fn();
    const onForget = vi.fn();
    const { unmount } = render(
      <HouseMenu server={{ name: "Хата", address: "127.0.0.1:7350" }} servers={[]} serversUnread={{}} onSelect={() => {}} onAdd={() => {}} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Меню сервера" }));
    expect(screen.queryByRole("menuitem", { name: "Покинуть сервер" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Удалить сервер" }));
    expect(onDelete).toHaveBeenCalled();
    unmount();
    render(<HouseMenu server={{ name: "Чужой", address: "a:1" }} servers={[]} serversUnread={{}} onSelect={() => {}} onAdd={() => {}} onForget={onForget} />);
    fireEvent.click(screen.getByRole("button", { name: "Меню сервера" }));
    expect(screen.queryByRole("menuitem", { name: "Удалить сервер" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Убрать из списка" }));
    expect(onForget).toHaveBeenCalled();
  });
});
