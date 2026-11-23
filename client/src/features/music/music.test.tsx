// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePrefs } from "../../state/prefs";
import { NO_CALL, type CallSecurity } from "../../voice/callSecurity";
import type { ParticipantView } from "../../voice/participants";
import type { MusicNow } from "../../music/useMusic";
import type { SoundSource } from "../../music/api";
import { Dock } from "../stage/Dock";
import { Stage } from "../stage/Stage";
import { MusicCorner } from "./MusicMini";
import { MusicSettingsBlock } from "./MusicSettings";
import { MusicStartDialog } from "./MusicStartDialog";

vi.mock("../../characters/CharacterCanvas", () => ({ CharacterCanvas: () => <canvas data-testid="scene" /> }));
vi.mock("../../music/cover", () => ({ coverColor: async () => null, coverToJpeg: async () => null }));

afterEach(() => {
  cleanup();
  usePrefs.setState({ musicMini: true, musicDuck: true, musicVolume: 1, musicSend: 1, musicMuted: false });
});

const anna: MusicNow = { identity: "anna", mine: false, on: true, take: false, title: "Ночной трамвай", artist: "Город спит", app: "Яндекс Музыка", cover: null };
const nameOf = (id: string) => (id === "anna" ? "Аня" : id);

function corner(over: Partial<Parameters<typeof MusicCorner>[0]> = {}) {
  const props = { playing: anna, nameOf, onStop: vi.fn(), onChange: vi.fn(), ...over };
  return { ...render(<MusicCorner {...props} />), props };
}

describe("the mini-player", () => {
  it("shows nothing without music", () => {
    const { container } = corner({ playing: null });
    expect(container.textContent).toBe("");
  });

  it("shows what plays and whose it is", () => {
    corner();
    expect(screen.getByText("Ночной трамвай")).toBeTruthy();
    expect(screen.getByText("Город спит")).toBeTruthy();
  });

  it("has the music's volume right on it, no click needed, for any friend's music", () => {
    corner();
    fireEvent.change(screen.getByLabelText("Громкость музыки"), { target: { value: "50" } });
    expect(usePrefs.getState().musicVolume).toBe(0.5);
  });

  it("a friend's music can be left: a click on the speaker, or «Не слушать» in its settings", () => {
    corner();
    fireEvent.click(screen.getByRole("button", { name: "Не слушать эту музыку" }));
    expect(usePrefs.getState().musicMuted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Слушать музыку" }));
    expect(usePrefs.getState().musicMuted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Настройки музыки" }));
    fireEvent.click(screen.getByText("Не слушать"));
    expect(usePrefs.getState().musicMuted).toBe(true);
  });

  it("our own music: how loud everyone hears it, right on it", () => {
    corner({ playing: { ...anna, identity: "me", mine: true } });
    expect(screen.queryByLabelText("Громкость музыки"), "our own music is not played back to us").toBeNull();
    fireEvent.change(screen.getByLabelText("Громкость для всех"), { target: { value: "70" } });
    expect(usePrefs.getState().musicSend).toBe(0.7);
  });

  it("opens to its settings: «Тише, когда говорят», who plays it; ours can be stopped or changed there", () => {
    const { props } = corner();
    fireEvent.click(screen.getByRole("button", { name: "Настройки музыки" }));
    expect(screen.getByText(/Музыку включает Аня · Яндекс Музыка/)).toBeTruthy();
    fireEvent.click(screen.getByText("Тише, когда говорят"));
    expect(usePrefs.getState().musicDuck).toBe(false);
    expect(screen.queryByRole("button", { name: "Остановить для всех" }), "a friend's music is theirs to stop").toBeNull();
    expect(props.onStop).not.toHaveBeenCalled();
    cleanup();
    const mine = corner({ playing: { ...anna, identity: "me", mine: true } });
    fireEvent.click(screen.getByRole("button", { name: /Ночной трамвай/ }));
    fireEvent.click(screen.getByRole("button", { name: "Сменить программу" }));
    expect(mine.props.onChange).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Настройки музыки" }), "closed for the program picker").toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Настройки музыки" }));
    fireEvent.click(screen.getByRole("button", { name: "Остановить для всех" }));
    expect(mine.props.onStop).toHaveBeenCalled();
  });

  it("hides, and a ♪ in its place brings it back", () => {
    corner();
    fireEvent.click(screen.getByRole("button", { name: "Скрыть плеер" }));
    expect(usePrefs.getState().musicMini).toBe(false);
    expect(screen.queryByText("Ночной трамвай")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Показать плеер музыки" }));
    expect(usePrefs.getState().musicMini).toBe(true);
    expect(screen.getByText("Ночной трамвай")).toBeTruthy();
  });
});

describe("«Включить музыку для всех»", () => {
  const sources: SoundSource[] = [
    { pid: 1, name: "Яндекс Музыка", exe: "Яндекс Музыка.exe", level: 0.6, active: true },
    { pid: 2, name: "Spotify", exe: "Spotify.exe", level: 0, active: false },
  ];

  it("lists the programs playing sound, those playing now first, and plays the one picked", async () => {
    const onStart = vi.fn(async () => null);
    const onClose = vi.fn();
    render(<MusicStartDialog open onClose={onClose} sources={async () => sources} other={null} onStart={onStart} />);
    await waitFor(() => expect(screen.getByText("Яндекс Музыка")).toBeTruthy());
    const rows = screen.getAllByRole("radio");
    expect(rows[0]!.textContent).toContain("Яндекс Музыка");
    fireEvent.click(screen.getByText("Spotify"));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /Включить/ })));
    expect(onStart).toHaveBeenCalledWith(sources[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it("asks first when a friend's music plays", async () => {
    render(<MusicStartDialog open onClose={vi.fn()} sources={async () => sources} other="Аня" onStart={vi.fn(async () => null)} />);
    await waitFor(() => expect(screen.getByText(/У Аня уже играет музыка|Аня уже включает музыку/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Включить вместо/ })).toBeTruthy();
  });

  it("says what went wrong and stays open", async () => {
    const onClose = vi.fn();
    render(<MusicStartDialog open onClose={onClose} sources={async () => sources} other={null} onStart={async () => "Сервер не разрешает музыку — его нужно обновить"} />);
    await waitFor(() => expect(screen.getByText("Яндекс Музыка")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /Включить/ })));
    expect(screen.getByText("Сервер не разрешает музыку — его нужно обновить")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the «Музыка» tab", () => {
  const security: CallSecurity = { ...NO_CALL, state: "secure", members: ["me00", "anna"] };
  const people: ParticipantView[] = [
    { identity: "me00", name: "Я", speaking: false, muted: false, isLocal: true, quality: "good", level: 0, deafened: false, color: "blue", encrypted: true },
    { identity: "anna", name: "Аня", speaking: false, muted: false, isLocal: false, quality: "good", level: 0, deafened: false, color: "blue", encrypted: true, music: true },
  ];
  const stage = (music: MusicNow | null) => (
    <Stage participants={people} volumes={{}} security={security} onVolumeChange={vi.fn()} music={music ? { playing: music, nameOf, onStop: vi.fn(), onChange: vi.fn() } : null} />
  );

  it("is there while music plays, shows it big, and goes with it", () => {
    const { rerender } = render(stage(anna));
    const tab = screen.getByRole("tab", { name: /Музыка/ });
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Ночной трамвай")).toBeTruthy();
    expect(screen.getByText(/Слушают/)).toBeTruthy();
    rerender(stage(null));
    expect(screen.queryByRole("tab", { name: /Музыка/ })).toBeNull();
    expect(screen.queryByText("Ночной трамвай")).toBeNull();
  });

  it("has every setting of the music in sight", () => {
    render(stage(anna));
    fireEvent.click(screen.getByRole("tab", { name: /Музыка/ }));
    fireEvent.change(screen.getByLabelText("Громкость музыки"), { target: { value: "130" } });
    expect(usePrefs.getState().musicVolume).toBe(1.3);
    expect(screen.getByText("Тише, когда говорят")).toBeTruthy();
    fireEvent.click(screen.getByText("Мини-плеер над кнопками звонка"));
    expect(usePrefs.getState().musicMini).toBe(false);
  });
});

describe("music in the settings", () => {
  it("keeps the music's volume, «Тише, когда говорят», the mini-player and how loud our own goes", () => {
    render(<MusicSettingsBlock dj />);
    fireEvent.change(screen.getByLabelText("Громкость музыки друзей"), { target: { value: "40" } });
    expect(usePrefs.getState().musicVolume).toBe(0.4);
    fireEvent.change(screen.getByLabelText("Громкость моей музыки для всех"), { target: { value: "120" } });
    expect(usePrefs.getState().musicSend).toBe(1.2);
    fireEvent.click(screen.getByText("Тише, когда говорят"));
    expect(usePrefs.getState().musicDuck).toBe(false);
    cleanup();
    render(<MusicSettingsBlock dj={false} />);
    expect(screen.queryByLabelText("Громкость моей музыки для всех"), "a phone only listens").toBeNull();
  });
});

describe("the ♪ in the call's buttons", () => {
  it("opens the start dialog, and stops our own music while it plays", () => {
    const onToggle = vi.fn();
    const base = { micOn: true, deafened: false, transmitting: false, onToggleMic: vi.fn(), onToggleDeafen: vi.fn(), security: NO_CALL, onLeave: vi.fn() } as unknown as ComponentProps<typeof Dock>;
    const { rerender } = render(<Dock {...base} music={{ on: false, onToggle }} />);
    fireEvent.click(screen.getByRole("button", { name: "Музыка для всех" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<Dock {...base} music={{ on: true, onToggle }} />);
    fireEvent.click(screen.getByRole("button", { name: "Остановить музыку" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
