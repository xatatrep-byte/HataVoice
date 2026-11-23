// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WatchControls } from "../../watch/useWatch";
import { WatchDialog } from "./WatchDialog";
import { CinemaChoices, WatchTile } from "./WatchTile";

afterEach(cleanup);

const controls = (url: string | null, over: Partial<WatchControls> = {}): WatchControls => ({
  state: url ? { url, playing: true, pos: 61_000, at: 1_000_000, by: "a000", picks: {} } : null,
  me: "me00",
  serverNow: () => 1_000_000,
  start: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
  choose: vi.fn(),
  adopt: vi.fn(),
  ...over,
});

describe("watching together", () => {
  it("starts a link it can play, says why not, and asks how to watch any other site", () => {
    const onStart = vi.fn();
    render(<WatchDialog open onClose={() => {}} onStart={onStart} />);
    const field = screen.getByRole("textbox", { name: "Ссылка на видео или на страницу с ним" });
    fireEvent.change(field, { target: { value: "http://example.com/page" } });
    fireEvent.click(screen.getByRole("button", { name: "Смотреть вместе" }));
    expect(screen.getByText(/начинается с https/)).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "https://example.com/serial/7-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Трансляцией" }));
    fireEvent.click(screen.getByRole("button", { name: "Смотреть вместе" }));
    expect(onStart).toHaveBeenCalledWith("https://example.com/serial/7-3#hv-stream");
    fireEvent.change(field, { target: { value: " https://youtu.be/dQw4w9WgXcQ " } });
    fireEvent.click(screen.getByRole("button", { name: "Смотреть вместе" }));
    expect(onStart).toHaveBeenCalledWith("https://youtu.be/dQw4w9WgXcQ");
  });

  it("plays YouTube in its cookie-less frame from where the others are, and stops for everyone", () => {
    const watch = controls("https://youtu.be/dQw4w9WgXcQ");
    render(<WatchTile watch={watch} byName="Аня" />);
    const frame = screen.getByTitle("Плеер YouTube") as HTMLIFrameElement;
    const src = new URL(frame.src);
    expect(src.origin).toBe("https://www.youtube-nocookie.com");
    expect(src.pathname).toBe("/embed/dQw4w9WgXcQ");
    expect(src.searchParams.get("start")).toBe("61");
    expect(screen.getByText("Видео идёт с YouTube напрямую: YouTube видит, что ты смотришь")).toBeTruthy();
    expect(screen.getByText(/Ведёт: Аня/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Остановить для всех" }));
    expect(watch.stop).toHaveBeenCalledOnce();
  });

  it("moves Rutube to where the others are once it is ready, and takes no advert pause for the viewer's", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000_000);
    try {
      const watch = controls("https://rutube.ru/video/5e847ce59e3475e7e03043ee0afd6e57/");
      render(<WatchTile watch={watch} byName="Аня" />);
      const frame = screen.getByTitle("Плеер Rutube") as HTMLIFrameElement;
      expect(frame.src).toBe("https://rutube.ru/play/embed/5e847ce59e3475e7e03043ee0afd6e57");
      expect(screen.getByText("Видео идёт с Rutube напрямую: Rutube видит, что ты смотришь")).toBeTruthy();
      const sent = vi.fn();
      frame.contentWindow!.postMessage = sent;
      const say = (type: string, data: object, origin = "https://rutube.ru") =>
        act(() => {
          window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, data }), origin, source: frame.contentWindow }));
        });
      const commands = () => sent.mock.calls.map(([message, target]) => [JSON.parse(message as string).type, target]);

      say("player:ready", {});
      expect(sent.mock.calls.map(([message]) => JSON.parse(message as string))).toEqual([
        { type: "player:setCurrentTime", data: { time: 61 } },
        { type: "player:play", data: {} },
      ]);
      expect(commands().every(([, target]) => target === "https://rutube.ru")).toBe(true);

      vi.setSystemTime(10_002_000);
      say("player:changeState", { state: "advert" });
      say("player:changeState", { state: "pause" });
      expect(watch.pause).not.toHaveBeenCalled();
      say("player:changeState", { state: "playing" });

      vi.setSystemTime(10_010_000);
      say("player:currentTime", { time: 70 });
      say("player:changeState", { state: "pause" }, "https://evil.example");
      expect(watch.pause, "only the player's own site is heard").not.toHaveBeenCalled();
      say("player:changeState", { state: "pause" });
      expect(watch.pause).toHaveBeenCalledWith(70_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens any other site in a window of its own, and shows the leader's stream to the others", () => {
    render(<WatchTile watch={controls("https://example.com/serial/7-3")} byName="Аня" />);
    expect(screen.getByText("Синхронно")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Открыть сайт" })).toBeTruthy();
    cleanup();
    render(<WatchTile watch={controls("https://example.com/serial/7-3#hv-stream")} byName="Аня" />);
    expect(screen.getByText("Аня показывает видео своим экраном")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Открыть сайт" }), "only the leader opens the site").toBeNull();
  });

  it("has one control bar everyone uses: pause and ten seconds back go to everyone", () => {
    const watch = controls("https://files.example/film.mp4");
    render(<WatchTile watch={watch} byName="Аня" />);
    fireEvent.click(screen.getByRole("button", { name: "Пауза для всех" }));
    expect(watch.pause).toHaveBeenCalledWith(61_000);
    fireEvent.click(screen.getByRole("button", { name: "Назад на 10 секунд" }));
    expect(watch.seek).toHaveBeenCalledWith(51_000);
  });

  it("plays a video file in a plain player; nothing is shown when nothing is watched", () => {
    render(<WatchTile watch={controls("https://files.example/film.mp4")} byName="Аня" />);
    const video = document.querySelector("video.watch-player") as HTMLVideoElement;
    expect(video.src).toBe("https://files.example/film.mp4");
    expect(screen.getByText("film.mp4")).toBeTruthy();
    cleanup();
    const { container } = render(<WatchTile watch={controls(null)} byName="" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a site's players, seasons, episodes and dubs as the call's own buttons; a choice goes to everyone", () => {
    const onChoose = vi.fn();
    render(
      <CinemaChoices
        choices={{
          players: { items: ["Плеер 1", "Плеер 2", "Плеер 3"], active: 0 },
          season: { items: ["1 сезон", "2 сезон"], active: 0 },
          episode: { items: ["1 серия", "2 серия", "3 серия"], active: 1 },
          dub: { items: ["BTi Studios", "Eng.Original"], active: 0 },
        }}
        onChoose={onChoose}
      />,
    );
    expect(screen.getByRole("button", { name: "Плеер 1" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Плеер 2" }));
    expect(onChoose).toHaveBeenLastCalledWith("players", "Плеер 2");
    expect((screen.getByLabelText("Серия") as HTMLSelectElement).value).toBe("1");
    fireEvent.change(screen.getByLabelText("Серия"), { target: { value: "2" } });
    expect(onChoose).toHaveBeenLastCalledWith("episode", "3 серия");
    fireEvent.change(screen.getByLabelText("Сезон"), { target: { value: "1" } });
    expect(onChoose).toHaveBeenLastCalledWith("season", "2 сезон");
    fireEvent.change(screen.getByLabelText("Озвучка"), { target: { value: "1" } });
    expect(onChoose).toHaveBeenLastCalledWith("dub", "Eng.Original");
  });

  it("shows no choices for a page that has none", () => {
    const { container } = render(<CinemaChoices choices={{}} onChoose={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("goes full screen as a whole (its bars over the picture) and back by the same button", () => {
    const watch = controls("https://files.example/film.mp4");
    const { container } = render(<WatchTile watch={watch} byName="Аня" />);
    const figure = container.querySelector("figure.cinema") as HTMLElement;
    let full: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => full });
    figure.requestFullscreen = vi.fn(async () => {
      full = figure;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    document.exitFullscreen = vi.fn(async () => {
      full = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Во весь экран" }));
    expect(figure.requestFullscreen).toHaveBeenCalled();
    expect(figure.classList.contains("full")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Выйти из полного экрана" }));
    expect(document.exitFullscreen).toHaveBeenCalled();
    expect(figure.classList.contains("full")).toBe(false);
  });
});
