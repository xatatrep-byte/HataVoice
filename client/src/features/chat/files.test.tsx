// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const invoke = vi.fn();
type Picked = { token: string; name: string; size: number };
// The program's own dialogs (Rust): what they answer, and the files Windows says were dropped.
const picks = vi.hoisted(() => ({ files: [] as { token: string; name: string; size: number }[], save: null as { token: string; name: string; size: number } | null }));
const drops = vi.hoisted(() => ({ handler: null as ((event: { payload: { token: string; name: string; size: number }[] }) => void) | null }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: { token: string; name: string; size: number }[] }) => void) => {
    if (name === "files-dropped") drops.handler = handler;
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import type { FileView, ItemView } from "../../chat/api";
import { channel, member, serverState } from "../../server/testState";
import { ChatView } from "./ChatView";

const T = 1_800_000_000;
const file = (over: Partial<FileView>): FileView => ({ blob: "ab".repeat(32), size: 2048, name: "кот.png", mime: "image/png", ...over });
const item = (files: FileView[], over: Partial<ItemView> = {}): ItemView => ({
  id: "m1",
  seq: 1,
  at: T,
  author: "a000",
  text: "",
  reply: null,
  edited: false,
  deleted: false,
  reactions: [],
  poll: null,
  files,
  mentions_me: false,
  ...over,
});

async function open(items: ItemView[]) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "chat_view") return { channel: "general", items, last_seq: 1 };
    if (command === "chat_status") return "ready";
    if (command === "pick_files") return picks.files;
    if (command === "pick_save") return picks.save;
    return null;
  });
  render(<ChatView address="a:1" channel={channel("general", "Общий")} state={serverState({ members: [member("me00", "Петя"), member("a000", "Аня")] })} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const sent = () => invoke.mock.calls.filter(([name]) => name === "chat_send").map(([, args]) => args);
const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const strip = () => screen.queryByRole("list", { name: "Вложения" });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => (command === "pick_files" ? picks.files : command === "pick_save" ? picks.save : null));
  picks.files = [];
  picks.save = null;
  drops.handler = null;
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("attachments", () => {
  it("«Прикрепить» puts the chosen files in the strip, and they go with the message", async () => {
    await open([]);
    picks.files = [
      { token: "t-cat", name: "кот.png", size: 2048 },
      { token: "t-doc", name: "отчёт.pdf", size: 4096 },
    ] satisfies Picked[];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Прикрепить" }));
    });
    expect(invoke).toHaveBeenCalledWith("pick_files", { kind: "any", multiple: true, title: "Прикрепить файлы" });
    expect(within(strip()!).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["кот.png", "отчёт.pdf"]);
    fireEvent.click(screen.getByRole("button", { name: "Убрать «отчёт.pdf»" }));
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(sent()).toEqual([
      { address: "a:1", channel: "general", text: "", reply: null, files: [{ token: "t-cat", data: null, name: "кот.png" }] },
    ]);
    expect(strip()).toBeNull();
  });

  it("a photo opens in the photo editor and a video in the video editor; other files in neither", async () => {
    await open([]);
    picks.files = [
      { token: "t-cat", name: "кот.jpg", size: 2048 },
      { token: "t-clip", name: "клип.mp4", size: 4096 },
      { token: "t-film", name: "фильм.mp4", size: 900 * 1024 * 1024 },
      { token: "t-doc", name: "отчёт.pdf", size: 4096 },
    ] satisfies Picked[];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Прикрепить" }));
    });
    expect(screen.queryByRole("button", { name: "Изменить «отчёт.pdf»" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Монтаж «отчёт.pdf»" })).toBeNull();
    invoke.mockImplementation(async (command: string) => (command === "picked_media" ? "AAAA" : null));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Изменить «кот.jpg»" }));
    });
    expect(invoke).toHaveBeenCalledWith("picked_media", { token: "t-cat" });
    expect(screen.getByRole("dialog", { name: "Редактор фото" })).toBeTruthy();
  });

  it("a big video plays in the editor from the file itself, in pieces, never read whole", async () => {
    await open([]);
    picks.files = [{ token: "t-film", name: "фильм.mp4", size: 900 * 1024 * 1024 }];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Прикрепить" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Монтаж «фильм.mp4»" }));
    });
    expect(invoke).not.toHaveBeenCalledWith("picked_media", expect.anything());
    expect(screen.getByRole("dialog", { name: "Видеоредактор" })).toBeTruthy();
  });

  it("a picture pasted from the clipboard goes as bytes", async () => {
    await open([]);
    const picture = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(field(), { clipboardData: { files: [picture] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(strip()!).getByRole("img", { name: "image.png" })).toBeTruthy();
    fireEvent.change(field(), { target: { value: "вот" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(sent()[0]).toEqual({ address: "a:1", channel: "general", text: "вот", reply: null, files: [{ token: null, data: [0x89, 0x50, 0x4e, 0x47], name: "image.png" }] });
  });

  it("files dropped on the window join the strip, and a failed send keeps them", async () => {
    await open([]);
    invoke.mockImplementation(async (command: string) => {
      if (command === "chat_send") throw "Слишком много файлов — подожди минуту";
      if (command === "chat_view") return { channel: "general", items: [], last_seq: 0 };
      if (command === "chat_status") return "ready";
      return null;
    });
    await act(async () => {
      drops.handler?.({ payload: [{ token: "t-video", name: "видео.mp4", size: 1024 }] });
    });
    expect(within(strip()!).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["видео.mp4"]);
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(strip()).not.toBeNull();
  });

  it("refuses a pasted file over 25 MB and an eleventh file before sending", async () => {
    await open([]);
    const huge = new File([new Uint8Array(1)], "big.bin");
    Object.defineProperty(huge, "size", { value: 25 * 1024 * 1024 + 1 });
    await act(async () => {
      fireEvent.paste(field(), { clipboardData: { files: [huge] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(strip()).toBeNull();
    picks.files = Array.from({ length: 11 }, (_, n) => ({ token: `t${n}`, name: `f${n}.txt`, size: 10 }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Прикрепить" }));
    });
    expect(within(strip()!).getAllByRole("listitem")).toHaveLength(10);
  });
});

describe("big files", () => {
  it("a file from disk up to 2 GB goes; a bigger one is refused before sending", async () => {
    const { notify } = await import("../../ui/toasts");
    const said = vi.spyOn(notify, "error");
    await open([]);
    picks.files = [
      { token: "t-film", name: "фильм.mkv", size: 1.5 * 1024 ** 3 },
      { token: "t-huge", name: "образ.iso", size: 2 * 1024 ** 3 + 1 },
    ];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Прикрепить" }));
    });
    expect(within(strip()!).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["фильм.mkv"]);
    expect(said).toHaveBeenCalledWith("Файл больше 2 ГБ");
  });

  it("a big file in the feed is a card to save, never played in place", async () => {
    await open([item([file({ blob: "cd".repeat(32), name: "фильм.mp4", mime: "video/mp4", size: 1.25 * 1024 ** 3, big: true })])]);
    expect(document.querySelector("video")).toBeNull();
    const card = screen.getByText("фильм.mp4").closest(".msg-file")!;
    expect(card.textContent).toContain("1,25 ГБ");
    expect(within(card as HTMLElement).getByRole("button", { name: "Сохранить" })).toBeTruthy();
  });
});

describe("files in the feed", () => {
  it("shows pictures and videos, and other files as a card to save", async () => {
    await open([
      item([file({ name: "кот.png" }), file({ blob: "cd".repeat(32), name: "клип.mp4", mime: "video/mp4" }), file({ blob: "ef".repeat(32), name: "отчёт.pdf", mime: "application/octet-stream", size: 1_500_000 })]),
    ]);
    const picture = screen.getByRole("img", { name: "кот.png" }) as HTMLImageElement;
    expect(picture.src).toBe(`http://hvmedia.localhost/chat/a%3A1/${"ab".repeat(32)}`);
    expect(document.querySelector("video")!.getAttribute("src")).toBe(`http://hvmedia.localhost/chat/a%3A1/${"cd".repeat(32)}`);
    const card = screen.getByText("отчёт.pdf").closest(".msg-file")!;
    expect(card.textContent).toContain("1,4 МБ");
    picks.save = { token: "t-save", name: "отчёт.pdf", size: 0 };
    await act(async () => {
      fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Сохранить" }));
    });
    expect(invoke).toHaveBeenCalledWith("pick_save", { kind: "any", name: "отчёт.pdf" });
    expect(invoke).toHaveBeenCalledWith("chat_file_save", { address: "a:1", blob: "ef".repeat(32), token: "t-save" });
  });

  it("checks a file on VirusTotal in the program; without a key only the fingerprint goes, to the browser", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await open([item([file({ blob: "ef".repeat(32), name: "setup.exe", mime: "application/octet-stream" })])]);
    const fingerprint = "9f".repeat(32);
    invoke.mockImplementation(async (command: string) => (command === "vt_check" ? { state: "no_key", sha256: fingerprint } : null));
    const card = screen.getByText("setup.exe").closest(".msg-file")!;
    await act(async () => {
      fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Проверить на VirusTotal" }));
    });
    expect(invoke).toHaveBeenCalledWith("vt_check", { address: "a:1", blob: "ef".repeat(32) });
    const dialog = screen.getByRole("dialog", { name: "Проверка на VirusTotal" });
    expect(within(dialog).getByLabelText("Ключ VirusTotal")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    expect(openUrl).toHaveBeenCalledWith(`https://www.virustotal.com/gui/file/${fingerprint}`);
    expect(invoke.mock.calls.some(([name]) => /upload|send/.test(String(name)))).toBe(false);
  });

  it("shows what the antivirus engines found", async () => {
    await open([item([file({ blob: "ef".repeat(32), name: "setup.exe", mime: "application/octet-stream" })])]);
    const report = { state: "known", sha256: "9f".repeat(32), malicious: 2, suspicious: 0, engines: 70, flagged: [{ engine: "Kaspersky", result: "Trojan.Agent", malicious: true }], analysed_at: 1_800_000_000 };
    invoke.mockImplementation(async (command: string) => (command === "vt_check" ? report : null));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Проверить на VirusTotal" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Проверка на VirusTotal" });
    expect(dialog.textContent).toContain("Опасно: 2 из 70 антивирусов нашли угрозу");
    expect(within(dialog).getByRole("list", { name: "Что нашли антивирусы" }).textContent).toContain("Trojan.Agent");
  });

  it("sends a file the site never saw only once the person agrees it becomes the site's", async () => {
    await open([item([file({ blob: "ef".repeat(32), name: "setup.exe", mime: "application/octet-stream" })])]);
    invoke.mockImplementation(async (command: string) => (command === "vt_check" ? { state: "unknown", sha256: "9f".repeat(32) } : command === "vt_upload" ? "an-id" : null));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Проверить на VirusTotal" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Проверка на VirusTotal" });
    const sendIt = within(dialog).getByRole("button", { name: "Отправить на проверку" }) as HTMLButtonElement;
    expect(sendIt.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(sendIt);
    });
    expect(invoke).toHaveBeenCalledWith("vt_upload", { address: "a:1", blob: "ef".repeat(32), name: "setup.exe" });
  });

  it("opens a picture on the whole window and Esc closes it", async () => {
    await open([item([file({})])]);
    fireEvent.click(screen.getByRole("button", { name: "Открыть «кот.png»" }));
    const lightbox = screen.getByRole("dialog", { name: "кот.png" });
    expect(within(lightbox).getByRole("img", { name: "кот.png" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "кот.png" })).toBeNull();
  });

  it("a picture that does not load says so", async () => {
    await open([item([file({})])]);
    fireEvent.error(screen.getByRole("img", { name: "кот.png" }));
    expect(screen.getByText("Файл недоступен")).toBeTruthy();
  });
});
