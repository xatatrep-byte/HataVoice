// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string, protocol = "asset") => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import type { MeView, MediaRef } from "../../server/session";
import { channel, member, serverState } from "../../server/testState";
import { useServers } from "../../state/servers";
import type { CallSecurity } from "../../voice/callSecurity";
import { Dock } from "../stage/Dock";
import { KickedCard } from "./KickedCard";
import { ModerationNotice } from "./ModerationNotice";
import { menuItems } from "./menu";
import { PersonMenu } from "./PersonMenu";
import { afterPunishment } from "./punishment";

const NOW = 1_800_000_000;
const SECURE: CallSecurity = { state: "secure", code: "12345 67890 00042 99999 01234 55555", members: [], error: null };
const gif: MediaRef = { sha256: "ab".repeat(32), mime: "image/gif", size: 2048 };
const clip: MediaRef = { sha256: "cd".repeat(32), mime: "video/mp4", size: 4096 };
const moderator: MeView = { user_id: "me00", is_owner: false, permissions: ["mute_members", "move_members", "kick_members", "ban_members"], rank: 2 };

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("person menu", () => {
  it("shows only actions you have rights for and greys out higher ranks", () => {
    const me: MeView = { ...moderator, permissions: ["mute_members", "kick_members"] };
    const lower = member("v000", "Вася", { rank: 1, channel: "general" });
    expect(menuItems(me, lower).map((i) => [i.id, i.disabled])).toEqual([
      ["mute", false],
      ["kick", false],
    ]);
    const equal = member("a000", "Аня", { rank: 2 });
    expect(menuItems(me, equal).every((i) => i.disabled && i.hint === "Его роль не ниже твоей")).toBe(true);
    const muted = member("v000", "Вася", { rank: 1, muted: { by: "me00", at: NOW, until: null, reason: "" } });
    expect(menuItems(me, muted).map((i) => i.id)).toEqual(["unmute", "kick"]);

    expect(menuItems(moderator, lower).map((i) => i.id)).toEqual(["mute", "move", "disconnect", "kick", "ban"]);
    expect(menuItems(moderator, { ...lower, channel: null }).map((i) => i.id)).toEqual(["mute", "kick", "ban"]);
    expect(menuItems(moderator, member("me00", "Я"))).toEqual([]);
    const owner: MeView = { user_id: "own0", is_owner: true, permissions: [], rank: 0 };
    expect(menuItems(owner, equal).every((i) => !i.disabled)).toBe(true);
    expect(menuItems(moderator, member("own0", "Хозяин", { is_owner: true })).every((i) => i.disabled)).toBe(true);
  });

  it("«Написать» opens direct messages with the person, not with oneself", () => {
    const target = member("v000", "Вася", { rank: 1 });
    const onWrite = vi.fn();
    const onClose = vi.fn();
    render(<PersonMenu address="a:1" state={serverState({ me: moderator, members: [target] })} target={target} onClose={onClose} onWrite={onWrite} />);
    fireEvent.click(screen.getByRole("button", { name: "Написать" }));
    expect(onWrite).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    cleanup();
    const me = member(moderator.user_id, "Я");
    render(<PersonMenu address="a:1" state={serverState({ me: moderator, members: [me] })} target={me} onClose={() => {}} onWrite={onWrite} />);
    expect(screen.queryByRole("button", { name: "Написать" })).toBeNull();
  });

  it("mute dialog offers 5 min, 15 min, 1 h, 1 day and until lifted", async () => {
    invoke.mockResolvedValue({});
    const target = member("v000", "Вася", { rank: 1 });
    render(<PersonMenu address="a:1" state={serverState({ me: moderator, members: [target] })} target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Заглушить для всех" }));
    for (const label of ["5 минут", "15 минут", "1 час", "1 день", "До снятия"]) expect(screen.getByLabelText(label)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("15 минут"));
    fireEvent.change(screen.getByLabelText("Причина"), { target: { value: "Шумит" } });
    fireEvent.click(screen.getByRole("button", { name: "Заглушить" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("moderate", {
        address: "a:1",
        command: { action: "mute", user: "v000", minutes: 15, reason: "Шумит" },
      }),
    );
  });

  it("kick dialog uploads the chosen GIF and sends the reason", async () => {
    // The dialog is the program's own: the page gets a token, never the path.
    invoke.mockImplementation(async (command: string) =>
      command === "pick_files" ? [{ token: "t-1", name: "bye.gif", size: 2048 }] : command === "my_gifs" ? [] : command === "media_upload" ? gif : { seq: 9 },
    );
    const target = member("v000", "Вася", { rank: 1 });
    render(<PersonMenu address="a:1" state={serverState({ me: moderator, members: [target] })} target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Кикнуть с сервера" }));
    fireEvent.change(screen.getByLabelText("Причина"), { target: { value: "Хватит" } });
    fireEvent.click(screen.getByRole("button", { name: "Выбрать файл…" }));
    expect(await screen.findByText("bye.gif")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("pick_files", { kind: "gif", multiple: false, title: null });
    expect(invoke).toHaveBeenCalledWith("media_upload", { address: "a:1", token: "t-1", purpose: "moderation" });

    fireEvent.click(screen.getByRole("button", { name: "Кикнуть" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("server_post", {
        address: "a:1",
        body: { type: "kick", user: "v000", reason: "Хватит", media: gif },
      }),
    );
  });

  it("recently used GIFs are offered again, by id: the page never holds their paths", async () => {
    // The list the page kept before goes to Rust once (it takes in only real GIFs), then the page forgets it.
    localStorage.setItem("hatavoice.myGifs", JSON.stringify([{ path: "C:\\g\\3.gif", name: "3.gif" }]));
    invoke.mockImplementation(async (command: string) =>
      command === "my_gifs" ? [{ id: "g3", name: "3.gif" }] : command === "my_gif_upload" ? clip : { seq: 9 },
    );
    const target = member("v000", "Вася", { rank: 1 });
    render(<PersonMenu address="a:1" state={serverState({ me: moderator, members: [target] })} target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Забанить" }));
    fireEvent.click(await screen.findByRole("button", { name: "3.gif" }));
    expect(invoke).toHaveBeenCalledWith("my_gifs", { legacy: ["C:\\g\\3.gif"] });
    expect(localStorage.getItem("hatavoice.myGifs")).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("my_gif_upload", { address: "a:1", id: "g3" }));
    fireEvent.click(screen.getByLabelText("7 дней"));
    fireEvent.click(screen.getByRole("button", { name: "Забанить на 7 дней" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("server_post", expect.anything()));
    const body = invoke.mock.calls.find(([c]) => c === "server_post")![1].body;
    expect(body).toMatchObject({ type: "ban", user: "v000", reason: "", media: clip });
    expect(Math.abs(body.until - (serverState().server_time + 7 * 86400))).toBeLessThan(5);
  });
});

describe("after a kick or ban", () => {
  it("the kicked person sees who, why and the GIF with sound, then the server disappears", () => {
    const onClose = vi.fn();
    render(<KickedCard address="a:1" kind="kick" byName="Петя" reason="Хватит" media={clip} until={null} onClose={onClose} />);
    expect(screen.getByText("Тебя кикнул Петя")).toBeTruthy();
    expect(screen.getByText("Хватит")).toBeTruthy();
    const video = document.querySelector("video")!;
    expect(video.muted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Выключить звук" }));
    expect(video.muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(onClose).toHaveBeenCalled();

    useServers.setState({ servers: [{ address: "a:1", name: "Хата", color: "blue" }, { address: "b:1", name: "Б", color: "blue" }], selected: "a:1" });
    afterPunishment("a:1", "kick", null);
    expect(useServers.getState().servers.map((s) => s.address)).toEqual(["b:1"]);
    useServers.setState({ servers: [{ address: "a:1", name: "Хата", color: "blue" }], selected: "a:1" });
    afterPunishment("a:1", "ban", NOW + 86400);
    expect(useServers.getState().servers[0]).toMatchObject({ address: "a:1", bannedUntil: NOW + 86400 });
  });

  it("a ban card says until when", () => {
    render(<KickedCard address="a:1" kind="ban" byName="Петя" reason="" media={gif} until={null} onClose={() => {}} />);
    expect(screen.getByText("Тебя забанил Петя — навсегда")).toBeTruthy();
    expect(document.querySelector("img")!.getAttribute("src")).toBe(`http://hvmedia.localhost/a%3A1%2F${gif.sha256}`);
  });

  it("neighbours see the kick notice; the GIF sound follows the setting", () => {
    const notice = { userName: "Вася", kind: "kick" as const, reason: "спам", media: clip };
    const { rerender } = render(<ModerationNotice address="a:1" notice={notice} gifSound={false} onClose={() => {}} />);
    expect(screen.getByText("Вася кикнут: спам")).toBeTruthy();
    expect(document.querySelector("video")!.muted).toBe(true);
    rerender(<ModerationNotice address="a:1" notice={notice} gifSound onClose={() => {}} />);
    expect(document.querySelector("video")!.muted).toBe(false);
  });
});

describe("server mute", () => {
  it("a server-muted mic shows a lock and a countdown and cannot be turned on", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const onToggleMic = vi.fn();
    render(
      <Dock
        micOn
        transmitting={false}
        deafened={false}
        micLevel={0}
        security={SECURE}
        serverMute={{ until: NOW + 900, byName: "Петя", reason: "Шумит" }}
        clockOffset={0}
        onToggleMic={onToggleMic}
        onToggleDeafen={() => {}}
        onLeave={() => {}}
      />,
    );
    const mic = screen.getByRole("button", { name: "Тебя заглушил Петя: Шумит" }) as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    fireEvent.click(mic);
    expect(onToggleMic).not.toHaveBeenCalled();
    expect(screen.getByText("15:00")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("14:59")).toBeTruthy();
  });

  it("a mute until lifted has no countdown", () => {
    render(
      <Dock
        micOn
        transmitting={false}
        deafened={false}
        micLevel={0}
        security={SECURE}
        serverMute={{ until: null, byName: "Петя", reason: "" }}
        clockOffset={0}
        onToggleMic={() => {}}
        onToggleDeafen={() => {}}
        onLeave={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Тебя заглушил Петя" })).toBeTruthy();
    expect(screen.getByText("до снятия")).toBeTruthy();
  });

  it("moving someone offers the other channels", async () => {
    invoke.mockResolvedValue({});
    const target = member("v000", "Вася", { rank: 1, channel: "general" });
    const state = serverState({ me: moderator, members: [target], channels: [channel("general", "Общий"), channel("games", "Игры")] });
    render(<PersonMenu address="a:1" state={state} target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Перенести в комнату…" }));
    expect(screen.queryByRole("button", { name: "Общий" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Игры" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("moderate", { address: "a:1", command: { action: "move", user: "v000", channel: "games" } }),
    );
  });
});
