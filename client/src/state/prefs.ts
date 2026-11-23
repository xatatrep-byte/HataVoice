import { create } from "zustand";
import { parseAppearance, type Appearance } from "../theme/appearance";
import { NOTIFY_MODES, type NotifyMode } from "../chat/notify";
import { DEFAULT_SCREEN, OLD_SCREEN_PRESETS, SCREEN_CODECS, SCREEN_FPS, SCREEN_RESOLUTIONS, type ScreenSettings } from "../voice/screen";
import { CAMERA_FACINGS, CAMERA_QUALITIES, DEFAULT_CAMERA, type CameraSettings } from "../voice/camera";
import type { StreamerMode } from "./streamer";
import { knownFrame, type FrameId } from "../ui/frames";
import { parseCharacter } from "../characters/character";
import { parseAvatar } from "../characters/gallery";
import { clampSize, DEFAULT_SIZE, type Spot } from "../characters/overlay";
import { parseStageLook, type StageLook } from "../characters/stageLook";

const STREAMER: readonly StreamerMode[] = ["off", "on", "auto"];
import { isRecord, loadJson, saveJson } from "./persist";

export type AvatarColor = "blue" | "violet" | "green" | "orange" | "pink" | "teal" | "red" | "yellow";

export const AVATAR_COLORS: readonly AvatarColor[] = ["blue", "violet", "green", "orange", "pink", "teal", "red", "yellow"];

/** A named avatar color, or any color of one's own as `#rrggbb` (it travels in the signed profile). */
export type ProfileColor = AvatarColor | string;

/** The color as stored, if it is one: a named one or `#rrggbb`. */
export function parseProfileColor(raw: unknown): ProfileColor | null {
  if (AVATAR_COLORS.includes(raw as AvatarColor)) return raw as AvatarColor;
  return typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : null;
}
export const MAX_NICKNAME_CHARS = 32;

const STORAGE_KEY = "hatavoice.prefs";
/** Where step 2 kept the nickname; read once for a smooth upgrade. */
const LEGACY_NICKNAME_KEY = "hatavoice.nickname";

export type Prefs = {
  nickname: string;
  color: ProfileColor;
  /** The frame around our avatar (see `ui/frames.ts`); null — none. */
  frame: FrameId | null;
  /** Our 3D character as its code (see `characters/character.ts`); null — one made from our color. */
  character: string | null;
  /** «3D-персонажи в звонке»: the call's stage shows everyone's characters together. */
  stage3d: boolean;
  /** Where they stand: «Студия», «Закат» or «Ночь». */
  stageLook: StageLook;
  /** «Персонажи на рабочем столе»: in a call, the characters stand over other apps too. */
  overlay: boolean;
  /** Where each person's character stands there (by user id), and how tall they all are. */
  overlaySpots: Record<string, Spot>;
  overlaySize: number;
  /** Music played together: the mini-player above the call's buttons is shown (a ♪ brings a hidden one back). */
  musicMini: boolean;
  /** «Тише, когда говорят»: friends' music goes down while someone speaks. */
  musicDuck: boolean;
  /** How loud friends' music plays here, whoever plays it: 0–2. */
  musicVolume: number;
  /** How loud everyone hears the music we play: 0–1.5 (louder is clipped at full scale). */
  musicSend: number;
  /** «Не слушать»: the friend's music playing now is not heard here (back on when that music ends; not saved). */
  musicMuted: boolean;
  /** Notice invites copied to the clipboard. */
  clipboardInvites: boolean;
  /** On start, go into the voice channel we were last in. */
  autoJoin: boolean;
  /** That channel, for each server. */
  lastChannels: Record<string, string>;
  appearance: Appearance;
  onboarded: boolean;
  /** «Показывать, во что я играю». */
  showGame: boolean;
  /** Games the built-in list misses: exe name and the title friends see. */
  customGames: CustomGame[];
  /** Windows notifications about the chat. */
  notifyMode: NotifyMode;
  /** The text of a message in its notification (off: «Новое сообщение»). */
  notifyText: boolean;
  /** How our screen goes out: size, frames, codec, the computer's sound. */
  screen: ScreenSettings;
  /** The person chose the codec themselves: from then on it is never chosen for them by the video card again. */
  codecPicked: boolean;
  /** The banner over every window while someone controls this PC or plays on it with a pad. */
  remoteBanner: boolean;
  /** Our webcam in a call: which one, how big, mirrored here or not. */
  camera: CameraSettings;
  /** The streamer mode: off, on, or on by itself while OBS runs. */
  streamer: StreamerMode;
  /** The panel of chats and people stays beside the page instead of sliding out. */
  drawerPinned: boolean;
  /** One-time hints already seen (their ids). */
  seenHints: string[];
  /** Android: the call goes on in a small window over other apps when the person leaves the app. */
  phonePip: boolean;
  /** Android: where the call is heard (see `PHONE_ROUTES`). */
  phoneRoute: PhoneRoute;
  /** Android: a key of the phone (or of a headset, a keyboard) held for push-to-talk, as Android names it. */
  phonePttKey: string | null;
  /** Android: the screen's quality was set once to what a phone carries (720p, 30 frames), or chosen by the person. */
  phoneScreenSet: boolean;
  /** Android: the app keeps running in the background (a quiet notification), so chat messages are told while it is away. */
  phoneOnline: boolean;
};

/** Where a phone plays the call: as the system decides, the earpiece, the loudspeaker, a headset. */
export type PhoneRoute = "auto" | "earpiece" | "speaker" | "wired" | "bluetooth" | "usb";
export const PHONE_ROUTES: readonly PhoneRoute[] = ["auto", "earpiece", "speaker", "wired", "bluetooth", "usb"];
export const PHONE_ROUTE_LABELS: Record<PhoneRoute, string> = {
  auto: "Как решит телефон",
  earpiece: "Разговорный динамик",
  speaker: "Громкая связь",
  wired: "Проводные наушники",
  bluetooth: "Bluetooth",
  usb: "USB-наушники",
};

/** A key as Android names it (`KEYCODE_VOLUME_DOWN`), nothing else. */
export function parsePhoneKey(raw: unknown): string | null {
  return typeof raw === "string" && /^KEYCODE_[A-Z0-9_]{1,40}$/.test(raw) ? raw : null;
}

function parseLastChannels(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const MAX_SPOTS = 200;

/** The places kept for people: two numbers 0–1 each, for at most a couple of hundred people. */
function parseSpots(raw: unknown): Record<string, Spot> {
  if (!isRecord(raw)) return {};
  const spots: Record<string, Spot> = {};
  for (const [id, spot] of Object.entries(raw).slice(0, MAX_SPOTS)) {
    if (Array.isArray(spot) && spot.length === 2 && spot.every((n) => typeof n === "number" && n >= 0 && n <= 1)) spots[id] = [spot[0], spot[1]];
  }
  return spots;
}

function parseScreen(raw: unknown): ScreenSettings {
  const s = isRecord(raw) ? raw : {};
  // Before 0.12 the size and the rate came together, as one of four presets.
  const old = typeof s.preset === "string" ? OLD_SCREEN_PRESETS[s.preset] : undefined;
  return {
    resolution: oneOf(s.resolution, SCREEN_RESOLUTIONS, old?.resolution ?? DEFAULT_SCREEN.resolution),
    fps: oneOf(s.fps, SCREEN_FPS, old?.fps ?? DEFAULT_SCREEN.fps),
    // «vp9» was the old «Авто (VP9)»: the new «Авто».
    codec: oneOf(s.codec === "vp9" ? "auto" : s.codec, SCREEN_CODECS, DEFAULT_SCREEN.codec),
    audio: typeof s.audio === "boolean" ? s.audio : DEFAULT_SCREEN.audio,
  };
}

function parseCamera(raw: unknown): CameraSettings {
  const c = isRecord(raw) ? raw : {};
  return {
    deviceId: typeof c.deviceId === "string" && c.deviceId.length > 0 && c.deviceId.length <= 200 ? c.deviceId : DEFAULT_CAMERA.deviceId,
    quality: oneOf(c.quality, CAMERA_QUALITIES, DEFAULT_CAMERA.quality),
    mirror: typeof c.mirror === "boolean" ? c.mirror : DEFAULT_CAMERA.mirror,
    facing: oneOf(c.facing, CAMERA_FACINGS, DEFAULT_CAMERA.facing),
  };
}

export type CustomGame = { exe: string; title: string };
const MAX_CUSTOM_GAMES = 50;
const MAX_HINTS = 50;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

const MAX_MUSIC_VOLUME = 2;
const MAX_MUSIC_SEND = 1.5;

/** A music volume as saved: a number in 0…`max`, 1 when there is none. */
function musicLevel(value: unknown, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 1;
}

export function parsePrefs(raw: unknown): Prefs {
  const p = isRecord(raw) ? raw : {};
  const nickname = typeof p.nickname === "string" ? [...p.nickname.trim()].slice(0, MAX_NICKNAME_CHARS).join("") : "";
  return {
    nickname,
    color: parseProfileColor(p.color) ?? "blue",
    frame: knownFrame(p.frame),
    character: parseCharacter(p.character) || parseAvatar(p.character) ? (p.character as string) : null,
    stage3d: p.stage3d !== false,
    stageLook: parseStageLook(p.stageLook),
    overlay: p.overlay === true,
    overlaySpots: parseSpots(p.overlaySpots),
    overlaySize: p.overlaySize === undefined ? DEFAULT_SIZE : clampSize(p.overlaySize),
    musicMini: p.musicMini !== false,
    musicDuck: p.musicDuck !== false,
    musicVolume: musicLevel(p.musicVolume, MAX_MUSIC_VOLUME),
    musicSend: musicLevel(p.musicSend, MAX_MUSIC_SEND),
    musicMuted: false,
    clipboardInvites: p.clipboardInvites !== false,
    autoJoin: p.autoJoin === true,
    lastChannels: parseLastChannels(p.lastChannels),
    appearance: parseAppearance(p.appearance),
    onboarded: p.onboarded === true,
    showGame: p.showGame !== false,
    customGames: Array.isArray(p.customGames)
      ? p.customGames
          .filter((g): g is CustomGame => isRecord(g) && typeof g.exe === "string" && typeof g.title === "string" && !!g.exe.trim() && !!g.title.trim())
          .map((g) => ({ exe: g.exe.trim(), title: g.title.trim() }))
          .slice(0, MAX_CUSTOM_GAMES)
      : [],
    notifyMode: oneOf(p.notifyMode, NOTIFY_MODES, "mentions"),
    notifyText: p.notifyText !== false,
    screen: parseScreen(p.screen),
    codecPicked: p.codecPicked === true,
    remoteBanner: p.remoteBanner !== false,
    camera: parseCamera(p.camera),
    streamer: oneOf(p.streamer, STREAMER, "auto"),
    drawerPinned: p.drawerPinned === true,
    seenHints: Array.isArray(p.seenHints) ? p.seenHints.filter((h): h is string => typeof h === "string").slice(0, MAX_HINTS) : [],
    phonePip: p.phonePip !== false,
    phoneRoute: oneOf(p.phoneRoute, PHONE_ROUTES, "auto"),
    phonePttKey: parsePhoneKey(p.phonePttKey),
    phoneScreenSet: p.phoneScreenSet === true,
    phoneOnline: p.phoneOnline === true,
  };
}

function loadPrefs(): Prefs {
  const stored = loadJson(STORAGE_KEY);
  if (stored !== null) return parsePrefs(stored);
  let legacy = "";
  try {
    legacy = localStorage.getItem(LEGACY_NICKNAME_KEY) ?? "";
  } catch {
    // No storage.
  }
  return parsePrefs({ nickname: legacy });
}

type PrefsState = Prefs & {
  setNickname: (nickname: string) => void;
  setColor: (color: ProfileColor) => void;
  setFrame: (frame: FrameId | null) => void;
  setCharacter: (code: string | null) => void;
  setStage3d: (on: boolean) => void;
  setStageLook: (look: StageLook) => void;
  setOverlay: (on: boolean) => void;
  setMusicMini: (on: boolean) => void;
  setMusicDuck: (on: boolean) => void;
  setMusicVolume: (volume: number) => void;
  setMusicSend: (volume: number) => void;
  setMusicMuted: (muted: boolean) => void;
  /** A person's place on the desktop; null forgets it (they stand in the row again). */
  setOverlaySpot: (id: string, spot: Spot | null) => void;
  setOverlaySize: (size: number) => void;
  resetOverlaySpots: () => void;
  setClipboardInvites: (on: boolean) => void;
  setAutoJoin: (on: boolean) => void;
  setLastChannel: (address: string, channel: string) => void;
  setAppearance: (change: Partial<Appearance>) => void;
  finishOnboarding: () => void;
  setShowGame: (showGame: boolean) => void;
  setCustomGames: (games: CustomGame[]) => void;
  setNotifyMode: (mode: NotifyMode) => void;
  setNotifyText: (show: boolean) => void;
  setScreen: (change: Partial<ScreenSettings>) => void;
  /** The codec that suits this PC's video card, set for someone who never chose one. */
  tuneCodec: (codec: ScreenSettings["codec"]) => void;
  setRemoteBanner: (on: boolean) => void;
  setCamera: (change: Partial<CameraSettings>) => void;
  setStreamer: (mode: StreamerMode) => void;
  setDrawerPinned: (on: boolean) => void;
  /** Marks a one-time hint as seen: it does not come back. */
  seeHint: (id: string) => void;
  setPhonePip: (on: boolean) => void;
  setPhoneRoute: (route: PhoneRoute) => void;
  setPhonePttKey: (key: string | null) => void;
  /** A phone's screen at what it carries, once (the person's own choice is never changed afterwards). */
  tunePhoneScreen: () => void;
  setPhoneOnline: (on: boolean) => void;
};

export const usePrefs = create<PrefsState>((set) => ({
  ...loadPrefs(),
  setNickname: (nickname) => set({ nickname: [...nickname].slice(0, MAX_NICKNAME_CHARS).join("") }),
  setColor: (color) => set({ color }),
  setFrame: (frame) => set({ frame }),
  setCharacter: (character) => set({ character: parseCharacter(character) || parseAvatar(character) ? character : null }),
  setStage3d: (stage3d) => set({ stage3d }),
  setStageLook: (stageLook) => set({ stageLook }),
  setOverlay: (overlay) => set({ overlay }),
  setOverlaySpot: (id, spot) =>
    set((s) => {
      const { [id]: _old, ...rest } = s.overlaySpots;
      return { overlaySpots: spot ? parseSpots({ ...rest, [id]: spot }) : rest };
    }),
  setOverlaySize: (overlaySize) => set({ overlaySize: clampSize(overlaySize) }),
  resetOverlaySpots: () => set({ overlaySpots: {}, overlaySize: DEFAULT_SIZE }),
  setClipboardInvites: (clipboardInvites) => set({ clipboardInvites }),
  setAutoJoin: (autoJoin) => set({ autoJoin }),
  setLastChannel: (address, channel) => set((s) => ({ lastChannels: { ...s.lastChannels, [address]: channel } })),
  setAppearance: (change) => set((s) => ({ appearance: parseAppearance({ ...s.appearance, ...change }) })),
  finishOnboarding: () => set({ onboarded: true }),
  setShowGame: (showGame) => set({ showGame }),
  setCustomGames: (customGames) => set({ customGames: customGames.slice(0, MAX_CUSTOM_GAMES) }),
  setNotifyMode: (notifyMode) => set({ notifyMode }),
  setNotifyText: (notifyText) => set({ notifyText }),
  setScreen: (change) =>
    set((s) => ({ screen: parseScreen({ ...s.screen, ...change }), codecPicked: s.codecPicked || "codec" in change, phoneScreenSet: true })),
  tuneCodec: (codec) => set((s) => (s.codecPicked || s.screen.codec === codec ? s : { screen: { ...s.screen, codec } })),
  setRemoteBanner: (remoteBanner) => set({ remoteBanner }),
  setCamera: (change) => set((s) => ({ camera: parseCamera({ ...s.camera, ...change }) })),
  setStreamer: (streamer) => set({ streamer }),
  setDrawerPinned: (drawerPinned) => set({ drawerPinned }),
  seeHint: (id) => set((s) => (s.seenHints.includes(id) ? s : { seenHints: [...s.seenHints, id].slice(-MAX_HINTS) })),
  setPhonePip: (phonePip) => set({ phonePip }),
  setPhoneRoute: (phoneRoute) => set({ phoneRoute }),
  setPhonePttKey: (key) => set({ phonePttKey: parsePhoneKey(key) }),
  tunePhoneScreen: () => set((s) => (s.phoneScreenSet ? s : { phoneScreenSet: true, screen: { ...s.screen, resolution: "720", fps: "30" } })),
  setPhoneOnline: (phoneOnline) => set({ phoneOnline }),
  setMusicMini: (musicMini) => set({ musicMini }),
  setMusicDuck: (musicDuck) => set({ musicDuck }),
  setMusicVolume: (volume) => set({ musicVolume: musicLevel(volume, MAX_MUSIC_VOLUME) }),
  setMusicSend: (volume) => set({ musicSend: musicLevel(volume, MAX_MUSIC_SEND) }),
  setMusicMuted: (musicMuted) => set({ musicMuted }),
}));

usePrefs.subscribe((s) =>
  saveJson(STORAGE_KEY, {
    nickname: s.nickname,
    color: s.color,
    frame: s.frame,
    character: s.character,
    stage3d: s.stage3d,
    stageLook: s.stageLook,
    overlay: s.overlay,
    overlaySpots: s.overlaySpots,
    overlaySize: s.overlaySize,
    musicMini: s.musicMini,
    musicDuck: s.musicDuck,
    musicVolume: s.musicVolume,
    musicSend: s.musicSend,
    clipboardInvites: s.clipboardInvites,
    autoJoin: s.autoJoin,
    lastChannels: s.lastChannels,
    appearance: s.appearance,
    onboarded: s.onboarded,
    showGame: s.showGame,
    customGames: s.customGames,
    notifyMode: s.notifyMode,
    notifyText: s.notifyText,
    screen: s.screen,
    codecPicked: s.codecPicked,
    remoteBanner: s.remoteBanner,
    camera: s.camera,
    streamer: s.streamer,
    drawerPinned: s.drawerPinned,
    seenHints: s.seenHints,
    phonePip: s.phonePip,
    phoneRoute: s.phoneRoute,
    phonePttKey: s.phonePttKey,
    phoneScreenSet: s.phoneScreenSet,
    phoneOnline: s.phoneOnline,
  }),
);
