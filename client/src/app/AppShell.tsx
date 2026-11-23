import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBoard } from "../board/useBoard";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowDownToLine, DoorOpen, MessagesSquare, Mic, Radio, Settings, UserRound, UserPlus, Users, X } from "lucide-react";
import { loadAudioSettings, saveAudioSettings, type AudioSettings } from "../audio/settings";
import { pttPhone, usePtt } from "../audio/usePtt";
import { useServersUnread, useUnread } from "../chat/useUnread";
import { useChatNotifications } from "../chat/useChatNotifications";
import { loadVolumes, saveVolumes, withVolume, type VolumeMap } from "../audio/volumes";
import { ChatView } from "../features/chat/ChatView";
import { channelStillExists } from "../features/channels/templates";
import { useServerState } from "../features/channels/useServerState";
import { ChatList } from "../features/drawer/ChatList";
import { Drawer, DrawerEdge } from "../features/drawer/Drawer";
import { useDrawer } from "../features/drawer/useDrawer";
import { useClipboardInvite } from "../features/join/useClipboardInvite";
import { useInviteRequests } from "../features/join/inviteRequest";
import { useInviteLinks } from "../features/join/useInviteLinks";
import { useWhatsNew } from "../features/settings/useWhatsNew";
import { applyGameStatus } from "../features/settings/games";
import { AFK_CHECK_MS, shouldGoAfk } from "../voice/afk";
import { People } from "../features/people/People";
import { NoServer, Overview } from "../features/home/Overview";
import { useSince } from "../features/home/rooms";
import { CommandPalette, type Command } from "../features/shell/CommandPalette";
import { HouseMenu, MeMenu, TopBar } from "../features/shell/TopBar";
import { useUpdate } from "../features/shell/useUpdate";
import { moderationAction, muteSpan, type ModerationAction } from "../features/moderation/events";
import { KickedCard, banEnd } from "../features/moderation/KickedCard";
import { ModerationNotice, type Notice } from "../features/moderation/ModerationNotice";
import type { ServerMute } from "../features/moderation/MuteTimer";
import { PersonMenu } from "../features/moderation/PersonMenu";
import { afterPunishment } from "../features/moderation/punishment";
import { leaveServer } from "../features/serverSettings/leave";
import { DeleteServerDialog } from "../features/host/DeleteServerDialog";
import { useHostedServer } from "../features/host/deleteServer";
import { HostOff } from "../features/host/HostOff";
import { serverActions } from "../features/host/serverActions";
import { useInvite } from "../features/serverSettings/quickInvite";
import { ServerSettingsModal } from "../features/serverSettings/ServerSettingsModal";
import { Onboarding } from "../features/onboarding/Onboarding";
import { AddServerModal } from "../features/servers/AddServerModal";
import { SettingsModal, type SettingsSection } from "../features/settings/SettingsModal";
import { CallHead } from "../features/stage/CallHead";
import { Dock, MiniCall } from "../features/stage/Dock";
import { Stage } from "../features/stage/Stage";
import { displayName, identityInfo, onServerEvent, postEntry, setProfile, type Body, type MediaRef, hasPermission } from "../server/session";
import { useBackupPrompt } from "../state/backup";
import { usePrefs } from "../state/prefs";
import { useServers } from "../state/servers";
import { CAN_HOST, canShareScreen, canUseCamera, HAS_STUDIO, IS_ANDROID, IS_MOBILE } from "../platform";
import { android } from "../platform/android";
import { useAndroid } from "../features/phone/useAndroid";
import { backTakenBy } from "../ui/backStack";
import type { CameraSettings } from "../voice/camera";
import { useToasts } from "../ui/toasts";
import { applyAppearance } from "../theme/appearance";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { notify, useErrorToast } from "../ui/toasts";
import { useWatch } from "../watch/useWatch";
import { useActs } from "../characters/useActs";
import { parseAvatar } from "../characters/gallery";
import { publishAvatar, useMyAvatar } from "../characters/myAvatar";
import { useDms } from "../chat/useDms";
import { chatDmOpen, isDm } from "../chat/api";
import { dmChannel } from "../features/chat/dm";
import { cssColor, portraitFor, sceneMembers } from "../characters/members";
import { arrangeOverlay, useOverlayFeed } from "../characters/overlay";
import { useRemote } from "../remote/useRemote";
import { controllable, usePhoneControl } from "../remote/phoneControl";
import { useMusic } from "../music/useMusic";
import { MusicCorner } from "../features/music/MusicMini";
import { MusicStartDialog } from "../features/music/MusicStartDialog";
import { RemoteAskDialog, RemoteBanner } from "../features/remote/RemoteHost";
import { NoDriverCard, PadAskDialog, PadPlayers } from "../features/pads/PadHost";
import { usePads } from "../pads/usePads";
import { av1Support, screenToSend } from "../voice/av1Support";
import { bestCodec } from "../voice/codecAdvice";
import { ownCaptureSupported, type OwnSource } from "../voice/ownCapture";
import { ScreenPicker } from "../features/stage/ScreenPicker";
import { listen } from "@tauri-apps/api/event";
import { FROZEN_WINDOW_TEXT } from "../voice/frozenShare";
import { StudioPage } from "../features/studio/StudioPage";
import { useStudio } from "../studio/engine";
import { isLive, useStream } from "../studio/stream";
import { useStreamerActive, useStreaming, useStreamingWatch } from "../state/streamer";
import { WatchDialog } from "../features/stage/WatchDialog";
import { withMemberNames, withNet } from "../voice/participants";
import { useVoice } from "../voice/useVoice";

const LOST_IDENTITY_TEXT =
  "Личность на этом ПК не прочиталась: Windows переустановили или сбросили пароль. Создана новая. Если есть копия .hvid, загрузи её в разделе «Профиль»";

/** The first call's word over «⋯» on where everything else went. */
const MORE_HINT = "call-more";
/** Narrower than this, the panel of chats always slides over the page: it cannot stand beside it. */
const PIN_WIDTH = 1000;

type Page = "home" | "studio" | "motions";

// Its 3D tools load only for those who open it.
const Workshop = lazy(() => import("../features/workshop/Workshop"));

function useSystemDark(): boolean {
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(query?.matches ?? true);
  useEffect(() => {
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [query]);
  return dark;
}

/** The window is at least `width` wide, kept up to date. */
function useWide(width: number): boolean {
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.innerWidth >= width);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= width);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width]);
  return wide;
}

export function AppShell() {
  const prefs = usePrefs();
  const { servers, selected, select, remove } = useServers();
  // Whose server runs on this PC: looked up again as servers come and go.
  const hosted = useHostedServer(`${selected}|${servers.length}`);
  const hostedAddress = hosted === undefined ? undefined : (hosted?.address ?? null);
  const server = servers.find((s) => s.address === selected) ?? null;
  // Someone who never chose a codec gets the one that suits this PC's video card, from the very first start.
  useEffect(() => {
    const { codecPicked, screen } = usePrefs.getState();
    if (!codecPicked) void av1Support(screen).then((support) => usePrefs.getState().tuneCodec(bestCodec(support)));
    // A phone's screen at 1080p and 60 frames (a PC's default) is more than its processor and link carry: 720p and 30.
    if (IS_ANDROID) usePrefs.getState().tunePhoneScreen();
  }, []);

  const [settings, setSettings] = useState<AudioSettings>(loadAudioSettings);
  const [volumes, setVolumes] = useState<VolumeMap>(loadVolumes);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  // What fills the window under the bar; at home, the call's stage or the whole house.
  const [page, setPage] = useState<Page>("home");
  const [view, setView] = useState<"call" | "house">("call");
  const [palette, setPalette] = useState(false);
  const drawer = useDrawer();
  const wide = useWide(PIN_WIDTH);
  const studioRecording = useStudio((s) => !!s.recording);
  const studioStreaming = useStream((s) => isLive(s.states));
  const [addServer, setAddServer] = useState<"connect" | "create" | null>(null);
  /** Our own picker of what to show (the Windows app), open. */
  const [pickerOpen, setPickerOpen] = useState(false);
  // The house menu asked to delete the server on this PC.
  const [deleting, setDeleting] = useState(false);
  // Android's back button walks the web view's history: going to a page is a step in it, and the step back is home.
  const go = (next: Page) => {
    setPage(next);
    if (IS_MOBILE && next !== "home") history.pushState({ page: next }, "");
  };
  const { hide: hideDrawer } = drawer;
  useEffect(() => {
    const back = (event: Event) => {
      // A window on top took this step (see `backStack`): the page stays.
      if (backTakenBy(event)) return;
      hideDrawer();
      setPage("home");
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [hideDrawer]);
  // On a phone the panel fills the screen: the back button closes it, so opening it is a step back can undo.
  useEffect(() => {
    if (IS_MOBILE && drawer.open) history.pushState({ drawer: true }, "");
  }, [drawer.open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen("voice");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  useWhatsNew();
  const takeInvite = (link: string) => {
    setInviteLink(link);
    setAddServer("connect");
  };
  useInviteLinks(takeInvite);
  useInviteRequests(takeInvite);
  useClipboardInvite(takeInvite);

  const systemDark = useSystemDark();
  useEffect(() => applyAppearance(prefs.appearance, systemDark), [prefs.appearance, systemDark]);
  useEffect(() => saveAudioSettings(settings), [settings]);
  useEffect(() => saveVolumes(volumes), [volumes]);

  const updateSettings = useCallback((change: Partial<AudioSettings>) => setSettings((s) => ({ ...s, ...change })), []);
  const ptt = usePtt({ enabled: settings.mode === "ptt", binding: settings.pttBinding, tailMs: settings.pttTailMs, phoneKey: prefs.phonePttKey });
  const { state, offline, error: serverError, clockOffset, refresh } = useServerState(server?.address ?? null);
  // Leave, delete or only take off the list: what this server allows, even one whose state never loads.
  const actions = server ? serverActions(server.address, hostedAddress, state?.me ?? null) : null;
  const nameOf = (userId: string) => {
    const member = state?.members.find((m) => m.user_id === userId);
    return member ? displayName(member) : "модератор";
  };
  const myMute = state?.members.find((m) => m.user_id === state.me.user_id)?.muted ?? null;
  const serverMute: ServerMute | null = myMute ? { until: myMute.until, byName: nameOf(myMute.by), reason: myMute.reason } : null;
  const voice = useVoice({ settings, pttOpen: ptt.open, volumes, serverMuted: !!serverMute, musicDuck: prefs.musicDuck, musicVolume: prefs.musicMuted ? 0 : prefs.musicVolume, musicSend: prefs.musicSend });
  // Android keeps the microphone (and the camera, the screen, a server hosted here) going with the screen off only if it
  // knows they are on; the call goes on in a small window over other apps.
  const inCall = voice.status !== "idle";
  const phone = useAndroid({
    inCall,
    camera: voice.cameraOn,
    hosting: !!hosted?.running,
    pip: prefs.phonePip,
    route: prefs.phoneRoute,
    online: prefs.phoneOnline,
    onLeave: () => void voice.leave(),
  });
  // Names and colors on the stage come from the signed journal, not from what clients claim.
  const { views: participants, mine: myNet } = withNet(withMemberNames(voice.participants, state?.members ?? []), voice.net);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [punished, setPunished] = useState<{
    address: string;
    kind: "kick" | "ban";
    byName: string;
    reason: string;
    media: MediaRef | null;
    until: number | null;
  } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const channels = state?.channels ?? [];
  const backup = useBackupPrompt();
  // The chat open in the panel at the left: a text channel's, a room's, or direct messages.
  const [chatChannelId, setChatChannelId] = useState<string | null>(null);
  // Read through a command that may answer nothing: an empty list then.
  const dms = useDms(server?.address ?? null) ?? [];
  const dmPeer = chatChannelId && isDm(chatChannelId) ? dms.find((d) => d.channel === chatChannelId)?.peer : undefined;
  const dmMember = dmPeer ? state?.members.find((m) => m.user_id === dmPeer) : undefined;
  const chatChannel =
    channels.find((c) => c.id === chatChannelId) ??
    (chatChannelId && dmPeer ? dmChannel(chatChannelId, dmMember ? displayName(dmMember) : "Бывший участник") : null);
  const unread = useUnread(server?.address ?? null);
  const serversUnread = useServersUnread(servers.map((s) => s.address));
  // The panel stands beside the page only in a wide window, on a desktop, in a house.
  const pinned = prefs.drawerPinned && wide && !IS_MOBILE && !!state;
  const drawerShown = drawer.open || pinned;
  const openChat = (id: string) => {
    setChatChannelId(id);
    drawer.show("chats");
  };
  useEffect(() => {
    setChatChannelId(null);
    setPage("home");
    hideDrawer();
  }, [server?.address, hideDrawer]);
  // A panel that slid back opens on its list next time.
  useEffect(() => {
    if (!drawerShown) setChatChannelId(null);
  }, [drawerShown]);
  const invite = useInvite(server, state);

  // A previous identity the DPAPI keys of this Windows no longer open: say so once, at start.
  useEffect(() => {
    if (!isTauri()) return;
    void identityInfo()
      .then((info) => info.lost_previous && notify.error(LOST_IDENTITY_TEXT))
      .catch(() => {});
  }, []);

  // The profile is signed again for every open server, a moment after typing stops.
  useEffect(() => {
    if (!isTauri() || !prefs.nickname.trim()) return;
    const timer = setTimeout(() => {
      // Our files reach the servers before the profile that names them.
      const avatar = useMyAvatar.getState().avatar;
      const publishing = parseAvatar(prefs.character)?.kind === "pack" ? useServers.getState().servers.map((s) => publishAvatar(s.address, avatar).catch(() => {})) : [];
      void Promise.all(publishing)
        .then(() => setProfile(prefs.nickname.trim(), prefs.color, prefs.frame, prefs.character))
        .catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [prefs.nickname, prefs.color, prefs.frame, prefs.character]);
  // A server opened later gets them too; the state's address says it is open.
  const openAddress = state ? server?.address : undefined;
  useEffect(() => {
    if (!isTauri() || !openAddress || parseAvatar(prefs.character)?.kind !== "pack") return;
    void publishAvatar(openAddress, useMyAvatar.getState().avatar).catch(() => {});
  }, [openAddress, prefs.character]);
  useEffect(() => {
    if (isTauri()) void applyGameStatus(prefs.showGame, prefs.customGames).catch(() => {});
  }, [prefs.showGame, prefs.customGames]);

  // A call on another server (switched from a dialog, say) is not this server's channel.
  const inChannel = voice.status !== "idle" && voice.channelId !== null && voice.address === server?.address;
  const callChannel = inChannel ? (channels.find((c) => c.id === voice.channelId) ?? null) : null;
  // Getting into a call shows its stage, and its time starts.
  const wasInCall = useRef(false);
  const [callSince, setCallSince] = useState<number | null>(null);
  useEffect(() => {
    if (inChannel && !wasInCall.current) {
      setPage("home");
      setView("call");
      setCallSince(Date.now());
    }
    if (!inChannel && wasInCall.current) setCallSince(null);
    wasInCall.current = inChannel;
  }, [inChannel]);
  const callTimeText = useSince(callSince);
  // The small window over other apps shows the call's stage, whatever page was open.
  useEffect(() => {
    if (!phone.inPip || !inChannel) return;
    setPage("home");
    setView("call");
    hideDrawer();
  }, [phone.inPip, inChannel, hideDrawer]);
  const update = useUpdate(server?.address ?? null, !!state);
  const watch = useWatch(inChannel ? voice.address : null, inChannel ? voice.channelId : null, clockOffset, state?.me.user_id ?? "");
  const [watchOpen, setWatchOpen] = useState(false);
  const acts = useActs(inChannel ? voice.address : null, inChannel ? voice.channelId : null, state?.me.user_id ?? "");
  const friendName = (id: string) => {
    const member = state?.members.find((m) => m.user_id === id);
    return member ? displayName(member) : "Друг";
  };
  // Music played together: who plays, what, and our own «Включить музыку для всех».
  const music = useMusic({
    address: inChannel ? voice.address : null,
    channel: inChannel ? voice.channelId : null,
    me: state?.me.user_id ?? "",
    nameOf: friendName,
    participants: voice.participants.map((p) => p.identity),
    players: voice.musicPlayers,
    musicOn: voice.musicOn,
    startMusic: voice.startMusic,
    stopMusic: voice.stopMusic,
  });
  const [musicOpen, setMusicOpen] = useState(false);
  // The call's drawing board: shared and sealed with the call's keys (see `board/`).
  const board = useBoard({
    me: state?.me.user_id ?? "",
    call: inChannel && voice.address && voice.channelId ? `${voice.address}|${voice.channelId}` : null,
    people: voice.participants.map((p) => p.identity),
    send: voice.sendDrawing,
  });
  const [boardWanted, setBoardWanted] = useState(0);
  const openBoard = () => {
    if (!board) return;
    if (!board.board.owner) board.sync.open();
    setBoardWanted((n) => n + 1);
  };
  const stopMusic = () => void music.stop();
  // «Не слушать» lasts while that music plays: the next one, or someone else's, is heard again.
  const musicFrom = music.playing && !music.playing.mine ? music.playing.identity : null;
  useEffect(() => {
    usePrefs.getState().setMusicMuted(false);
  }, [musicFrom]);
  const changeMusic = () => setMusicOpen(true);
  // The banner over every window, on or off as the settings say.
  useEffect(() => {
    if (isTauri()) void invoke("remote_banner_setting", { on: prefs.remoteBanner }).catch(() => {});
  }, [prefs.remoteBanner]);

  // This phone's «Управление с ПК» (null off Android): a friend controlling it hears whether it is on.
  const phoneControl = usePhoneControl();
  const remote = useRemote({
    address: inChannel ? voice.address : null,
    channel: inChannel ? voice.channelId : null,
    sharing: voice.sharing,
    sharers: voice.screens.filter((s) => !s.isLocal).map((s) => s.identity),
    nameOf: friendName,
    sendData: voice.sendRemote,
    sendNote: voice.sendRemoteNote,
    phoneReady: phoneControl ? phoneControl.ready : null,
  });
  const pads = usePads({
    address: inChannel ? voice.address : null,
    channel: inChannel ? voice.channelId : null,
    sharing: voice.sharing,
    sharers: voice.screens.filter((s) => !s.isLocal).map((s) => s.identity),
    nameOf: friendName,
    sendData: voice.sendPad,
  });
  const controlled = remote.session && !remote.session.host ? remote.session.peer : (pads.playing?.peer ?? null);
  const { lowLatency } = voice;
  // The picture of the PC we control, or play on, is played at once.
  useEffect(() => {
    if (!controlled) return;
    lowLatency(controlled, true);
    return () => lowLatency(controlled, false);
  }, [controlled, lowLatency]);
  const { driveScreen } = voice;
  // Someone drives this PC: our screen goes out at its best until they stop.
  const driven = voice.sharing && (!!remote.session?.host || pads.guests.length > 0);
  useEffect(() => {
    if (!driven) return;
    void driveScreen(true);
    return () => void driveScreen(false);
  }, [driven, driveScreen]);
  // An Android phone is asked like a PC (see `controllable`); an iPhone cannot be controlled, nor can anyone play on a phone
  // with a pad: the answer is no at once, and why is said.
  const hereControllable = controllable(IS_MOBILE, IS_ANDROID);
  const phoneAsked = hereControllable ? null : (remote.asks[0] ?? null);
  const phonePadAsked = IS_MOBILE ? (pads.asks[0] ?? null) : null;
  useEffect(() => {
    if (!phoneAsked) return;
    remote.answer(phoneAsked.user, false, false, null);
    notify.info(`${friendName(phoneAsked.user)} просит управлять — этим телефоном управлять нельзя: iPhone не даёт программам нажимать за человека`);
    // Answered once per ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneAsked]);
  useEffect(() => {
    if (!phonePadAsked) return;
    pads.answer(phonePadAsked.user, false);
    notify.info(`${friendName(phonePadAsked.user)} просит поиграть геймпадом — на телефоне чужие геймпады не подключить`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phonePadAsked]);
  const padAsked = IS_MOBILE ? null : (pads.asks[0] ?? null);
  const asked = hereControllable ? (remote.asks[0] ?? null) : null;
  // The chat in sight: the one open in the panel, while the panel is out.
  const chatInSight = server && drawerShown && chatChannel ? { address: server.address, channel: chatChannel.id } : null;
  useStreamingWatch();
  // On a phone, showing its screen is what the streamer mode's «Сам» waits for.
  useEffect(() => useStreaming.getState().setSharing(voice.sharing), [voice.sharing]);
  const streamer = useStreamerActive();
  // In a call the characters may stand on the desktop too, each where we put them.
  const overlayShown = prefs.overlay && inChannel;
  const [arranging, setArranging] = useState(false);
  const arrange = (on: boolean) => {
    setArranging(on);
    void arrangeOverlay(on).catch(() => setArranging(false));
  };
  useOverlayFeed(overlayShown, arranging, sceneMembers(participants, prefs.character, cssColor, inChannel ? voice.address : null), acts.acts, prefs.overlaySpots, prefs.overlaySize, {
    onPlaced: (id, spot) => usePrefs.getState().setOverlaySpot(id, spot),
    onSize: (size) => usePrefs.getState().setOverlaySize(size),
    onDone: () => arrange(false),
    onAct: (act, to) => acts.perform(act, to),
  });
  useEffect(() => {
    if (!overlayShown) setArranging(false);
  }, [overlayShown]);
  const toggleArranging = () => arrange(!arranging);
  // On a stream nobody reads a message over our shoulder in a notification.
  useChatNotifications({ mode: prefs.notifyMode, showText: prefs.notifyText && !streamer, state, open: chatInSight });
  const pttControls = {
    ...ptt,
    // A phone's key is kept apart from a PC's combination: the same settings may come to a PC in an .hvid one day.
    startCapture: () =>
      void ptt.startCapture((pttBinding) => (pttPhone ? usePrefs.getState().setPhonePttKey(pttBinding[0] ?? null) : updateSettings({ pttBinding }))),
  };

  // The call's current problem; its notification goes once it is over (a busy mic that opened after all).
  useErrorToast(voice.error);
  // The window we show froze: we hear it once (friends see it on the picture itself).
  useEffect(() => {
    if (voice.shareFrozen) notify.error(FROZEN_WINDOW_TEXT);
  }, [voice.shareFrozen]);
  // The window we showed was closed: the show ended by itself (useVoice stops it), and we say why.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void listen("capture-ended", () => notify.info("Окно закрылось — показ остановлен")).then((unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (ptt.error) notify.error(ptt.error);
  }, [ptt.error]);

  // Someone deleted the channel we are in.
  const leaveRef = useRef(voice.leave);
  leaveRef.current = voice.leave;
  // Adding or opening another server from anywhere in the app ends the call on this one.
  useEffect(() => {
    if (voice.status !== "idle" && voice.address !== null && voice.address !== selected) void leaveRef.current();
  }, [voice.status, voice.address, selected]);
  // Joining or leaving changes who is where: ask the server now instead of at the next poll.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const callKey = voice.status === "connected" ? voice.channelId : voice.status === "idle" ? null : undefined;
  useEffect(() => {
    if (callKey !== undefined) void refreshRef.current();
  }, [callKey]);
  useEffect(() => {
    if (!inChannel || channels.length === 0) return;
    if (!channelStillExists(channels, voice.channelId)) {
      void leaveRef.current();
      notify.info("Комната удалена");
    }
  }, [channels, inChannel, voice.channelId]);

  // What moderators do to us arrives as events; the latest state and call are read when one comes.
  const onModeration = useRef<(address: string, action: ModerationAction) => void>(() => {});
  onModeration.current = (address, action) => {
    const serverNow = Date.now() / 1000 + clockOffset;
    switch (action.kind) {
      case "moved": {
        // Only a call on this server moves: never open the mic for someone who already left.
        if (voice.status === "idle" || voice.address !== address) break;
        const name = channels.find((c) => c.id === action.channel)?.name ?? action.channel;
        notify.info(`${nameOf(action.by)} перенёс тебя в «${name}»`);
        void voice.join({ address, channelId: action.channel });
        break;
      }
      case "disconnected":
        notify.info(`${nameOf(action.by)} выгнал тебя из комнаты`);
        void voice.leave();
        break;
      case "punished":
        void voice.leave();
        setPunished({ address, kind: action.punishment, byName: nameOf(action.by), reason: action.reason, media: action.media, until: action.until });
        break;
      case "notice":
        setNotice({ userName: nameOf(action.user), kind: action.punishment, reason: action.reason, media: action.media });
        break;
      case "muted": {
        const span = muteSpan(action.until === null ? null : action.until - serverNow);
        notify.info(`Тебя заглушил ${nameOf(action.by)} ${span}${action.reason ? `: ${action.reason}` : ""}`);
        break;
      }
      case "unmuted":
        notify.info("С тебя сняли мут");
        break;
    }
  };
  const address = server?.address ?? null;
  useEffect(() => {
    if (!address) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    onServerEvent((from, event) => {
      const action = from === address && state ? moderationAction(event, state.me.user_id) : null;
      if (action) onModeration.current(from, action);
    })
      .then((unlisten) => (disposed ? unlisten() : (stop = unlisten)))
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [address, state?.me.user_id]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 12_000);
    return () => clearTimeout(timer);
  }, [notice]);
  // A ban that has ended: the server let us in again.
  useEffect(() => {
    if (state && server && server.bannedUntil !== undefined) useServers.getState().update(server.address, { bannedUntil: undefined });
  }, [state, server]);

  // AFK: after the server's minutes with no input and no voice, move to its AFK channel.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const lastVoiceAt = useRef<number | null>(null);
  useEffect(() => {
    if (voice.transmitting) lastVoiceAt.current = Date.now();
  });
  const afkMinutes = state?.settings.afk_minutes ?? 0;
  const afkChannel = state?.settings.afk_channel ?? null;
  useEffect(() => {
    if (!isTauri() || !inChannel || !address || afkMinutes <= 0 || !afkChannel) return;
    const timer = setInterval(async () => {
      const idleSeconds = await invoke<number>("idle_seconds").catch(() => 0);
      const current = voiceRef.current;
      if (current.transmitting) lastVoiceAt.current = Date.now();
      const move = shouldGoAfk({
        idleSeconds,
        lastVoiceAtMs: lastVoiceAt.current,
        nowMs: Date.now(),
        afkMinutes,
        inChannel: current.status === "idle" ? null : current.channelId,
        afkChannel,
      });
      if (!move) return;
      void current.join({ address, channelId: afkChannel });
      notify.info("Ты в АФК: долго не было активности");
    }, AFK_CHECK_MS);
    return () => clearInterval(timer);
  }, [inChannel, address, afkMinutes, afkChannel, voice.channelId]);

  async function selectServer(address: string) {
    go("home");
    if (address === selected) return;
    if (voice.status !== "idle") await voice.leave();
    select(address);
  }

  function join(channelId: string) {
    // Linux's own web view has no calls; the program opens in a browser when it finds one.
    if (typeof RTCPeerConnection === "undefined") {
      useToasts.getState().push({ kind: "error", text: "Для звонков нужен Chromium, Chrome, Edge или Brave: поставь любой и открой ХатаВойс снова" });
      return;
    }
    if (!server) return;
    // A room shows its stage, the call's or the one being joined.
    setPage("home");
    setView("call");
    if (!prefs.nickname.trim()) {
      notify.info("Сначала укажи ник");
      setSettingsOpen("profile");
      return;
    }
    if (channelId === voice.channelId && voice.status !== "idle") {
      // Already in: the card leads back to it.
      return;
    }
    usePrefs.getState().setLastChannel(server.address, channelId);
    void voice.join({ address: server.address, channelId });
  }

  // Once a run, when asked for: back into the channel we were last in on this server.
  const autoJoinTried = useRef(false);
  useEffect(() => {
    if (autoJoinTried.current || !prefs.autoJoin || !server || !state || voice.status !== "idle") return;
    autoJoinTried.current = true;
    const last = prefs.lastChannels[server.address];
    if (last && channels.some((c) => c.id === last && c.kind !== "text")) join(last);
  });

  async function post(body: Body) {
    if (!server) return;
    await postEntry(server.address, body);
    await refresh();
  }

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const c of channels) {
      if (c.kind === "text") list.push({ id: `chat:${c.id}`, title: c.name, kind: "Чат", icon: <MessagesSquare size={15} />, run: () => openChat(c.id) });
      else if (c.access.connect) list.push({ id: `room:${c.id}`, title: c.name, kind: "Комната", icon: <DoorOpen size={15} />, words: "зайти войти", run: () => join(c.id) });
    }
    for (const m of state?.members ?? []) {
      if (m.user_id !== state?.me.user_id) list.push({ id: `person:${m.user_id}`, title: displayName(m), kind: "Человек", icon: <UserRound size={15} />, run: () => setPersonId(m.user_id) });
    }
    for (const s of servers) {
      if (s.address !== selected) list.push({ id: `server:${s.address}`, title: s.name, kind: "Сервер", icon: <DoorOpen size={15} />, run: () => void selectServer(s.address) });
    }
    list.push(
      { id: "mic", title: voice.micOn ? "Выключить микрофон" : "Включить микрофон", kind: "Действие", icon: <Mic size={15} />, run: voice.toggleMic },
      { id: "chats", title: "Чаты", kind: "Раздел", icon: <MessagesSquare size={15} />, words: "сообщения личные", run: () => drawer.show("chats") },
      { id: "people", title: "Участники сервера", kind: "Раздел", icon: <Users size={15} />, words: "участники друзья", run: () => drawer.show("people") },
      { id: "add", title: "Зайти к другу по ссылке", kind: "Действие", icon: <UserPlus size={15} />, words: "сервер добавить подключиться", run: () => setAddServer("connect") },
    );
    if (HAS_STUDIO) list.push({ id: "studio", title: "Запись и стрим", kind: "Раздел", icon: <Radio size={15} />, words: "студия стрим запись obs", run: () => go("studio") });
    list.push(
      { id: "motions", title: "Движения персонажа", kind: "Раздел", icon: <UserRound size={15} />, words: "мастерская персонаж модель анимация движение эмоции vrm 3d", run: () => go("motions") },
    );
    const sections: [SettingsSection, string, string][] = [
      ["profile", "Профиль", "ник цвет рамка аватар"],
      ["character", "Персонаж", "3d модель vrm мастерская"],
      ["voice", "Голос и звук", "микрофон наушники шумодав громкость"],
      ["notifications", "Уведомления", ""],
      ["streamer", "Режим стримера", ""],
      ["appearance", "Внешний вид", "тема цвет шрифт"],
      ["server", "Мой сервер", "включить хостинг порты"],
      ["about", "О программе", "версия обновление"],
    ];
    for (const [id, title, words] of sections) list.push({ id: `settings:${id}`, title, kind: "Настройки", icon: <Settings size={15} />, words, run: () => setSettingsOpen(id) });
    return list;
    // Rebuilt when what it lists changes; what its actions read is current at the moment they run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, state?.members, servers, selected, voice.micOn]);

  const showPicked = (source: OwnSource) => {
    setPickerOpen(false);
    void screenToSend(prefs.screen)
      .then(({ encoder, warning }) => {
        if (warning) (encoder.codec === "vp9" ? notify.error : notify.info)(warning);
        return voice.shareOwn(source, prefs.screen, encoder);
      })
      .then((problem) => problem && notify.error(problem));
  };
  const modals = (
    <>
      <ScreenPicker open={pickerOpen} settings={prefs.screen} onChange={prefs.setScreen} onPick={showPicked} onClose={() => setPickerOpen(false)} />
      <AddServerModal
        open={addServer !== null}
        initialTab={addServer ?? "connect"}
        initialLink={inviteLink}
        onClose={() => {
          setAddServer(null);
          setInviteLink(null);
        }}
      />
      <SettingsModal
        open={settingsOpen !== null}
        section={settingsOpen ?? "voice"}
        onClose={() => setSettingsOpen(null)}
        voice={voice}
        ptt={pttControls}
        settings={settings}
        onSettingsChange={updateSettings}
        onOpenMotions={() => go("motions")}
        onCreateServer={CAN_HOST ? () => setAddServer("create") : undefined}
      />
    </>
  );

  // Another camera or size, from the call's panel or the settings: a camera that is on goes out anew with it (the
  // mirror is only how we see ourselves).
  const cameraChoice = `${prefs.camera.deviceId}|${prefs.camera.quality}|${prefs.camera.facing}`;
  const lastCameraChoice = useRef(cameraChoice);
  useEffect(() => {
    if (lastCameraChoice.current === cameraChoice) return;
    lastCameraChoice.current = cameraChoice;
    if (voice.cameraOn) void voice.applyCamera(usePrefs.getState().camera).then((problem) => problem && notify.error(problem));
    // Only a new choice matters, not every new `voice`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraChoice]);

  // Every hook is above: finishing the onboarding must not change how many there are.
  if (!prefs.onboarded) {
    return (
      <>
        <Onboarding
          settings={settings}
          onSettingsChange={updateSettings}
          onAddServer={(tab) => setAddServer(tab)}
          ptt={pttControls}
          onDone={() => {}}
        />
        {modals}
      </>
    );
  }

  // What is unread in the panel's chats: the house's, direct messages, and the chat of the room we are in.
  const chatIds = [...channels.filter((c) => c.kind === "text").map((c) => c.id), ...dms.map((d) => d.channel), ...(callChannel ? [callChannel.id] : [])];
  const chatsUnread = chatIds.reduce((sum, id) => sum + (unread.counts[id] ?? 0), 0);
  const chatsMentions = chatIds.reduce((sum, id) => sum + (unread.mentions[id] ?? 0), 0);
  const callRoomName = callChannel?.name ?? "";
  const pictureOf = (p: { isLocal: boolean; character?: string | null; identity: string }) => portraitFor(p.isLocal ? prefs.character : p.character, p.identity);
  const myPicture = portraitFor(prefs.character, state?.me.user_id ?? "me");
  const callShown = inChannel && page === "home" && view === "call";
  const micKeys = {
    micOn: voice.micOn,
    transmitting: voice.transmitting,
    deafened: voice.deafened,
    micLevel: voice.micLevel,
    serverMute,
    clockOffset,
    onToggleMic: voice.toggleMic,
    onToggleDeafen: voice.toggleDeafen,
  };
  const toggleScreen = () => {
    if (voice.sharing) void voice.stopScreen();
    // Our own picker where there is one: the pictures of the windows, the quality and the sound in one place.
    else if (ownCaptureSupported()) setPickerOpen(true);
    // A phone shows its whole screen: Android asks the person itself.
    else if (IS_ANDROID && android()) {
      void screenToSend(prefs.screen)
        .then(({ encoder }) => voice.sharePhone(prefs.screen, encoder))
        .then((problem) => problem && notify.error(problem));
    }
    else {
      // On the video card where it can (AV1 or H.264), and a word when AV1 falls to the processor or to VP9.
      void screenToSend(prefs.screen)
        .then(({ encoder, warning }) => {
          if (warning) (encoder.codec === "vp9" ? notify.error : notify.info)(warning);
          return voice.shareScreen(prefs.screen, encoder);
        })
        .then((problem) => problem && notify.error(problem));
    }
  };
  const toggleCamera = () => {
    if (voice.cameraOn) void voice.stopCamera();
    else void voice.startCamera(prefs.camera).then((problem) => problem && notify.error(problem));
  };
  const changeCamera = (change: Partial<CameraSettings>) => usePrefs.getState().setCamera(change);
  const callChatOpen = drawerShown && !!callChannel && chatChannelId === callChannel.id;
  const toggleCallChat = () => {
    if (!callChannel) return;
    if (!callChatOpen) openChat(callChannel.id);
    else if (pinned) setChatChannelId(null);
    else drawer.hide();
  };
  const goHome = () => {
    go("home");
    setView("house");
  };
  const live = page === "studio" ? null : studioStreaming ? "В эфире" : studioRecording ? "Запись" : null;

  const callView = inChannel && (
    <div className="call-view">
      <section className="call-card" aria-label={`Комната «${callRoomName}»`}>
        <CallHead
          room={callChannel}
          rooms={channels.filter((c) => c.kind !== "text")}
          participants={participants}
          members={state?.members ?? []}
          me={state?.me.user_id ?? ""}
          mine={prefs.character}
          time={callTimeText}
          status={voice.status}
          security={voice.security}
          onRetryEncryption={() => void voice.retryEncryption()}
          onJoin={join}
          onHouse={() => setView("house")}
          myNet={myNet}
        />
        <Stage
          participants={participants}
          volumes={volumes}
          security={voice.security}
          onVolumeChange={(name, change) => setVolumes((v) => withVolume(v, name, change))}
          onPerson={setPersonId}
          screens={voice.screens}
          onWatchScreen={voice.watchScreen}
          watch={watch}
          onShareScreen={() => !voice.sharing && toggleScreen()}
          acts={acts}
          remote={remote}
          pads={pads}
          music={
            music.playing
              ? { playing: music.playing, nameOf: friendName, onStop: stopMusic, onChange: changeMusic, track: voice.musicTrackOf(music.playing.identity) }
              : null
          }
          board={
            board
              ? {
                  controls: board,
                  people: voice.participants.filter((p) => !p.isLocal).map((p) => ({ id: p.identity, name: friendName(p.identity) })),
                  nameOf: (id) => (id === state?.me.user_id ? "ты" : friendName(id)),
                  wanted: boardWanted,
                }
              : null
          }
        />
        <Dock
          above={<MusicCorner playing={music.playing} nameOf={friendName} onStop={stopMusic} onChange={changeMusic} />}
          music={
            !!state && hasPermission(state.me, "stream")
              ? { on: music.mine, onToggle: () => (music.mine ? void music.stop() : setMusicOpen(true)) }
              : undefined
          }
          {...micKeys}
          security={voice.security}
          canShare={canShareScreen() && !!state && hasPermission(state.me, "stream")}
          sharing={voice.sharing}
          onToggleScreen={toggleScreen}
          screen={ownCaptureSupported() ? undefined : { settings: prefs.screen, onChange: prefs.setScreen, phone: IS_ANDROID }}
          camera={
            canUseCamera() && !!state && hasPermission(state.me, "stream")
              ? { on: voice.cameraOn, starting: voice.cameraStarting, settings: prefs.camera, devices: voice.cameras, onToggle: toggleCamera, onChange: changeCamera, phone: IS_MOBILE }
              : undefined
          }
          chat={
            state && callChannel
              ? { open: callChatOpen, unread: callChatOpen ? 0 : (unread.counts[callChannel.id] ?? 0), mentions: callChatOpen ? 0 : (unread.mentions[callChannel.id] ?? 0), onToggle: toggleCallChat }
              : undefined
          }
          voicePreset={settings.voicePreset}
          onVoicePreset={(voicePreset) => updateSettings({ voicePreset })}
          onWatch={() => setWatchOpen(true)}
          watching={!!watch.state}
          onBoard={board ? openBoard : undefined}
          boarding={!!board?.board.owner}
          onEmote={(id) => void acts.perform(id)}
          onSound={voice.playBoard}
          stage3d={prefs.stage3d}
          onToggleStage3d={() => usePrefs.getState().setStage3d(!prefs.stage3d)}
          overlay={prefs.overlay}
          onToggleOverlay={
            IS_MOBILE
              ? undefined
              : () => {
                  const on = !prefs.overlay;
                  usePrefs.getState().setOverlay(on);
                  // The first time, they are put in place at once: the window comes up a moment later.
                  if (on && Object.keys(prefs.overlaySpots).length === 0) setTimeout(() => arrange(true), 1200);
                }
          }
          arranging={arranging}
          onArrange={toggleArranging}
          onEditCharacter={() => setSettingsOpen("character")}
          onStudio={HAS_STUDIO ? () => go("studio") : undefined}
          hint={!prefs.seenHints.includes(MORE_HINT)}
          onHintDone={() => usePrefs.getState().seeHint(MORE_HINT)}
          talk={pttPhone && settings.mode === "ptt" ? { open: ptt.open, press: ptt.press, release: ptt.release } : undefined}
          onLeave={() => void voice.leave()}
        />
      </section>
    </div>
  );

  return (
    <div className="shell">
      <TopBar
        house={state?.profile.name || server?.name || "ХатаВойс"}
        onHome={goHome}
        menu={
          <HouseMenu
            server={server}
            servers={servers}
            serversUnread={serversUnread}
            onSelect={(address) => void selectServer(address)}
            onAdd={() => setAddServer("connect")}
            onInvite={invite ?? undefined}
            onPeople={state ? () => drawer.show("people") : undefined}
            onSettings={state ? () => setServerSettingsOpen(true) : undefined}
            onLeave={
              server && actions?.leave
                ? async () => {
                    if (voice.status !== "idle") await voice.leave();
                    await leaveServer(server.address);
                  }
                : undefined
            }
            onDelete={server && actions?.remove === "delete" ? () => setDeleting(true) : undefined}
            onForget={
              server && actions?.remove === "forget"
                ? () => {
                    remove(server.address);
                    notify.info(`«${server.name}» убран из списка. Вернуть: «Добавить сервер» и его адрес`);
                  }
                : undefined
            }
          />
        }
        chats={
          state
            ? {
                unread: chatsUnread,
                mentions: chatsMentions,
                open: drawerShown,
                onToggle: () => {
                  if (pinned) {
                    usePrefs.getState().setDrawerPinned(false);
                    drawer.hide();
                  } else drawer.toggle();
                },
              }
            : undefined
        }
        live={live ? { label: live, onOpen: () => go("studio") } : null}
        notice={
          update.offer && (
            <button type="button" className="top-update" disabled={update.installing} onClick={update.install}>
              <ArrowDownToLine size={14} aria-hidden />
              {update.installing ? "Скачиваю…" : `Обновить до ${update.offer.version}`}
            </button>
          )
        }
        onSearch={() => setPalette(true)}
        me={
          <MeMenu
            nickname={prefs.nickname}
            color={prefs.color}
            picture={myPicture}
            transmitting={voice.transmitting}
            micOn={voice.micOn}
            deafened={voice.deafened}
            onToggleMic={voice.toggleMic}
            onToggleDeafen={voice.toggleDeafen}
            onProfile={() => setSettingsOpen("profile")}
            onCharacter={() => setSettingsOpen("character")}
            onStudio={HAS_STUDIO ? () => go("studio") : undefined}
            onSettings={() => setSettingsOpen("voice")}
          />
        }
      />
      {streamer && (
        <div className="streamer-badge" role="status">
          <Radio size={14} aria-hidden /> Режим стримера: адреса и ссылки скрыты
          <button type="button" className="link-button" onClick={() => usePrefs.getState().setStreamer("off")}>
            Выключить
          </button>
        </div>
      )}
      {backup.open && (
        <div className="notice-strip" role="status">
          <span>Сохрани копию личности. Без неё после переустановки системы ты потеряешь права владельца</span>
          <Button variant="primary" onClick={() => setSettingsOpen("profile")}>
            Экспорт
          </Button>
          <IconButton label="Позже" onClick={backup.hide}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {remote.session?.host && <RemoteBanner session={remote.session} name={friendName(remote.session.peer)} onStop={remote.stop} />}
      <PadPlayers guests={pads.guests} nameOf={friendName} onKick={pads.kick} onStopAll={pads.stopAll} lower={!!remote.session?.host} />

      <div className="shell-body">
        {state && server && !IS_MOBILE && !drawerShown && page === "home" && <DrawerEdge drawer={drawer} news={chatsUnread + chatsMentions > 0} />}
        {state && server && (
          <Drawer
            drawer={drawer}
            pinned={pinned}
            canPin={wide && !IS_MOBILE}
            onPin={(on) => {
              usePrefs.getState().setDrawerPinned(on);
              if (on) drawer.show();
              else drawer.hide();
            }}
            unread={chatsUnread}
            conversation={
              chatChannel
                ? (actions) => <ChatView address={server.address} channel={chatChannel} state={state} compact onBack={() => setChatChannelId(null)} actions={actions} />
                : null
            }
            chats={
              <ChatList
                state={state}
                callChannel={callChannel}
                dms={dms}
                unread={unread.counts}
                mentions={unread.mentions}
                onOpen={openChat}
                onPost={post}
                onWrite={() => drawer.setTab("people")}
              />
            }
            people={<People state={state} onPerson={setPersonId} />}
          />
        )}
        <main className="page">
          {page === "studio" ? (
            <StudioPage onClose={() => go("home")} />
          ) : page === "motions" ? (
            <Suspense fallback={null}>
              <Workshop onClose={() => go("home")} />
            </Suspense>
          ) : !server ? (
            <NoServer onConnect={() => setAddServer("connect")} onCreate={CAN_HOST ? () => setAddServer("create") : undefined} />
          ) : server.address === hostedAddress && hosted && !hosted.running ? (
            <HostOff name={server.name} crash={hosted.crash} onStarted={() => setTimeout(() => void refresh(), 1500)} />
          ) : serverError ? (
            <div className="empty-state">
              <h1>{server.name}</h1>
              <p>{server.bannedUntil !== undefined ? `Ты забанен ${banEnd(server.bannedUntil)}` : serverError}</p>
              <div className="empty-actions">
                <Button onClick={() => void refresh()}>Попробовать снова</Button>
                <Button onClick={() => remove(server.address)}>Убрать из списка</Button>
              </div>
            </div>
          ) : (
            <div className="home">
              {callShown ? (
                callView
              ) : (
                <Overview
                  server={server}
                  state={state}
                  offline={offline}
                  activeChannelId={inChannel ? voice.channelId : null}
                  participants={participants}
                  mine={prefs.character}
                  security={voice.security}
                  onJoin={(id) => {
                    if (inChannel && id === voice.channelId) setView("call");
                    else join(id);
                  }}
                  unread={unread.counts}
                  mentions={unread.mentions}
                  onPost={post}
                  onPerson={setPersonId}
                  onInvite={invite}
                  onPeople={() => drawer.show("people")}
                />
              )}
            </div>
          )}
          {inChannel && !callShown && (
            <MiniCall
              name={callRoomName}
              people={participants}
              since={callSince}
              pictureOf={pictureOf}
              {...micKeys}
              onOpen={() => {
                setPage("home");
                setView("call");
              }}
              onLeave={() => void voice.leave()}
            />
          )}
        </main>
      </div>

      <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} />
      {inChannel && (
        <>
          <WatchDialog open={watchOpen} onClose={() => setWatchOpen(false)} onStart={watch.start} />
          <MusicStartDialog
            open={musicOpen}
            onClose={() => setMusicOpen(false)}
            sources={music.sources}
            other={music.playing && !music.playing.mine ? friendName(music.playing.identity) : null}
            onStart={music.start}
            phone={IS_MOBILE}
          />
          <RemoteAskDialog
            ask={asked}
            name={asked ? friendName(asked.user) : ""}
            sharing={voice.sharing}
            onAnswer={(allow, keyboard, screen) => asked && remote.answer(asked.user, allow, keyboard, screen)}
          />
          <PadAskDialog
            ask={asked ? null : padAsked}
            name={padAsked ? friendName(padAsked.user) : ""}
            sharing={voice.sharing}
            onAnswer={(allow) => padAsked && pads.answer(padAsked.user, allow)}
          />
          <NoDriverCard name={pads.noDriver ? friendName(pads.noDriver) : null} onClose={pads.dismissNoDriver} />
        </>
      )}
      {server && (
        <DeleteServerDialog open={deleting} name={state?.profile.name || server.name} address={server.address} onClose={() => setDeleting(false)} />
      )}
      {serverSettingsOpen && state && server && (
        <ServerSettingsModal
          open
          address={server.address}
          state={state}
          clockOffset={clockOffset}
          onClose={() => setServerSettingsOpen(false)}
          onPerson={setPersonId}
        />
      )}
      {personId && state && server && state.members.some((m) => m.user_id === personId) && (
        <PersonMenu
          address={server.address}
          state={state}
          target={state.members.find((m) => m.user_id === personId)!}
          clockOffset={clockOffset}
          onClose={() => setPersonId(null)}
          onWrite={() => {
            const address = server.address;
            void chatDmOpen(address, personId)
              .then(openChat)
              .catch((e) => notify.error(String(e)));
          }}
        />
      )}
      {notice && server && (
        <ModerationNotice address={server.address} notice={notice} gifSound={settings.moderationGifSound} onClose={() => setNotice(null)} />
      )}
      {punished && (
        <KickedCard
          {...punished}
          onClose={() => {
            afterPunishment(punished.address, punished.kind, punished.until);
            setPunished(null);
          }}
        />
      )}
      {modals}
    </div>
  );
}
