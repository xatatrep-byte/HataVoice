// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePrefs } from "../../state/prefs";
import { NO_CALL, type CallSecurity } from "../../voice/callSecurity";
import type { ParticipantView } from "../../voice/participants";
import type { ScreenView } from "../../voice/screen";
import { Stage } from "./Stage";

// The 3D canvas as a stand-in that says whether it draws: jsdom has no WebGL.
vi.mock("../../characters/CharacterCanvas", () => ({
  CharacterCanvas: ({ paused }: { paused?: boolean }) => <canvas data-testid="scene" data-paused={paused ? "yes" : "no"} />,
}));

afterEach(cleanup);

const person = (over: Partial<ParticipantView> = {}): ParticipantView => ({
  identity: "p1",
  name: "Петя",
  speaking: false,
  muted: false,
  isLocal: false,
  quality: "good",
  level: 0,
  deafened: false,
  color: "violet",
  encrypted: true,
  ...over,
});

const security: CallSecurity = { ...NO_CALL, state: "secure", members: ["p1", "me00"] };
const people = [person({ identity: "me00", name: "Я", isLocal: true }), person()];
const track = () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as NonNullable<ScreenView["track"]>;
const acts = { acts: [], perform: vi.fn(() => true) };

describe("the 3D stage and a shared screen", () => {
  it("switch in one click each way: the stage waits loaded behind the screen, the screen goes on in a corner", () => {
    usePrefs.setState({ stage3d: true });
    const onWatchScreen = vi.fn();
    const shown = { identity: "p1", isLocal: false, track: track(), watching: true, hasAudio: true };
    const { container } = render(<Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} screens={[shown]} onWatchScreen={onWatchScreen} acts={acts} />);
    // The screen is big; the stage is there already, drawing nothing.
    expect(screen.getByRole("figure", { name: "Экран: Петя" })).toBeTruthy();
    expect(screen.getByTestId("scene").dataset.paused).toBe("yes");
    expect(container.querySelector(".character-stage.parked")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /3D-сцена/ }));
    expect(screen.queryByRole("figure", { name: "Экран: Петя" })).toBeNull();
    expect(screen.getByTestId("scene").dataset.paused).toBe("no");
    expect(container.querySelector(".stage.with-characters")).not.toBeNull();
    // The screen was not closed: its frames keep coming, small.
    expect(onWatchScreen).not.toHaveBeenCalled();
    const peek = screen.getByRole("button", { name: "Вернуться к демонстрации: Петя" });
    expect(shown.track.attach).toHaveBeenCalledWith(peek.querySelector("video"));

    fireEvent.click(peek);
    expect(screen.getByRole("figure", { name: "Экран: Петя" })).toBeTruthy();
    expect(screen.getByTestId("scene").dataset.paused).toBe("yes");
    fireEvent.click(screen.getByRole("tab", { name: /3D-сцена/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Петя/ }));
    expect(screen.getByRole("figure", { name: "Экран: Петя" })).toBeTruthy();
  });

  it("offers no stage tab without 3D, and the next screen shared comes up big again", () => {
    usePrefs.setState({ stage3d: false });
    const shown = { identity: "p1", isLocal: false, track: track(), watching: true, hasAudio: true };
    render(<Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} screens={[shown]} acts={acts} />);
    expect(screen.queryByRole("tab", { name: /3D-сцена/ })).toBeNull();
    cleanup();

    usePrefs.setState({ stage3d: true });
    const view = render(<Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} screens={[shown]} acts={acts} />);
    fireEvent.click(screen.getByRole("tab", { name: /3D-сцена/ }));
    view.rerender(<Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} screens={[]} acts={acts} />);
    view.rerender(<Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} screens={[shown]} acts={acts} />);
    expect(screen.getByRole("figure", { name: "Экран: Петя" })).toBeTruthy();
  });
});

describe("the stage while watching together", () => {
  const watch = {
    state: { url: "https://files.example/film.mp4", playing: true, pos: 0, at: 0, by: "p1", picks: {} },
    me: "me00",
    serverNow: () => 0,
    start: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    choose: vi.fn(),
    adopt: vi.fn(),
  };
  const anna = { identity: "p1", mine: false, on: true, take: false, title: "Трек", artist: null, app: null, cover: null };

  it("goes to the watching, the 3D stage and a friend's music, one click each; the watching only steps back", () => {
    usePrefs.setState({ stage3d: true });
    const { container } = render(
      <Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} acts={acts} watch={watch} music={{ playing: anna, nameOf: () => "Петя", onStop: vi.fn() }} />,
    );
    const cinema = () => container.querySelector(".cinema");
    expect(screen.getByRole("tab", { name: /Просмотр/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /3D-сцена/ }));
    expect(screen.getByTestId("scene").getAttribute("data-paused")).toBe("no");
    expect(cinema()?.classList.contains("parked"), "still there, only hidden: the video goes on").toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: /Музыка/ }));
    expect(screen.getByRole("tab", { name: /Музыка/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /3D-сцена/ }));
    expect(screen.getByRole("tab", { name: /3D-сцена/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Слушают все в звонке"), "out of the music").toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Просмотр/ }));
    expect(cinema()?.classList.contains("parked")).toBe(false);
  });
});
