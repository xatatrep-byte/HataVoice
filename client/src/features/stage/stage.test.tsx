// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePrefs } from "../../state/prefs";
import { DEFAULT_APPEARANCE } from "../../theme/appearance";
import { NO_CALL, type CallSecurity } from "../../voice/callSecurity";
import type { ParticipantView } from "../../voice/participants";
import { Dock } from "./Dock";
import { Stage } from "./Stage";
import { Tile } from "./Tile";

// The 3D canvas as a stand-in that says whether it draws (jsdom has no WebGL); with `noWebGl.on` it fails as a PC without
// 3D does.
const noWebGl = vi.hoisted(() => ({ on: false }));
vi.mock("../../characters/CharacterCanvas", async () => {
  const { useEffect } = await import("react");
  return {
    CharacterCanvas: ({ paused, onFail }: { paused?: boolean; onFail?: () => void }) => {
      useEffect(() => {
        // As the real one: three.js comes first, then the renderer fails.
        if (!noWebGl.on) return;
        const timer = setTimeout(() => onFail?.(), 0);
        return () => clearTimeout(timer);
      }, [onFail]);
      return <canvas data-testid="scene" data-paused={paused ? "yes" : "no"} />;
    },
  };
});

afterEach(() => {
  cleanup();
  usePrefs.setState({ appearance: { ...DEFAULT_APPEARANCE } });
});

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

const secure: CallSecurity = { state: "secure", code: "12345 67890 00042 99999 01234 55555", members: ["me00", "p1"], error: null };
const pending: CallSecurity = { ...NO_CALL, state: "pending" };

describe("Dock", () => {
  const props = () => ({
    micOn: true,
    transmitting: false,
    deafened: false,
    micLevel: 0,
    security: secure,
    onToggleMic: vi.fn(),
    onToggleDeafen: vi.fn(),
    onLeave: vi.fn(),
  });

  it("toggles the mic and leaves the channel", () => {
    const p = props();
    render(<Dock {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Выключить микрофон" }));
    expect(p.onToggleMic).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Выйти из комнаты" }));
    expect(p.onLeave).toHaveBeenCalledTimes(1);
  });

  it("shows deafen as pressed and offers to turn sound back on", () => {
    render(<Dock {...props()} deafened />);
    const button = screen.getByRole("button", { name: "Включить звук" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("changes the voice from «⋯», in the call", () => {
    const onVoicePreset = vi.fn();
    render(<Dock {...props()} voicePreset="none" onVoicePreset={onVoicePreset} />);
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Смена голоса/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Робот/ }));
    expect(onVoicePreset).toHaveBeenCalledWith("robot");
    expect(screen.queryByRole("dialog", { name: "Смена голоса" }), "the menu closes").toBeNull();
  });

  it("shows the screen only with the right, once the keys are here, and stops it", () => {
    const onToggleScreen = vi.fn();
    const { rerender } = render(<Dock {...props()} onToggleScreen={onToggleScreen} />);
    expect(screen.queryByRole("button", { name: "Показать экран" }), "no stream right, no button").toBeNull();
    rerender(<Dock {...props()} canShare security={pending} onToggleScreen={onToggleScreen} />);
    expect((screen.getByRole("button", { name: "Показать экран: ждём ключи шифрования" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<Dock {...props()} canShare onToggleScreen={onToggleScreen} />);
    fireEvent.click(screen.getByRole("button", { name: "Показать экран" }));
    expect(onToggleScreen).toHaveBeenCalledOnce();
    rerender(<Dock {...props()} canShare sharing onToggleScreen={onToggleScreen} />);
    expect(screen.getByRole("button", { name: "Остановить демонстрацию" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("asks the size and the frames of the screen in a panel first, like a quick setting, then lets Windows ask what to show", () => {
    const onToggleScreen = vi.fn();
    const onChange = vi.fn();
    const settings = { resolution: "1080", fps: "60", codec: "h264", audio: true } as const;
    const { rerender } = render(<Dock {...props()} canShare onToggleScreen={onToggleScreen} screen={{ settings, onChange }} />);
    fireEvent.click(screen.getByRole("button", { name: "Показать экран" }));
    expect(onToggleScreen, "the button opens the panel, not the capture").not.toHaveBeenCalled();
    const panel = screen.getByRole("dialog", { name: "Демонстрация экрана" });
    fireEvent.click(screen.getByRole("button", { name: "1440p" }));
    expect(onChange).toHaveBeenCalledWith({ resolution: "1440" });
    fireEvent.click(screen.getByRole("button", { name: "30" }));
    expect(onChange).toHaveBeenCalledWith({ fps: "30" });
    expect(panel.textContent).not.toContain("сильного ПК");
    fireEvent.click(screen.getByRole("button", { name: /Выбрать экран или окно/ }));
    expect(onToggleScreen).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Демонстрация экрана" }), "the panel goes").toBeNull();
    // While it is on, the button stops it at once.
    rerender(<Dock {...props()} canShare sharing onToggleScreen={onToggleScreen} screen={{ settings, onChange }} />);
    fireEvent.click(screen.getByRole("button", { name: "Остановить демонстрацию" }));
    expect(onToggleScreen).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog", { name: "Демонстрация экрана" })).toBeNull();
  });

  it("turns the camera on and off with its key, and picks which camera and how in a panel beside it", () => {
    const onToggle = vi.fn();
    const onChange = vi.fn();
    const settings = { deviceId: "default", quality: "720", mirror: true, facing: "user" } as const;
    const devices = [{ deviceId: "cam-1", kind: "videoinput", label: "HD Webcam C270 (046d:0825)", groupId: "" }] as MediaDeviceInfo[];
    const camera = (over = {}) => ({ on: false, settings, devices, onToggle, onChange, ...over });
    const { rerender } = render(<Dock {...props()} camera={camera()} security={pending} />);
    expect((screen.getByRole("button", { name: "Камера: ждём ключи шифрования" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<Dock {...props()} camera={camera()} />);
    fireEvent.click(screen.getByRole("button", { name: "Включить камеру" }));
    expect(onToggle).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Какая камера и качество" }));
    const panel = screen.getByRole("dialog", { name: "Камера" });
    fireEvent.change(screen.getByRole("combobox", { name: "Устройство" }), { target: { value: "cam-1" } });
    expect(onChange).toHaveBeenCalledWith({ deviceId: "cam-1" });
    expect(panel.textContent).toContain("HD Webcam C270");
    fireEvent.click(screen.getByRole("button", { name: "1080p" }));
    expect(onChange).toHaveBeenCalledWith({ quality: "1080" });
    // On: the key turns it off, pressed.
    rerender(<Dock {...props()} camera={camera({ on: true })} />);
    const off = screen.getByRole("button", { name: "Выключить камеру" });
    expect(off.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(off);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("on a phone picks the front or the back camera and turns it round in the call", () => {
    const onChange = vi.fn();
    const settings = { deviceId: "default", quality: "720", mirror: true, facing: "user" } as const;
    const camera = { on: true, settings, devices: [], onToggle: vi.fn(), onChange, phone: true };
    render(<Dock {...props()} camera={camera} />);
    fireEvent.click(screen.getByRole("button", { name: "Задняя камера" }));
    expect(onChange).toHaveBeenCalledWith({ facing: "environment" });
    fireEvent.click(screen.getByRole("button", { name: "Какая камера и качество" }));
    expect(screen.queryByRole("combobox", { name: "Устройство" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Задняя" }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("on a phone with push-to-talk speaks while the key on the screen is held", () => {
    const press = vi.fn();
    const release = vi.fn();
    const { rerender } = render(<Dock {...props()} talk={{ open: false, press, release }} />);
    const key = screen.getByRole("button", { name: "Говорить, пока держишь" });
    fireEvent.pointerDown(key, { pointerId: 1 });
    expect(press).toHaveBeenCalledOnce();
    fireEvent.pointerUp(key, { pointerId: 1 });
    expect(release).toHaveBeenCalledOnce();
    rerender(<Dock {...props()} talk={{ open: true, press, release }} />);
    expect(screen.getByRole("button", { name: "Говорить, пока держишь" }).getAttribute("aria-pressed")).toBe("true");
    // A finger that slides off (the system takes the touch) lets go too.
    fireEvent.pointerCancel(screen.getByRole("button", { name: "Говорить, пока держишь" }), { pointerId: 1 });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("mic waits for the keys", () => {
    const p = props();
    render(<Dock {...p} security={pending} />);
    const mic = screen.getByRole("button", { name: "Ждём ключи шифрования" }) as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    fireEvent.click(mic);
    expect(p.onToggleMic).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Выключить микрофон" })).toBeNull();
  });

  it("makes the mic wait only while the keys are pending", () => {
    for (const security of [secure, { ...NO_CALL, state: "failed" as const, error: "Не удалось зашифровать звонок" }]) {
      const { unmount } = render(<Dock {...props()} security={security} />);
      expect(screen.queryByRole("button", { name: "Ждём ключи шифрования" })).toBeNull();
      unmount();
    }
  });

  it("has only the keys a call needs in sight; the rest is behind «⋯»", () => {
    render(<Dock {...props()} canShare chat={{ open: false, unread: 3, mentions: 0, onToggle: vi.fn() }} voicePreset="none" onVoicePreset={vi.fn()} onEmote={vi.fn()} onSound={vi.fn()} onWatch={vi.fn()} onToggleStage3d={vi.fn()} />);
    const keys = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(keys).toEqual(["Выключить микрофон", "Выключить звук", "Показать экран", "Чат комнаты, новых: 3", "Ещё", "Выйти из комнаты"]);
  });

  it("the room's chat key opens the chat and shows what is unread there", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Dock {...props()} chat={{ open: false, unread: 0, mentions: 2, onToggle }} />);
    fireEvent.click(screen.getByRole("button", { name: "Чат комнаты, новых: @2" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<Dock {...props()} chat={{ open: true, unread: 0, mentions: 0, onToggle }} />);
    expect(screen.getByRole("button", { name: "Чат комнаты" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("«Изменить персонажа» and «Запись и стрим» lead out of the call and close the menu", () => {
    const onEditCharacter = vi.fn();
    const onStudio = vi.fn();
    render(<Dock {...props()} onEditCharacter={onEditCharacter} onStudio={onStudio} />);
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Изменить персонажа/ }));
    expect(onEditCharacter).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Запись и стрим" }));
    expect(onStudio).toHaveBeenCalledTimes(1);
  });

  it("a submenu has its way back", () => {
    render(<Dock {...props()} onSound={vi.fn(() => true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Звуковая панель/ }));
    expect(screen.getByRole("dialog", { name: "Звуковая панель" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByRole("menu", { name: "Ещё" })).toBeTruthy();
  });

  it("the first call says once where the rest went; «Понятно» or opening «⋯» puts it away", () => {
    const onHintDone = vi.fn();
    const { rerender } = render(<Dock {...props()} hint onHintDone={onHintDone} />);
    expect(screen.getByRole("note").textContent).toContain("Всё остальное здесь");
    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(onHintDone).toHaveBeenCalledTimes(1);
    rerender(<Dock {...props()} hint onHintDone={onHintDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    expect(onHintDone).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("Tile", () => {
  it("uses smaller avatars in compact mode", () => {
    const avatarWidth = () => {
      const { container } = render(
        <Tile participant={person()} volume={{ volume: 1, muted: false }} onVolumeChange={() => {}} />,
      );
      const width = (container.querySelector(".avatar") as HTMLElement).style.width;
      cleanup();
      return width;
    };
    expect(avatarWidth()).toBe("88px");
    usePrefs.setState({ appearance: { ...DEFAULT_APPEARANCE, compact: true } });
    expect(avatarWidth()).toBe("56px");
  });

  it("keeps the full nickname in the tooltip", () => {
    const long = "Очень-длинный-ник-который-не-влезет-в-плитку";
    const { container } = render(
      <Tile participant={person({ name: long })} volume={{ volume: 1, muted: false }} onVolumeChange={() => {}} />,
    );
    expect(container.querySelector(`[title="${long}"]`)).not.toBeNull();
  });

  it("opens volume controls for others and reports changes", () => {
    const onVolumeChange = vi.fn();
    render(<Tile participant={person()} volume={{ volume: 1, muted: false }} onVolumeChange={onVolumeChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Петя — громкость" }));
    fireEvent.change(screen.getByLabelText("Громкость"), { target: { value: "150" } });
    expect(onVolumeChange).toHaveBeenCalledWith(person().identity, { volume: 1.5 });
  });

  it("has no volume menu on your own tile", () => {
    render(
      <Tile participant={person({ isLocal: true })} volume={{ volume: 1, muted: false }} onVolumeChange={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Петя — громкость" })).toBeNull();
    expect(screen.queryByLabelText("Громкость")).toBeNull();
  });
});

describe("a camera on the tile", () => {
  const video = () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as NonNullable<ParticipantView["camera"]>;

  it("shows a friend's camera instead of the face, and ours as in a mirror unless that is off", () => {
    const friend = video();
    const own = video();
    const { container } = render(
      <Stage participants={[person({ identity: "me00", name: "Я", isLocal: true, camera: own }), person({ camera: friend })]} volumes={{}} security={secure} onVolumeChange={vi.fn()} />,
    );
    expect(friend.attach).toHaveBeenCalled();
    expect(own.attach).toHaveBeenCalled();
    const pictures = container.querySelectorAll("video.tile-camera");
    expect(pictures).toHaveLength(2);
    expect(container.querySelectorAll("video.tile-camera.mirrored"), "only ours").toHaveLength(1);
    cleanup();
    usePrefs.setState({ camera: { deviceId: "default", quality: "720", mirror: false, facing: "user" } });
    const again = render(<Stage participants={[person({ identity: "me00", isLocal: true, camera: video() })]} volumes={{}} security={secure} onVolumeChange={vi.fn()} />);
    expect(again.container.querySelector("video.tile-camera.mirrored")).toBeNull();
    usePrefs.setState({ camera: { deviceId: "default", quality: "720", mirror: true, facing: "user" } });
  });

  it("a camera is there to be seen: the cameras come first, the 3D stage waits behind and comes in front by its tab", () => {
    usePrefs.setState({ stage3d: true });
    const acts = { acts: [], perform: vi.fn(() => true) };
    const { container } = render(
      <Stage participants={[person({ isLocal: true, identity: "me00" }), person({ camera: video() })]} volumes={{}} security={secure} onVolumeChange={vi.fn()} acts={acts} />,
    );
    expect(container.querySelector(".character-stage.parked"), "loaded, drawing nothing").not.toBeNull();
    expect(container.querySelector(".stage-grid.strip")).toBeNull();
    expect(container.querySelector("video.tile-camera")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /3D-сцена/ }));
    expect(container.querySelector(".stage.with-characters")).not.toBeNull();
    expect(screen.getByTestId("scene").dataset.paused).toBe("no");
    expect(container.querySelector(".stage-grid.strip video.tile-camera"), "the cameras small along the bottom").not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Камеры/ }));
    expect(container.querySelector(".stage-grid.strip")).toBeNull();
    expect(screen.getByTestId("scene").dataset.paused).toBe("yes");
  });

  it("over a shared screen a camera is a small picture, not a chip", () => {
    const screenTrack = { attach: vi.fn(), detach: vi.fn() } as unknown as NonNullable<import("../../voice/screen").ScreenView["track"]>;
    const shown = { identity: "p1", isLocal: false, track: screenTrack, watching: true, hasAudio: false };
    const { container } = render(
      <Stage participants={[person({ isLocal: true, identity: "me00" }), person({ camera: video() })]} volumes={{}} security={secure} onVolumeChange={vi.fn()} screens={[shown]} />,
    );
    expect(container.querySelector(".tile.small.with-camera video.tile-camera")).not.toBeNull();
  });
});

describe("Stage", () => {
  const stage = (security: CallSecurity, people: ParticipantView[]) =>
    render(<Stage participants={people} volumes={{}} onVolumeChange={() => {}} security={security} />);
  const me = person({ identity: "me00", name: "Я", isLocal: true });
  const outsider = person({ identity: "x1", name: "Гость", encrypted: false });

  it("marks a person outside the call group", () => {
    stage(secure, [me, person(), outsider]);
    const marks = screen.getAllByText("не в шифровании");
    expect(marks).toHaveLength(1);
    // The mark sits on the outsider's tile, with the reason.
    const tile = marks[0]!.closest(".tile") as HTMLElement;
    expect(tile.textContent).toContain("Гость");
    expect(marks[0]!.getAttribute("title")).toBe("Не слышно: нет ключей этого звонка");
  });

  it("marks nobody while the keys are still on their way", () => {
    // Everyone reads as outside the group until the group is known.
    stage(pending, [person({ isLocal: true, encrypted: false }), outsider]);
    expect(screen.queryByText("не в шифровании")).toBeNull();
  });

  it("never marks you", () => {
    stage(secure, [person({ isLocal: true, encrypted: false })]);
    expect(screen.queryByText("не в шифровании")).toBeNull();
  });
});

describe("shared screens", () => {
  const security: CallSecurity = { ...NO_CALL, state: "secure", members: ["p1", "me00"] };
  const track = () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as NonNullable<import("../../voice/screen").ScreenView["track"]>;
  const people = [person({ identity: "me00", name: "Я", isLocal: true }), person()];

  it("shows the screen big with its own volume, and closes it", () => {
    const onWatchScreen = vi.fn();
    const onVolumeChange = vi.fn();
    const shown = { identity: "p1", isLocal: false, track: track(), watching: true, hasAudio: true };
    render(<Stage participants={people} volumes={{}} security={security} onVolumeChange={onVolumeChange} screens={[shown]} onWatchScreen={onWatchScreen} />);
    expect(screen.getByRole("figure", { name: "Экран: Петя" })).toBeTruthy();
    expect(shown.track.attach).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("slider", { name: "Громкость демонстрации" }), { target: { value: "50" } });
    expect(onVolumeChange).toHaveBeenCalledWith("screen:p1", { volume: 0.5 });
    fireEvent.click(screen.getByRole("button", { name: "Развернуть" }));
    expect(screen.getByRole("button", { name: "Свернуть" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть демонстрацию" }));
    expect(onWatchScreen).toHaveBeenCalledWith("p1", false);
  });

  it("a closed screen can be watched again; our own, opened, has no volume and hides again", () => {
    const onWatchScreen = vi.fn();
    const closed = { identity: "p1", isLocal: false, track: null, watching: false, hasAudio: true };
    const own = { identity: "me00", isLocal: true, track: track(), watching: true, hasAudio: false };
    render(<Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} screens={[own, closed]} onWatchScreen={onWatchScreen} />);
    expect(screen.getByRole("figure", { name: "Твой экран" })).toBeTruthy();
    expect(screen.queryByRole("slider", { name: "Громкость демонстрации" })).toBeNull();
    expect(screen.getByText(/Петя показывает экран/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Смотреть" }));
    expect(onWatchScreen).toHaveBeenCalledWith("p1", true);
    fireEvent.click(screen.getByRole("button", { name: "Скрыть свой экран" }));
    expect(onWatchScreen).toHaveBeenCalledWith("me00", false);
  });

  it("says on a friend's picture why it froze: a game in full screen, and what to switch", () => {
    const frozen = { identity: "p1", isLocal: false, track: track(), watching: true, hasAudio: false, frozen: true };
    render(<Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} screens={[frozen]} />);
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("Кадр застыл.");
    expect(note.textContent).toContain("Петя играет на весь экран");
    expect(note.textContent).toContain("«оконный без рамки»");
  });

  it("our own screen is a line, not half the stage, until we open it", () => {
    const onWatchScreen = vi.fn();
    const own = { identity: "me00", isLocal: true, track: null, watching: false, hasAudio: false };
    const { container } = render(<Stage participants={people} volumes={{}} security={security} onVolumeChange={() => {}} screens={[own]} onWatchScreen={onWatchScreen} />);
    expect(screen.queryByRole("figure", { name: "Твой экран" })).toBeNull();
    expect(container.querySelector(".stage.with-screen")).toBeNull();
    expect(screen.getByText(/Ты показываешь экран/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Посмотреть" }));
    expect(onWatchScreen).toHaveBeenCalledWith("me00", true);
  });
});


describe("3D characters in the call", () => {
  const dock = () => ({
    micOn: true,
    transmitting: false,
    deafened: false,
    micLevel: 0,
    security: secure,
    onToggleMic: vi.fn(),
    onToggleDeafen: vi.fn(),
    onLeave: vi.fn(),
  });

  it("«⋯» makes our character wave, and hides or shows the characters", () => {
    const onEmote = vi.fn();
    const onToggleStage3d = vi.fn();
    render(<Dock {...dock()} onEmote={onEmote} stage3d onToggleStage3d={onToggleStage3d} />);
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Эмоции персонажа/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Помахать/ }));
    expect(onEmote).toHaveBeenCalledWith("wave");
    expect(screen.queryByRole("dialog", { name: "Эмоции персонажа" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    const scene = screen.getByRole("menuitemcheckbox", { name: "3D-сцена" });
    expect(scene.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(scene);
    expect(onToggleStage3d).toHaveBeenCalledTimes(1);
  });

  it("a PC that cannot draw 3D gets the usual tiles", async () => {
    usePrefs.setState({ stage3d: true });
    noWebGl.on = true;
    const acts = { acts: [], perform: vi.fn(() => true) };
    const { container } = render(
      <Stage participants={[person({ isLocal: true, identity: "me00" }), person()]} volumes={{}} security={secure} onVolumeChange={vi.fn()} acts={acts} />,
    );
    expect(container.querySelector(".stage-grid.strip")).not.toBeNull();
    // jsdom has no WebGL: the scene cannot start, and the stage goes back to big tiles.
    await vi.waitFor(() => expect(container.querySelector(".character-stage")).toBeNull());
    expect(container.querySelector(".stage-grid.strip")).toBeNull();
    noWebGl.on = false;
  });
});
