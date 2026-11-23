import { useCallback, useEffect, useRef, useState } from "react";
import { setCallKeys } from "./callKeys";
import { DRAW_TOPIC, heardDrawing } from "../board/net";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createLocalAudioTrack,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type LocalVideoTrack,
  type RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { applyOutputDevice, getAudioContext } from "../audio/audioContext";
import { dbToMeter, SILENCE_DB } from "../audio/levels";
import { MicPipeline } from "../audio/micPipeline";
import { FramePipeline, framePipelineSupported } from "../audio/framePipeline";
import { voiceBitrate, type AudioSettings } from "../audio/settings";
import { BOARD_RATE, boardSound } from "../audio/soundboard";
import { isPlain, presetFx } from "../audio/voiceFx";
import { playSound, type SoundKind } from "../audio/sounds";
import { createVoiceGate, VAD_HOLD_MS } from "../audio/vad";
import { type VolumeMap } from "../audio/volumes";
import {
  callJoin,
  callLeave,
  callPresence,
  onCallKeys,
  onCallState,
  serverErrorText,
  voiceToken,
} from "../server/session";
import {
  CALL_STARTING,
  createKeyWaits,
  EncryptionError,
  ENCRYPTION_FAILED,
  isEncryptionMessage,
  mayHear,
  NO_CALL,
  nextSecurity,
  presentIdentities,
  type CallSecurity,
} from "./callSecurity";
import { CallKeyProvider } from "./e2ee";
import { offerH264MainFirst } from "./h264Main";
import {
  codecBitrate,
  drivenQuality,
  encoderFpsCap,
  presetQuality,
  screenCaptureOptions,
  phoneScreenPublishOptions,
  PHONE_SCREEN_HINT,
  screenPublishOptions,
  screenPreset,
  SCREEN_SMOOTH_MS,
  type ScreenEncoder,
  type ScreenSettings,
  type ScreenView,
} from "./screen";
import { encodeRemoteNote, heardRemoteNote, REMOTE_NOTE_TOPIC, REMOTE_TOPIC, remoteInput, remoteOpen, toB64, type RemoteNote } from "../remote/api";
import { PAD_TOPIC, padInput } from "../pads/api";
import { isMicRetryMessage, MIC_RETRYING, MIC_STILL_BUSY, micErrorMessage, SoundError } from "./errors";
import { connectRoom, startMic, watchMicLoss } from "./joinFlow";
import { isMicBusy, MIC_PATIENCE, micRetryDelay } from "./micRetry";
import {
  ATTR_DEAFENED,
  ATTR_DEVICE,
  ATTR_SCREEN_FROZEN,
  toParticipantViews,
  withEncryption,
  type ParticipantView,
} from "./participants";
import { RemoteVoiceMeters } from "./remoteMeters";
import { hostView, OwnAudioTrack, OwnCaptureTrack, type OwnSource } from "./ownCapture";
import { isMusicPublication, musicErrorText, musicPublishOptions, trackVolume } from "./music";
import { DUCK_SHARE, DUCK_STEP, DUCK_TICK_MS, duckedNow, stepToward } from "../music/duck";
import { musicStart, musicStop } from "../music/api";
import { AndroidScreen } from "./androidCapture";
import { android } from "../platform/android";
import { IS_MOBILE } from "../platform";
import { cameraCaptureOptions, cameraErrorText, cameraPublishOptions, remoteCameraQuality, VOICE_STREAM, type CameraSettings } from "./camera";
import { IS_ANDROID } from "../platform/android";
import { FROZEN_CHECK_MS, isFrozen, nextLook, THUMB_HEIGHT, THUMB_WIDTH } from "./frozenShare";
import { useNetStats } from "./useNetStats";
import { isSending } from "./sending";
import { REMOTE_SPEECH_DB, SpeakingTracker } from "./speaking";

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";

/** The server issues the pass: our identity, name and rights come from its journal. */
export type JoinOptions = {
  address: string;
  channelId: string;
};

const SCREEN_SOURCES = [Track.Source.ScreenShare, Track.Source.ScreenShareAudio];

/** UI refresh rate for levels and the participant list. */
const UI_TICK_MS = 100;

const REFRESH_EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.ParticipantAttributesChanged,
  RoomEvent.ConnectionQualityChanged,
] as const;

/** Everything that belongs to the encryption of one call; a new one for every join. */
type Call = {
  room: Room;
  address: string;
  channel: string;
  provider: CallKeyProvider;
  worker: Worker;
  waits: ReturnType<typeof createKeyWaits>;
  /** The call engine has been told to join; before that, presence has nothing to talk to. */
  joined: boolean;
  /** LiveKit is reconnecting: it may drop everyone from the room for a moment, which is not them leaving. */
  reconnecting: boolean;
  /**
   * Identities that showed an unencrypted track in this call. LiveKit switches decryption per
   * identity, by the latest publication, and never switches it back on: after one such track the
   * frames of the person's other tracks may be passed through raw. Silent for the rest of the call.
   */
  tainted: Set<string>;
};

/**
 * A room whose frames are encrypted with the keys of the call. The key provider and the worker are
 * new for every call: LiveKit keeps every key it was given and hands them all to a room that
 * connects, so a provider cannot be reused. Nothing is left behind if the room cannot be made.
 */
function createCallRoom(outputDeviceId: string, bitrate: number) {
  const provider = new CallKeyProvider();
  // LiveKit's worker with AV1 in an envelope (e2eeWorker.ts).
  const worker = new Worker(new URL("./e2eeWorker.ts", import.meta.url), { type: "module" });
  try {
    return { room: createRoom(outputDeviceId, bitrate, { keyProvider: provider, worker }), provider, worker };
  } catch (e) {
    worker.terminate();
    throw e;
  }
}

function createRoom(outputDeviceId: string, bitrate: number, e2ee: { keyProvider: CallKeyProvider; worker: Worker }): Room {
  // H.264 screens go to the video card (Main) instead of the processor.
  offerH264MainFirst();
  return new Room({
    // Our only video is shared screens: every watcher takes the full picture, whatever the size of its tile (adaptive
    // streaming gave a small tile a 540p layer). A screen someone closed is not subscribed at all.
    adaptiveStream: false,
    dynacast: true,
    // Remote audio and the mic pipeline share one 48 kHz context; also enables volumes above 100%. Not on Android: there
    // Web Audio plays through the media path with its own big buffer (felt as a tenth of a second), while WebRTC's own
    // playback goes the phone's low-latency call path, which its echo canceller also hears.
    webAudioMix: IS_ANDROID ? false : { audioContext: getAudioContext() },
    // Always set, so "default" also moves the shared context off a device chosen earlier.
    audioOutput: { deviceId: outputDeviceId },
    publishDefaults: {
      // LiveKit judges stereo by the raw mic, but the pipeline always sends mono voice.
      forceStereo: false,
      // The voice goes first when the link is short (and Windows marks its packets as such).
      audioPreset: { maxBitrate: bitrate, priority: "high" },
      // Below 128 kbit/s silence sends nothing (DTX saves a weak link); from 128 up, silence is sent as it is, so the
      // first syllable after a pause and the room's quiet come through clean, as in TeamSpeak.
      dtx: bitrate < 128_000,
      // LiveKit turns RED off under E2EE anyway; said here so nobody wonders.
      red: false,
    },
    e2ee,
  });
}

function captureOptions(settings: AudioSettings): AudioCaptureOptions {
  const input = settings.inputDeviceId;
  return {
    deviceId: input === "default" ? undefined : { exact: input },
    echoCancellation: settings.echoCancellation,
    // The browser's own suppressor is never stacked on top of RNNoise. A phone has no RNNoise (its voice goes out frame
    // by frame, see `FramePipeline`): any noise suppression there is its own.
    noiseSuppression: IS_ANDROID ? settings.noiseSuppression !== "off" : settings.noiseSuppression === "browser",
    autoGainControl: false,
    channelCount: 1,
  };
}

/** RNNoise in the Web Audio pipeline: on a PC when chosen; never on a phone, whose own suppressor does it. */
const wantsRnnoise = (settings: AudioSettings) => !IS_ANDROID && settings.noiseSuppression === "rnnoise";

/** A phone's voice goes to the call frame by frame, with no Web Audio and its big buffer, unless the voice changer is on. */
const wantsFrames = (settings: AudioSettings) => IS_ANDROID && isPlain(presetFx(settings.voicePreset, settings.voiceCustom)) && framePipelineSupported();

/** Not heard, so no speaking ring either. */
const NOT_HEARD = { speaking: false, level: 0 };

export function useVoice({
  settings,
  pttOpen,
  volumes,
  serverMuted = false,
  musicDuck = true,
  musicVolume = 1,
  musicSend = 1,
}: {
  settings: AudioSettings;
  pttOpen: boolean;
  volumes: VolumeMap;
  /** A moderator muted us: the mic stays closed whatever the buttons say. */
  serverMuted?: boolean;
  /** Music played together goes down while someone else speaks (the listener's «Тише, когда говорят»). */
  musicDuck?: boolean;
  /** How loud friends' music plays here (0–2). */
  musicVolume?: number;
  /** How loud everyone hears the music we play (0–1.5). */
  musicSend?: number;
}) {
  const roomRef = useRef<Room | null>(null);
  const micRef = useRef<LocalAudioTrack | null>(null);
  const unwatchMicRef = useRef<(() => void) | null>(null);
  const publishingRef = useRef(false);
  // Whose voice is being measured (and so heard) right now, by identity.
  const meteredRef = useRef(new Map<string, MediaStreamTrack>());
  // Whose screen plays at once, with no buffer: the PC we control or play on.
  const atOnceRef = useRef(new Set<string>());
  /** What our screen was last shared with. */
  const screenSettingsRef = useRef<ScreenSettings | null>(null);
  const screenEncoderRef = useRef<ScreenEncoder | null>(null);
  /** Our own capture, when the screen comes from our picker instead of WebView2's. */
  const ownRef = useRef<{ video: OwnCaptureTrack; audio: OwnAudioTrack | null; source: OwnSource } | null>(null);
  /** Music we play for the call (music together): its track, while it goes. */
  const musicRef = useRef<OwnAudioTrack | null>(null);
  const [musicOn, setMusicOn] = useState(false);
  /** The share of their own volume friends' music plays at now: below 1 while someone speaks (see `music/duck.ts`). */
  const duckRef = useRef(1);
  const musicVolumeRef = useRef(musicVolume);
  musicVolumeRef.current = musicVolume;
  const musicSendRef = useRef(musicSend);
  musicSendRef.current = musicSend;
  /** What our camera went out with last: a change of camera alone is swapped in place (see `applyCamera`). */
  const cameraSettingsRef = useRef<CameraSettings | null>(null);
  /** The phone's screen, when Android shows it (MediaProjection). */
  const phoneRef = useRef<AndroidScreen | null>(null);
  const callRef = useRef<Call | null>(null);
  // Call commands reach the Rust side one after another: a leave is never overtaken by a join sent before it.
  const callQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pipelineRef = useRef<{ pipeline: MicPipeline | FramePipeline; noiseSuppression: boolean; frames: boolean } | null>(null);
  // Created on the first join, so no audio context exists before the user clicks anything.
  const metersRef = useRef<RemoteVoiceMeters | null>(null);
  const settingsRef = useRef(settings);
  const volumesRef = useRef(volumes);
  settingsRef.current = settings;
  volumesRef.current = volumes;

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [security, setSecurity] = useState<CallSecurity>(NO_CALL);
  // Our mic is published in the current call. Until then nothing of ours is on air.
  const [published, setPublished] = useState(false);
  const securityRef = useRef<CallSecurity>(NO_CALL);
  const [channelId, setChannelId] = useState<string | null>(null);
  // The server of the current call, so the shell can tell when the user moved to another one.
  const [address, setAddress] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [micOn, setMicOn] = useState(true);
  // The server may take away the right to publish (a mute) and give it back.
  const [canPublish, setCanPublish] = useState(true);
  const [deafened, setDeafened] = useState(false);
  /** We show our screen in this call. */
  const [sharing, setSharing] = useState(false);
  /** People whose screen we closed: their screen's tracks are not taken. */
  const [closedScreens, setClosedScreens] = useState<ReadonlySet<string>>(new Set());
  /** Our own screen on our stage: closed until we open it (we see the real one anyway). */
  const [ownScreenShown, setOwnScreenShown] = useState(false);
  useEffect(() => {
    if (!sharing) setOwnScreenShown(false);
  }, [sharing]);
  /** Our camera is on in this call. */
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  /** The window we show froze: a game in full screen (friends are told on its picture, we by a toast). */
  const [shareFrozen, setShareFrozen] = useState(false);
  const [vadOpen, setVadOpen] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const deafenedRef = useRef(deafened);
  deafenedRef.current = deafened;
  const micOnRef = useRef(micOn);
  micOnRef.current = micOn;
  const canPublishRef = useRef(canPublish);
  canPublishRef.current = canPublish;
  const peakDbRef = useRef(SILENCE_DB);
  // A mic Windows would not give is tried again: the failed tries so far, the timer of the next one, and its tick.
  const micFailuresRef = useRef(0);
  const micRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [micRetry, setMicRetry] = useState(0);

  const gateRef = useRef(
    createVoiceGate({ thresholdDb: settings.vadThresholdDb, holdMs: VAD_HOLD_MS, onChange: setVadOpen }),
  );

  const connected = status === "connected";
  // Mute on the LiveKit track: the mic button, deafen and push-to-talk, and the lock. While the call is
  // not secure (a new group being keyed, or none), LiveKit would still encrypt with the last group's key.
  const sending =
    isSending({ connected, micOn, deafened, serverMuted, mode: settings.mode, pttOpen }) && security.state === "secure";
  // What the user sees as "on air": voice activation also has to hear speech.
  const transmitting = sending && published && (settings.mode === "voice" ? vadOpen : true);
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  // The same, already off between a lock change and the render that follows it.
  const onAir = useCallback(() => sendingRef.current && securityRef.current.state === "secure", []);
  // The pipeline's gate: voice activation decides, push-to-talk keeps it open.
  const gateWanted = settings.mode === "ptt" || vadOpen;
  const gateWantedRef = useRef(gateWanted);
  gateWantedRef.current = gateWanted;

  const bump = useCallback(() => setTick((t) => t + 1), []);

  /**
   * Someone's screen, picture and sound alike (so they stay together), plays from a short buffer that evens the frames
   * out, as a stream player does — or at once while we control that PC or play on it.
   */
  const screenBuffer = useCallback((identity: string) => {
    const participant = roomRef.current?.remoteParticipants.get(identity);
    const target = atOnceRef.current.has(identity) ? 0 : SCREEN_SMOOTH_MS;
    for (const source of SCREEN_SOURCES) {
      const track = participant?.getTrackPublication(source)?.track as { receiver?: RTCRtpReceiver } | undefined;
      const receiver = track?.receiver as (RTCRtpReceiver & { jitterBufferTarget?: number | null }) | undefined;
      if (receiver && "jitterBufferTarget" in receiver) receiver.jitterBufferTarget = target;
    }
  }, []);

  const sound = useCallback((kind: SoundKind) => {
    if (settingsRef.current.sounds) playSound(kind, getAudioContext());
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      setInputs(await Room.getLocalDevices("audioinput"));
      setOutputs(await Room.getLocalDevices("audiooutput"));
    } catch {
      setInputs([]);
      setOutputs([]);
    }
    try {
      // Never asking for the camera just to name it: that would light it up.
      setCameras(await Room.getLocalDevices("videoinput", false));
    } catch {
      setCameras([]);
    }
  }, []);

  /**
   * Decides, track by track, what is heard (spec §5.4). Whether a track is encrypted is up to its
   * publisher and the server, and an unmarked one reaches the speakers as it is, so such a track is
   * never played and is unsubscribed. Worse, LiveKit switches decryption per identity: one
   * unencrypted publication puts all frames of that identity in doubt, so the identity is tainted
   * and nothing of it is heard for the rest of the call. Of the others, an encrypted track is
   * played while the call is secure and its owner is in the group. What is not heard is not
   * attached and not measured: no sound, no ring. A track nobody could hear (volume 0, or deafened)
   * is not attached either: a new gain node starts at full volume and takes a moment to ramp down.
   * Volume is set on the track, as `participant.setVolume` reaches only the microphone.
   */
  const syncPlayback = useCallback((room: Room) => {
    const call = callRef.current;
    if (roomRef.current !== room || call?.room !== room) return;
    const meters = metersRef.current;
    const metered = meteredRef.current;
    const security = securityRef.current;
    for (const participant of room.remoteParticipants.values()) {
      const identity = participant.identity;
      // First, who is tainted: that has to be known before anything of this identity is attached.
      for (const publication of participant.trackPublications.values()) {
        if (publication.isEncrypted) continue;
        call.tainted.add(identity);
        if (publication.isDesired) publication.setSubscribed(false);
      }
      for (const publication of participant.trackPublications.values()) {
        const track = publication.kind === Track.Kind.Audio ? (publication.track as RemoteAudioTrack | undefined) : undefined;
        if (!track) continue;
        const voice = publication.source === Track.Source.Microphone;
        // The sound of someone's screen and the music they play have volumes of their own, apart from their voice.
        const volume = trackVolume(publication, identity, volumesRef.current, deafenedRef.current, musicVolumeRef.current * duckRef.current);
        const heard = mayHear(publication, identity, security, call.tainted);
        if (heard && voice && metered.get(identity) !== track.mediaStreamTrack) {
          meters?.add(identity, track.mediaStreamTrack);
          metered.set(identity, track.mediaStreamTrack);
        } else if (!heard && voice && metered.delete(identity)) {
          meters?.remove(identity);
        }
        if (heard && volume > 0) {
          if (track.attachedElements.length === 0) document.body.appendChild(track.attach());
          // On Android the sound plays through its element (see `createRoom`), which goes no louder than 100%.
          track.setVolume(IS_ANDROID ? Math.min(1, volume) : volume);
        } else {
          track.detach().forEach((el) => el.remove());
        }
      }
    }
  }, []);

  const onLevel = useCallback((db: number) => {
    gateRef.current.feed(db, performance.now());
    peakDbRef.current = Math.max(peakDbRef.current, db);
  }, []);

  /** Puts a mic pipeline (with or without RNNoise) on the track; falls back to no RNNoise. */
  const installPipeline = useCallback(
    async (track: LocalAudioTrack) => {
      const install = async (noiseSuppression: boolean) => {
        const { voicePreset, voiceCustom } = settingsRef.current;
        if (wantsFrames(settingsRef.current)) {
          const frames = new FramePipeline({ onLevel });
          frames.setGateOpen(gateWantedRef.current);
          try {
            await track.setProcessor(frames);
            pipelineRef.current = { pipeline: frames, noiseSuppression: false, frames: true };
            return;
          } catch {
            // This WebView cannot after all: the Web Audio pipeline, slower but working.
          }
        }
        const pipeline = new MicPipeline({ noiseSuppression, onLevel, fx: presetFx(voicePreset, voiceCustom) });
        // The gate effect only runs on changes, so a new pipeline starts in the current state.
        pipeline.setGateOpen(gateWantedRef.current);
        await track.setProcessor(pipeline);
        pipelineRef.current = { pipeline, noiseSuppression, frames: false };
        if (pipeline.fxError !== undefined) {
          const why = pipeline.fxError instanceof Error ? pipeline.fxError.message : String(pipeline.fxError);
          setError(`Смена голоса не запустилась, голос идёт без неё: ${why}`);
        }
      };
      const wantNs = wantsRnnoise(settingsRef.current);
      try {
        await install(wantNs);
      } catch (e) {
        if (!wantNs) throw e;
        setError(`Шумодав не запустился, звук идёт без него: ${String(e)}`);
        await install(false);
      }
    },
    [onLevel],
  );

  /** Windows did not give us the mic: the button stays on, the person is told, and the mic is tried again a bit later. */
  const retryMicLater = useCallback(() => {
    const failures = ++micFailuresRef.current;
    setError(failures > MIC_PATIENCE ? MIC_STILL_BUSY : MIC_RETRYING);
    if (micRetryTimerRef.current) clearTimeout(micRetryTimerRef.current);
    micRetryTimerRef.current = setTimeout(() => {
      micRetryTimerRef.current = null;
      setMicRetry((n) => n + 1);
    }, micRetryDelay(failures));
  }, []);

  /** A device came or went: a mic waiting for its next try gets it at once. */
  const retryMicNow = useCallback(() => {
    if (!micRetryTimerRef.current) return;
    clearTimeout(micRetryTimerRef.current);
    micRetryTimerRef.current = null;
    setMicRetry((n) => n + 1);
  }, []);

  /** The mic opened (or the call is over): no more tries, and no message about them. */
  const stopMicRetry = useCallback(() => {
    micFailuresRef.current = 0;
    if (micRetryTimerRef.current) clearTimeout(micRetryTimerRef.current);
    micRetryTimerRef.current = null;
    setError((shown) => (isMicRetryMessage(shown) ? null : shown));
  }, []);

  const showSecurity = useCallback((next: CallSecurity) => {
    securityRef.current = next;
    setSecurity(next);
  }, []);

  const queueCall = useCallback((run: () => Promise<void>) => {
    const next = callQueueRef.current.then(run);
    callQueueRef.current = next.catch(() => {});
    return next;
  }, []);

  /** The call's keys cannot be had: the lock goes red and a mic waiting for them gives up. */
  const failEncryption = useCallback(
    (call: Call) => {
      if (callRef.current !== call) return;
      showSecurity({ ...NO_CALL, state: "failed", error: ENCRYPTION_FAILED });
      call.waits.fail(new EncryptionError());
    },
    [showSecurity],
  );

  /**
   * Ends the encryption of the current call, whatever ended the call: the engine drops its group
   * and keys (it would otherwise keep retrying), waits for keys give up, the worker stops. `room`
   * is disconnected first, if it still has to be.
   */
  const endCall = useCallback(
    async (room: Room | null) => {
      const call = callRef.current;
      callRef.current = null;
      showSecurity(NO_CALL);
      if (call) {
        call.waits.fail(new Error("The call is over"));
        call.provider.reset();
        void queueCall(callLeave).catch(() => {});
      }
      try {
        if (room) await room.disconnect();
      } finally {
        call?.worker.terminate();
      }
    },
    [showSecurity, queueCall],
  );

  /** Tells the call engine who the room shows now, ourselves included. */
  const sendPresence = useCallback(
    (call: Call) => {
      void queueCall(async () => {
        if (callRef.current !== call || !call.joined || call.reconnecting) return;
        const { room, address, channel } = call;
        await callPresence(address, channel, presentIdentities(room.localParticipant, room.remoteParticipants.values()));
      }).catch(() => {});
    },
    [queueCall],
  );

  const reset = useCallback(() => {
    setCallKeys(null);
    unwatchMicRef.current?.();
    unwatchMicRef.current = null;
    metersRef.current?.clear();
    micRef.current = null;
    pipelineRef.current = null;
    // The call is over, and so is any mic still starting in it, or waiting for its next try.
    publishingRef.current = false;
    micFailuresRef.current = 0;
    if (micRetryTimerRef.current) clearTimeout(micRetryTimerRef.current);
    micRetryTimerRef.current = null;
    meteredRef.current.clear();
    setPublished(false);
    setCanPublish(true);
    setStatus("idle");
    setChannelId(null);
    setAddress(null);
    setMicLevel(0);
    setSharing(false);
    setCameraOn(false);
    setClosedScreens(new Set());
    // Music played for the call ends with it: Windows' capture of the program too.
    musicRef.current?.stop();
    if (musicRef.current) void musicStop().catch(() => {});
    musicRef.current = null;
    setMusicOn(false);
  }, []);

  const leave = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    reset();
    await endCall(room);
  }, [reset, endCall]);

  /** Opens and publishes the mic in `room`; on failure the mic button goes off with a reason. */
  const publishMic = useCallback(
    async (room: Room) => {
      publishingRef.current = true;
      const result = await startMic({
        room,
        isCurrent: () => roomRef.current === room,
        createMic: () => createLocalAudioTrack(captureOptions(settingsRef.current)),
        prepareMic: async (track) => {
          try {
            await track.setAudioContext(getAudioContext());
            await installPipeline(track);
          } catch (e) {
            // The mic itself opened: this is no busy mic, and opening it again would end the same way.
            throw new SoundError(e);
          }
        },
        // Nothing is published before our own key for the call is set.
        waitKeys: () => {
          const call = callRef.current;
          if (!call || call.room !== room || securityRef.current.state === "failed") {
            return Promise.reject(new EncryptionError());
          }
          return call.waits.wait(call.provider.whenReady());
        },
        publish: async (room, track) => {
          // Last look: the keys are there, but the room must be encrypting too.
          if (callRef.current?.room !== room || !room.localParticipant.isE2EEEnabled) throw new EncryptionError();
          // A stream of its own: never held back to match a camera's picture (see `CAMERA_STREAM`).
          await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, stream: VOICE_STREAM });
        },
        wantSending: onAir,
        onMic: (track) => {
          micRef.current = track;
          setPublished(true);
          stopMicRetry();
          unwatchMicRef.current = watchMicLoss(
            track,
            // Our own mute for the lock is not a lost device.
            onAir,
            () => {
              setMicOn(false);
              setError("Микрофон отключился. Подключи его или выбери другой в настройках");
            },
          );
        },
      });
      if (roomRef.current === room) publishingRef.current = false;
      if (result.kind === "failed") {
        if (result.error instanceof EncryptionError) {
          // Not the mic's fault: it stays on, and goes on air when the keys come or after a retry.
          // A reason that is already shown says more than this generic text.
          setError((shown) => (shown !== null && isEncryptionMessage(shown) ? shown : ENCRYPTION_FAILED));
        } else if (isMicBusy(result.error)) {
          retryMicLater();
        } else {
          setMicOn(false);
          setError(micErrorMessage(result.error));
        }
      }
      bump();
    },
    [installPipeline, bump, onAir, stopMicRetry, retryMicLater],
  );

  /**
   * Captures the published mic anew with the current settings. LiveKit stops the old capture first, so a mic Windows
   * does not give leaves the track silent: it is tried again until it opens, then goes back on air.
   */
  const recapture = useCallback(
    async (track: LocalAudioTrack) => {
      try {
        await track.restartTrack(captureOptions(settingsRef.current));
        const wantNs = wantsRnnoise(settingsRef.current);
        if (pipelineRef.current?.noiseSuppression !== wantNs) await installPipeline(track).catch((e: unknown) => Promise.reject(new SoundError(e)));
        if (micRef.current !== track) return;
        stopMicRetry();
        // A failed unmute left it muted: now that there is sound again, it is on air if it should be.
        if (onAir()) await track.unmute();
      } catch (e) {
        if (micRef.current !== track) return;
        if (isMicBusy(e)) retryMicLater();
        else setError(micErrorMessage(e));
      }
    },
    [installPipeline, onAir, stopMicRetry, retryMicLater],
  );

  const join = useCallback(
    async ({ address, channelId }: JoinOptions) => {
      // Resume inside the click that started the join, before any await.
      void getAudioContext().resume();
      await leave();
      setError(null);
      setStatus("connecting");
      setChannelId(channelId);
      setAddress(address);

      // Two joins started together both get here after leaving: the one that was first is over.
      if (callRef.current) void endCall(roomRef.current);
      let created: ReturnType<typeof createCallRoom>;
      try {
        created = createCallRoom(settingsRef.current.outputDeviceId, voiceBitrate(settingsRef.current.voiceQuality));
      } catch (e) {
        // No encryption, no call: there is no way to join without it.
        reset();
        setError(`${ENCRYPTION_FAILED}: ${serverErrorText(e)}`);
        return;
      }
      const { room, provider, worker } = created;
      const call: Call = { room, address, channel: channelId, provider, worker, waits: createKeyWaits(), joined: false, reconnecting: false, tainted: new Set() };
      roomRef.current = room;
      callRef.current = call;
      showSecurity(CALL_STARTING);
      metersRef.current ??= new RemoteVoiceMeters(
        getAudioContext(),
        new SpeakingTracker({ thresholdDb: REMOTE_SPEECH_DB, holdMs: VAD_HOLD_MS }),
      );
      const meters = metersRef.current;
      const isVoice = (source: Track.Source) => source === Track.Source.Microphone;
      // Until connected, a disconnect is a failed join and is reported as such below.
      let live = false;
      for (const event of REFRESH_EVENTS) room.on(event, bump);
      room
        // «Прекратить доступ» in Windows ends our show as well as our own button does.
        .on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (roomRef.current === room && publication.source === Track.Source.ScreenShare) setSharing(false);
          // Unplugged, or taken away by a moderator's mute.
          if (roomRef.current === room && publication.source === Track.Source.Camera) setCameraOn(false);
        })
        .on(RoomEvent.ParticipantConnected, () => {
          sound("join");
          sendPresence(call);
        })
        .on(RoomEvent.ParticipantDisconnected, (participant) => {
          if (roomRef.current === room && meteredRef.current.delete(participant.identity)) {
            meters.remove(participant.identity);
          }
          sound("leave");
          sendPresence(call);
        })
        // Each of these can bring a track that must not be heard: see `syncPlayback`.
        .on(RoomEvent.TrackPublished, (publication, participant) => {
          // At once and before anything can attach: LiveKit has already switched decryption for this identity.
          if (!publication.isEncrypted) call.tainted.add(participant.identity);
          syncPlayback(room);
          bump();
        })
        .on(RoomEvent.ParticipantEncryptionStatusChanged, (enabled, participant) => {
          // The worker says decryption is off for this identity, whatever its publications look like.
          if (!enabled && participant && !participant.isLocal) call.tainted.add(participant.identity);
          syncPlayback(room);
          bump();
        })
        .on(RoomEvent.TrackSubscribed, (_track, publication, participant) => {
          if (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio) screenBuffer(participant.identity);
          syncPlayback(room);
          bump();
        })
        // A new show of someone's screen is open again, whatever we did with their last one.
        .on(RoomEvent.TrackUnpublished, (publication, participant) => {
          if (roomRef.current !== room || publication.source !== Track.Source.ScreenShare) return;
          setClosedScreens((closed) => {
            if (!closed.has(participant.identity)) return closed;
            const next = new Set(closed);
            next.delete(participant.identity);
            return next;
          });
          bump();
        })
        .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
          track.detach().forEach((el) => el.remove());
          if (roomRef.current === room && isVoice(publication.source) && meteredRef.current.delete(participant.identity)) {
            meters.remove(participant.identity);
          }
          bump();
        })
        .on(RoomEvent.Reconnecting, () => {
          call.reconnecting = true;
          setStatus("reconnecting");
        })
        .on(RoomEvent.Reconnected, () => {
          setStatus("connected");
          // Whoever is still in the room after the reconnect is who counts.
          call.reconnecting = false;
          sendPresence(call);
          // This may attach a track before LiveKit has handled its buffered TrackSubscribed. That is
          // safe only because WebView2 uses insertable streams (encodedInsertableStreams: true): raw
          // frames never reach the decoder before the worker pipe for the track exists.
          syncPlayback(room);
        })
        .on(RoomEvent.Disconnected, () => {
          if (roomRef.current !== room || !live) return;
          roomRef.current = null;
          reset();
          // Kicked, banned or cut off: the call engine must not go on trying.
          void endCall(null);
          setError("Связь с каналом потеряна");
        })
        // Remote control: sealed input for us from whoever we let in; Rust opens it or drops it.
        .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
          if (topic === REMOTE_TOPIC && participant && !participant.isLocal) {
            // A phone plays it itself, through its accessibility service; Rust checks it first all the same.
            const bridge = android();
            if (bridge) void remoteOpen(participant.identity, toB64(payload)).then((input) => input && bridge.send({ op: "control", input })).catch(() => {});
            else void remoteInput(participant.identity, toB64(payload)).catch(() => {});
          }
          if (topic === REMOTE_NOTE_TOPIC && participant && !participant.isLocal) heardRemoteNote(participant.identity, payload);
          // The drawing board: sealed with the sender's call key, opened by the board (or by nobody).
          if (topic === DRAW_TOPIC && participant && !participant.isLocal) heardDrawing(participant.identity, payload);
          // A friend's pad on our PC: Rust checks it is theirs.
          if (topic === PAD_TOPIC && participant && !participant.isLocal) void padInput(participant.identity, toB64(payload)).catch(() => {});
        })
        .on(RoomEvent.MediaDevicesChanged, () => {
          void refreshDevices();
          retryMicNow();
        })
        .on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
          if (roomRef.current !== room || participant !== room.localParticipant) return;
          const allowed = room.localParticipant.permissions?.canPublish !== false;
          setCanPublish(allowed);
          if (allowed) return;
          // Muted by a moderator: the server drops our track; let the device go too.
          unwatchMicRef.current?.();
          unwatchMicRef.current = null;
          const track = micRef.current;
          micRef.current = null;
          setPublished(false);
          if (track) void room.localParticipant.unpublishTrack(track).catch(() => track.stop());
          bump();
        });

      const connection = await connectRoom({
        room,
        isCurrent: () => roomRef.current === room,
        getToken: () => voiceToken(address, channelId),
      });
      // A leave or a newer join took over: it owns the state and the UI now.
      if (connection.kind === "stale") return;
      if (connection.kind === "failed") {
        roomRef.current = null;
        reset();
        void endCall(null);
        setError(`Не удалось войти в канал: ${String(connection.error)}`);
        return;
      }

      live = true;
      // Frame encryption goes on before anything can be published, then the call engine starts.
      try {
        await room.setE2EEEnabled(true);
        await queueCall(async () => {
          if (callRef.current !== call) return;
          await callJoin(address, channelId);
          call.joined = true;
        });
      } catch (e) {
        if (roomRef.current !== room) return;
        roomRef.current = null;
        reset();
        await endCall(room);
        setError(`${ENCRYPTION_FAILED}: ${serverErrorText(e)}`);
        return;
      }
      // A leave or a newer join took over meanwhile: it ended the call.
      if (roomRef.current !== room) return;
      sendPresence(call);
      // People who were here before us: nothing of theirs is heard before it has been checked.
      syncPlayback(room);

      // Muted before joining: no mic until the server gives the right back.
      const allowed = room.localParticipant.permissions?.canPublish !== false;
      setCanPublish(allowed);
      // Started before the status changes, so the mic retry below sees it in progress.
      const mic = allowed ? publishMic(room) : Promise.resolve();
      setStatus("connected");
      await mic;
      void refreshDevices();
    },
    [leave, bump, sound, refreshDevices, retryMicNow, reset, syncPlayback, publishMic, showSecurity, endCall, queueCall, sendPresence, screenBuffer],
  );

  /** The red lock's "Повторить": the call engine starts over, and the mic is published if it was left out. */
  const retryEncryption = useCallback(async () => {
    const call = callRef.current;
    if (!call || roomRef.current !== call.room) return;
    setError(null);
    showSecurity(CALL_STARTING);
    // The new group brings new keys: wait for those, not for the ones of the group that was lost.
    call.provider.reset();
    try {
      await queueCall(async () => {
        if (callRef.current !== call) return;
        await callJoin(call.address, call.channel);
        call.joined = true;
      });
    } catch (e) {
      failEncryption(call);
      if (callRef.current === call) setError(`${ENCRYPTION_FAILED}: ${serverErrorText(e)}`);
      return;
    }
    if (callRef.current !== call) return;
    sendPresence(call);
    const wantMic = micOnRef.current && canPublishRef.current;
    if (wantMic && !micRef.current && !publishingRef.current) void publishMic(call.room);
  }, [showSecurity, queueCall, failEncryption, sendPresence, publishMic]);

  // Mic button, deafen and push-to-talk end up as mute on the LiveKit track.
  useEffect(() => {
    const track = micRef.current;
    if (!track) return;
    (sending ? track.unmute() : track.mute()).then(bump, (e: unknown) => {
      // Unmuting re-opens an unplugged or busy device and can fail. A busy one is tried again.
      if (isMicBusy(e)) return retryMicLater();
      setMicOn(false);
      setError(micErrorMessage(e));
    });
  }, [sending, bump, retryMicLater]);

  // Turning the mic on again retries a mic that failed to start; a lifted mute publishes it again.
  // So do keys that came after the call had given up on them: the mic was left out meanwhile.
  const lock = security.state;
  useEffect(() => {
    const room = roomRef.current;
    if (!connected || !micOn || !canPublish || !room || micRef.current || publishingRef.current) return;
    if (lock === "failed") return;
    void publishMic(room);
  }, [connected, micOn, canPublish, lock, publishMic]);

  // The next try at a mic Windows did not give: started anew, or the published one captured again.
  useEffect(() => {
    const room = roomRef.current;
    if (micRetry === 0 || !room || !micOnRef.current || !canPublishRef.current || publishingRef.current) return;
    const track = micRef.current;
    if (track) void recapture(track);
    else if (securityRef.current.state !== "failed") void publishMic(room);
  }, [micRetry, recapture, publishMic]);

  // The keys did come after all and the mic is on air: the error about them is over.
  useEffect(() => {
    if (lock !== "secure" || !published) return;
    setError((shown) => (shown !== null && isEncryptionMessage(shown) ? null : shown));
  }, [lock, published]);

  // Voice activation drives the pipeline's gate; in push-to-talk mode the gate stays open.
  useEffect(() => {
    pipelineRef.current?.pipeline.setGateOpen(gateWanted);
  }, [gateWanted, status]);

  useEffect(() => gateRef.current.setThreshold(settings.vadThresholdDb), [settings.vadThresholdDb]);

  // The voice changer changes while we talk, without re-capturing. On a phone, turning it on or off changes the path:
  // the frame-by-frame one has no voice changer, the Web Audio one has.
  useEffect(() => {
    const current = pipelineRef.current;
    const track = micRef.current;
    if (current && track && current.frames !== wantsFrames(settingsRef.current)) {
      void installPipeline(track).catch((e: unknown) => setError(micErrorMessage(e)));
      return;
    }
    current?.pipeline.setFx(presetFx(settings.voicePreset, settings.voiceCustom));
  }, [settings.voicePreset, settings.voiceCustom, installPipeline]);

  // Re-capture when the microphone, noise suppression or echo settings change mid-call.
  useEffect(() => {
    const track = micRef.current;
    if (track) void recapture(track);
  }, [settings.inputDeviceId, settings.noiseSuppression, settings.echoCancellation, recapture]);

  // Volumes, deafening and every change of who is in the encryption reach the speakers here.
  useEffect(() => {
    const room = roomRef.current;
    if (room) syncPlayback(room);
  }, [volumes, deafened, security, syncPlayback, status]);

  // While we show a window: does it freeze? A thumbnail every couple of seconds, and Windows asked whether a program
  // fills the screen (a game in full-screen mode gives its window's picture to no capture).
  useEffect(() => {
    setShareFrozen(false);
    const track = sharing ? roomRef.current?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack?.mediaStreamTrack : undefined;
    const own = ownRef.current?.source.kind;
    const surface = own ?? (track?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
    if (!track || surface !== "window" || !isTauri() || typeof ImageCapture === "undefined" || typeof OffscreenCanvas === "undefined") return;
    const capture = new ImageCapture(track);
    const draw = new OffscreenCanvas(THUMB_WIDTH, THUMB_HEIGHT).getContext("2d", { willReadFrequently: true });
    if (!draw) return;
    let state: { stuck: number; last: Uint8ClampedArray | null } = { stuck: 0, last: null };
    let grabbing = false;
    let alive = true;
    // A frozen capture may give no frame at all: a grab that does not come back in time is «no frame», and no second
    // one starts while it hangs.
    const thumbnail = async (): Promise<Uint8ClampedArray | null> => {
      if (grabbing) return null;
      grabbing = true;
      const grab = capture.grabFrame().then(
        (bitmap) => {
          grabbing = false;
          return bitmap;
        },
        () => {
          grabbing = false;
          return null;
        },
      );
      const bitmap = await Promise.race([grab, new Promise<null>((done) => setTimeout(() => done(null), FROZEN_CHECK_MS * 0.75))]);
      if (!bitmap) return null;
      draw.drawImage(bitmap, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
      bitmap.close();
      return draw.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT).data;
    };
    const timer = setInterval(() => {
      void Promise.all([thumbnail(), invoke<boolean>("fullscreen_app").catch(() => false)]).then(([frame, fullscreen]) => {
        if (!alive) return;
        state = nextLook(state, frame, fullscreen);
        setShareFrozen(isFrozen(state.stuck));
      });
    }, FROZEN_CHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sharing]);

  useEffect(() => {
    const room = roomRef.current;
    if (!room || status !== "connected") return;
    void room.localParticipant.setAttributes({ [ATTR_SCREEN_FROZEN]: shareFrozen ? "1" : "0" }).catch(() => {});
  }, [shareFrozen, status]);

  // What others see about us: the deafen state (our color is in our profile, in the group).
  useEffect(() => {
    const room = roomRef.current;
    if (!room || status !== "connected") return;
    void room.localParticipant
      .setAttributes({ [ATTR_DEAFENED]: deafened ? "1" : "0", [ATTR_DEVICE]: IS_MOBILE ? "phone" : "pc" })
      .catch(() => {});
  }, [deafened, status]);

  // Smooth levels: sample the loudest recent mic level and redraw ~10 times a second.
  useEffect(() => {
    if (status === "idle") return;
    const timer = setInterval(() => {
      setMicLevel(dbToMeter(peakDbRef.current));
      peakDbRef.current = SILENCE_DB;
      metersRef.current?.sample(performance.now());
      bump();
    }, UI_TICK_MS);
    return () => clearInterval(timer);
  }, [status, bump]);

  /**
   * Shows our screen (Windows asks which one) with the quality of `screen`; its frames go out encrypted with the
   * keys of the call, like the voice. Null when it is on, or the person changed their mind; the reason otherwise.
   */
  const shareScreen = useCallback(async (screen: ScreenSettings, encoder: ScreenEncoder): Promise<string | null> => {
    const room = roomRef.current;
    if (!room || room.state !== "connected") return "Сначала зайди в голосовой канал";
    try {
      await room.localParticipant.setScreenShareEnabled(true, screenCaptureOptions(screen), screenPublishOptions(screen, encoder));
      screenSettingsRef.current = screen;
      screenEncoderRef.current = encoder;
      if (roomRef.current === room) setSharing(room.localParticipant.isScreenShareEnabled);
      return null;
    } catch (e) {
      // The picker closed without a choice.
      if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) return null;
      return `Не удалось показать экран: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, []);

  /** Watch someone's screen, or close it: its tracks are taken or not at all. */
  const watchScreen = useCallback((identity: string, watching: boolean) => {
    if (identity === roomRef.current?.localParticipant.identity) {
      setOwnScreenShown(watching);
      return;
    }
    const participant = roomRef.current?.remoteParticipants.get(identity);
    for (const source of SCREEN_SOURCES) participant?.getTrackPublication(source)?.setSubscribed(watching);
    setClosedScreens((closed) => {
      const next = new Set(closed);
      if (watching) next.delete(identity);
      else next.add(identity);
      return next;
    });
  }, []);

  /**
   * While someone drives this PC (remote control, or playing on it with a pad) the screen goes out at its best, with
   * no new question from Windows: the running capture and encoder are changed, and changed back afterwards.
   */
  const driveScreen = useCallback(async (driven: boolean) => {
    // A phone's screen keeps its own way, smoothness first, whoever drives it (see `sharePhone`).
    if (phoneRef.current) return;
    const settings = screenSettingsRef.current;
    const track = roomRef.current?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined;
    const sender = track?.sender;
    if (!settings || !track || !sender) return;
    const capture = track.mediaStreamTrack;
    const hint = screenPreset(settings).hint;
    let quality = presetQuality(settings);
    if (driven) {
      const stats = [...(await sender.getStats()).values()] as { type: string; powerEfficientEncoder?: boolean }[];
      const hardware = stats.some((s) => s.type === "outbound-rtp" && s.powerEfficientEncoder === true);
      const { width, height } = capture.getCapabilities?.() ?? {};
      quality = drivenQuality(settings, width?.max && height?.max ? { width: width.max, height: height.max } : null, hardware);
    }
    // Our own capture is changed in Rust; WebView2's by the track's constraints.
    if (ownRef.current) await invoke("capture_tune", { quality: { width: quality.width, height: quality.height, fps: quality.fps } }).catch(() => {});
    else await capture.applyConstraints({ width: quality.width, height: quality.height, frameRate: quality.fps }).catch(() => {});
    capture.contentHint = driven ? "motion" : hint;
    const parameters = sender.getParameters();
    const top = parameters.encodings[parameters.encodings.length - 1];
    if (top) {
      top.maxBitrate = codecBitrate(quality.bitrate, screenEncoderRef.current?.codec ?? "av1");
      top.maxFramerate = encoderFpsCap(quality.fps);
      await sender.setParameters(parameters).catch(() => {});
    }
    // While someone drives it, frames over sharpness when the link falls short (a mouse that jumps is worse than a
    // softer picture, as Parsec does); the chosen quality's own way otherwise.
    await track.setDegradationPreference(driven ? "maintain-framerate" : hint === "detail" ? "maintain-resolution" : "maintain-framerate").catch(() => {});
  }, []);

  /** Lets our own capture go: Rust (or Android) stops, the tracks end. */
  const dropOwn = useCallback(() => {
    const phone = phoneRef.current;
    if (phone) {
      phoneRef.current = null;
      android()?.send({ op: "screen-stop" });
      phone.stop();
    }
    const own = ownRef.current;
    if (!own) return;
    ownRef.current = null;
    void invoke("capture_stop").catch(() => {});
    own.video.stop();
    own.audio?.stop();
  }, []);

  /**
   * Shows the phone's screen: Android asks the person itself («начать запись или трансляцию?»), then draws the screen at
   * the chosen size, with other apps' sound if asked and the phone allows it. The frames go out encrypted with the keys
   * of the call, like a PC's screen. Null when it is on (or the person said no); the reason otherwise.
   */
  const sharePhone = useCallback(
    async (screen: ScreenSettings, encoder: ScreenEncoder): Promise<string | null> => {
      const room = roomRef.current;
      if (!room || room.state !== "connected") return "Сначала зайди в голосовой канал";
      const bridge = android();
      if (!bridge) return "Показ экрана телефона есть только в приложении для Android";
      dropOwn();
      const preset = screenPreset(screen);
      const withSound = screen.audio && bridge.features?.screenAudio !== false;
      // Made first: the first frames come right after the yes.
      const capture = new AndroidScreen(bridge, withSound);
      phoneRef.current = capture;
      const answer = bridge.next((w) => w.ev === "screen" && w.state !== "off", 5 * 60_000);
      bridge.send({ op: "screen-start", width: preset.width, height: preset.height, fps: preset.fps, audio: withSound });
      const word = await answer;
      const failed = (why: string | null) => {
        if (phoneRef.current === capture) phoneRef.current = null;
        capture.stop();
        return why;
      };
      if (!word || word.state === "denied") return failed(null);
      if (word.state !== "on") return failed(typeof word.why === "string" ? word.why : "Android не дал показать экран");
      if (phoneRef.current !== capture || roomRef.current !== room) {
        bridge.send({ op: "screen-stop" });
        return failed(null);
      }
      // A phone's processor is no PC's: AV1 or VP9 in layers (what a PC picks) kept the full picture at some ten frames a
      // second there, as WebRTC holds a «detail» screen's size and drops frames instead. H.264 is the phone's video chip,
      // in one layer, as its camera already goes; and smoothness goes first, the picture's size giving way when short.
      const phoneEncoder: ScreenEncoder = { codec: "h264", hardware: true };
      void encoder;
      try {
        capture.video.contentHint = PHONE_SCREEN_HINT;
        await room.localParticipant.publishTrack(capture.video, {
          ...phoneScreenPublishOptions(screen),
          source: Track.Source.ScreenShare,
          name: "screen",
        });
        screenSettingsRef.current = screen;
        screenEncoderRef.current = phoneEncoder;
        if (roomRef.current === room) setSharing(true);
      } catch (e) {
        bridge.send({ op: "screen-stop" });
        return failed(`Не удалось показать экран: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!capture.audio) return null;
      if (word.audio !== true) return typeof word.audioWhy === "string" ? `Картинка идёт, а звук нет: ${word.audioWhy}` : null;
      try {
        await room.localParticipant.publishTrack(capture.audio, { ...screenPublishOptions(screen, phoneEncoder), source: Track.Source.ScreenShareAudio, name: "screen-audio" });
        return null;
      } catch (e) {
        return `Картинка идёт, а звук нет: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    [dropOwn],
  );

  /**
   * Shows `source`, picked in our own picker: Rust captures it without the mouse arrow, shrunk on the video card, and
   * the computer's sound (without this app) or the window's program's comes along. Its frames go out encrypted with the
   * keys of the call, like the voice. Null when it is on; the reason otherwise.
   */
  const shareOwn = useCallback(
    async (source: OwnSource, screen: ScreenSettings, encoder: ScreenEncoder): Promise<string | null> => {
      const room = roomRef.current;
      if (!room || room.state !== "connected") return "Сначала зайди в голосовой канал";
      const view = hostView();
      if (!view) return "Свой выбор экрана есть только в приложении для Windows";
      if (ownRef.current) dropOwn();
      const preset = screenPreset(screen);
      // The slots fit what driving the PC may raise the picture to.
      const most = drivenQuality(screen, null, true);
      const video = new OwnCaptureTrack(view);
      const own = { video, audio: null as OwnAudioTrack | null, source };
      ownRef.current = own;
      try {
        await invoke("capture_start", {
          source: { kind: source.kind, id: source.id },
          quality: { width: preset.width, height: preset.height, fps: preset.fps },
          limit: { width: Math.max(preset.width, most.width), height: Math.max(preset.height, most.height), fps: 60 },
        });
        video.track.contentHint = preset.hint;
        const options = screenPublishOptions(screen, encoder);
        await room.localParticipant.publishTrack(video.track, { ...options, source: Track.Source.ScreenShare, name: "screen" });
        screenSettingsRef.current = screen;
        screenEncoderRef.current = encoder;
        if (roomRef.current === room) setSharing(true);
      } catch (e) {
        const published = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
        if (published) await room.localParticipant.unpublishTrack(published).catch(() => {});
        if (ownRef.current === own) dropOwn();
        return `Не удалось показать: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!screen.audio) return null;
      // The picture is on; the sound is a second thing that may fail on its own (an old Windows).
      const audio = new OwnAudioTrack(view);
      try {
        await invoke("capture_audio_start", { from: source.kind === "window" ? { kind: "window", id: source.id } : { kind: "computer" } });
        if (ownRef.current !== own) throw new Error("показ уже остановлен");
        own.audio = audio;
        await room.localParticipant.publishTrack(audio.track, { ...screenPublishOptions(screen, encoder), source: Track.Source.ScreenShareAudio, name: "screen-audio" });
        return null;
      } catch (e) {
        audio.stop();
        if (own.audio === audio) own.audio = null;
        void invoke("capture_audio_stop").catch(() => {});
        return `Картинка идёт, а звук нет: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    [dropOwn],
  );

  const stopScreen = useCallback(async () => {
    const room = roomRef.current;
    setSharing(false);
    const own = ownRef.current;
    if (own && room) {
      for (const track of [own.video.track, own.audio?.track]) if (track) await room.localParticipant.unpublishTrack(track).catch(() => {});
    }
    const phone = phoneRef.current;
    if (phone && room) {
      for (const track of [phone.video, phone.audio]) if (track) await room.localParticipant.unpublishTrack(track).catch(() => {});
    }
    dropOwn();
    if (room && !own && !phone) await room.localParticipant.setScreenShareEnabled(false).catch(() => {});
  }, [dropOwn]);

  // Whatever ends our show (a leave, a moderator, the call dropping), our own capture goes with it.
  useEffect(() => {
    if (!sharing) dropOwn();
  }, [sharing, dropOwn]);

  // Android stopped the show (the person pressed «Остановить» in the status bar, or the projection ended).
  useEffect(
    () =>
      android()?.on((word) => {
        if (word.ev === "screen" && word.state === "off" && phoneRef.current) void stopScreen();
      }),
    [stopScreen],
  );

  // The window shown was closed, or the screen unplugged: the show ends.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void listen("capture-ended", () => {
      if (ownRef.current) void stopScreen();
    }).then((unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [stopScreen]);

  /**
   * Turns our camera on with `camera`'s device and size; its frames go out encrypted with the keys of the call, like the
   * voice. Null when it is on; what went wrong otherwise.
   */
  const startCamera = useCallback(
    async (camera: CameraSettings): Promise<string | null> => {
      const room = roomRef.current;
      if (!room || room.state !== "connected") return "Сначала зайди в голосовой канал";
      if (securityRef.current.state !== "secure") return "Камера включится, когда придут ключи шифрования звонка";
      // Opening a camera takes the system a second or more (a webcam on Windows up to several): the key says so meanwhile.
      setCameraStarting(true);
      try {
        await room.localParticipant.setCameraEnabled(true, cameraCaptureOptions(camera, IS_MOBILE), cameraPublishOptions(camera, IS_MOBILE));
        cameraSettingsRef.current = camera;
        if (roomRef.current === room) setCameraOn(room.localParticipant.isCameraEnabled);
        // Once a camera was used, Windows gives the cameras their names.
        void refreshDevices();
        return null;
      } catch (e) {
        const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
        if (track) await room.localParticipant.unpublishTrack(track, true).catch(() => track.stop());
        if (roomRef.current === room) setCameraOn(false);
        return cameraErrorText(e);
      } finally {
        setCameraStarting(false);
      }
    },
    [refreshDevices],
  );

  /** Turns our camera off and lets the device go (its light goes out). */
  const stopCamera = useCallback(async () => {
    const room = roomRef.current;
    setCameraOn(false);
    const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
    if (room && track) await room.localParticipant.unpublishTrack(track, true).catch(() => track.stop());
  }, []);

  /**
   * Another camera or size while the camera is on. Another camera of the same size (the phone's front and back, another
   * webcam) is swapped under the track that already goes out: no new publishing, no new negotiation, a moment instead of
   * seconds. Another size goes out anew (the size sets its layers and bits).
   */
  const applyCamera = useCallback(
    async (camera: CameraSettings): Promise<string | null> => {
      const room = roomRef.current;
      if (!room?.localParticipant.isCameraEnabled) return null;
      const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined;
      if (track && cameraSettingsRef.current?.quality === camera.quality) {
        try {
          await track.restartTrack(cameraCaptureOptions(camera, IS_MOBILE));
          cameraSettingsRef.current = camera;
          return null;
        } catch {
          // The new camera did not open in place: it goes out anew below.
        }
      }
      await stopCamera();
      return startCamera(camera);
    },
    [startCamera, stopCamera],
  );

  // While the call is not secure our camera sends nothing (see the lock above); secure again, it goes on.
  useEffect(() => {
    const track = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
    if (!track || !cameraOn) return;
    void (security.state === "secure" ? track.unmute() : track.mute()).then(bump, () => {});
  }, [security.state, cameraOn, bump]);

  const toggleMic = useCallback(() => {
    setMicOn((on) => {
      sound(on ? "mute" : "unmute");
      return !on;
    });
  }, [sound]);

  const toggleDeafen = useCallback(() => {
    setDeafened((d) => {
      sound(d ? "undeafen" : "deafen");
      return !d;
    });
  }, [sound]);

  const selectOutput = useCallback(async (deviceId: string) => {
    const room = roomRef.current;
    try {
      // Outside a call the shared context still plays the test sound and event sounds.
      if (room) await room.switchActiveDevice("audiooutput", deviceId);
      else await applyOutputDevice(getAudioContext(), deviceId);
    } catch (e) {
      setError(`Не удалось переключить динамики: ${String(e)}`);
    }
  }, []);

  // The call engine's keys and lock; an event for any call but the current one is ignored.
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const keep = (listening: Promise<() => void>) =>
      listening.then((stop) => (disposed ? stop() : stops.push(stop))).catch(() => {});
    keep(
      onCallKeys((event) => {
        const call = callRef.current;
        if (!call || event.address !== call.address || event.channel !== call.channel) return;
        call.provider.apply(event.keys, call.room.localParticipant.identity).catch(() => failEncryption(call));
        // The drawing board seals with keys made from these (see `board/crypto.ts`).
        setCallKeys(event);
      }),
    );
    keep(
      onCallState((event) => {
        const call = callRef.current;
        const next = nextSecurity(securityRef.current, event, call?.address ?? null, call?.channel ?? null);
        if (next === securityRef.current) return;
        showSecurity(next);
        // Now, not at the next render: while the old keys still decrypt, a dropped member is heard,
        // and our voice would go out on the last group's key. Secure again, the effect above unmutes.
        if (call) syncPlayback(call.room);
        if (next.state !== "secure") void micRef.current?.mute().catch(() => {});
        // So would the camera's frames.
        if (next.state !== "secure") void call?.room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack?.mute().catch(() => {});
        if (next.state === "failed") call?.waits.fail(new EncryptionError());
      }),
    );
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [failEncryption, showSecurity, syncPlayback]);

  useEffect(() => {
    return () => {
      const room = roomRef.current;
      roomRef.current = null;
      if (micRetryTimerRef.current) clearTimeout(micRetryTimerRef.current);
      void endCall(room);
    };
  }, [endCall]);

  const room = roomRef.current;
  // Bars and blame in the call: our link, and how each voice reaches us.
  const net = useNetStats(room, status === "connected");
  /**
   * Someone's camera, as their tile shows it: only an encrypted one of someone in the call's encryption, like a voice;
   * ours as we send it. None while it is muted.
   */
  const cameraOf = (view: ParticipantView) => {
    if (!room) return null;
    if (view.isLocal) {
      const own = room.localParticipant.getTrackPublication(Track.Source.Camera);
      return own && !own.isMuted ? (own.videoTrack ?? null) : null;
    }
    const publication = room.remoteParticipants.get(view.identity)?.getTrackPublication(Track.Source.Camera);
    if (!publication || publication.isMuted || !callRef.current) return null;
    return mayHear(publication, view.identity, security, callRef.current.tainted) ? (publication.videoTrack ?? null) : null;
  };
  // Whose music plays in the call and may be heard: ours while it goes, a friend's while their track is heard.
  const musicOf = (view: ParticipantView): boolean => {
    if (view.isLocal) return musicOn;
    const participant = room?.remoteParticipants.get(view.identity);
    if (!participant || !callRef.current) return false;
    for (const publication of participant.trackPublications.values()) {
      if (isMusicPublication(publication) && publication.track && mayHear(publication, view.identity, security, callRef.current.tainted)) return true;
    }
    return false;
  };
  const participants: ParticipantView[] =
    room && status !== "idle"
      ? withEncryption(
          toParticipantViews([room.localParticipant, ...room.remoteParticipants.values()], {
            // Lit when others actually hear us: mic live and voice detected.
            local: { speaking: sending && published && vadOpen, level: micLevel },
            remote: (identity) => (meteredRef.current.has(identity) ? metersRef.current?.tracker.get(identity) : NOT_HEARD),
          }),
          security,
          callRef.current?.tainted,
        ).map((view) => ({ ...view, camera: cameraOf(view), music: musicOf(view) }))
      : [];

  const musicPlayers = participants.filter((view) => view.music).map((view) => view.identity);
  /** The music track of `identity` (ours too), for the «Музыка» tab's bars. */
  const musicTrackOf = (identity: string): MediaStreamTrack | null => {
    if (identity === room?.localParticipant.identity) return musicRef.current?.track ?? null;
    for (const publication of room?.remoteParticipants.get(identity)?.trackPublications.values() ?? []) {
      if (isMusicPublication(publication)) return publication.track?.mediaStreamTrack ?? null;
    }
    return null;
  };

  // Friends' music goes down while someone else speaks and up again after (the listener may turn it off).
  const heardMusic = musicPlayers.some((identity) => identity !== room?.localParticipant.identity);
  useEffect(() => {
    const settle = (next: number) => {
      if (next === duckRef.current) return;
      duckRef.current = next;
      const room = roomRef.current;
      if (room) syncPlayback(room);
    };
    if (!heardMusic || !musicDuck) {
      settle(1);
      return;
    }
    let lastSpeech = Number.NEGATIVE_INFINITY;
    const timer = setInterval(() => {
      const now = performance.now();
      let speaking = false;
      for (const identity of meteredRef.current.keys()) if (metersRef.current?.tracker.get(identity)?.speaking) speaking = true;
      if (speaking) lastSpeech = now;
      settle(stepToward(duckRef.current, duckedNow(speaking, lastSpeech, now) ? DUCK_SHARE : 1, DUCK_STEP));
    }, DUCK_TICK_MS);
    return () => clearInterval(timer);
  }, [heardMusic, musicDuck, syncPlayback]);

  // The listener moved the music's volume: at once.
  useEffect(() => {
    const room = roomRef.current;
    if (room) syncPlayback(room);
  }, [musicVolume, syncPlayback]);

  // How loud our own music goes out: at once, on the track that goes.
  useEffect(() => {
    if (musicRef.current) musicRef.current.gain = musicSend;
  }, [musicSend, musicOn]);

  // Friends' cameras come in full while few are on, as their middle layer when many are (the download stays sane).
  const remoteCameras = participants.filter((p) => !p.isLocal && p.camera).length;
  useEffect(() => {
    const quality = remoteCameraQuality(remoteCameras);
    for (const participant of roomRef.current?.remoteParticipants.values() ?? []) {
      participant.getTrackPublication(Track.Source.Camera)?.setVideoQuality(quality);
    }
  }, [remoteCameras]);

  /** Our music stops for the call: the track goes, and Windows' capture of the program. */
  const stopMusic = useCallback(async () => {
    const music = musicRef.current;
    musicRef.current = null;
    setMusicOn(false);
    void musicStop().catch(() => {});
    if (!music) return;
    await roomRef.current?.localParticipant.unpublishTrack(music.track).catch(() => {});
    music.stop();
  }, []);

  /**
   * Plays program `pid`'s sound for the call (music together): Windows captures that program alone, the page makes it a
   * track of its own, encrypted like the rest. The error to show, or null.
   */
  const startMusic = useCallback(
    async (pid: number): Promise<string | null> => {
      const room = roomRef.current;
      if (!room || room.state !== "connected") return "Сначала зайди в голосовой канал";
      const view = hostView();
      if (!view) return "Музыку можно включать только с ПК на Windows";
      await stopMusic();
      // Listening before Rust hands the buffer over, as the screen's sound does.
      const music = new OwnAudioTrack(view, "music");
      music.gain = musicSendRef.current;
      musicRef.current = music;
      try {
        await musicStart(pid);
      } catch (e) {
        music.stop();
        if (musicRef.current === music) musicRef.current = null;
        return `Звук этой программы не взять: ${e instanceof Error ? e.message : String(e)}`;
      }
      try {
        if (musicRef.current !== music || roomRef.current !== room) throw new Error("музыку уже остановили");
        await room.localParticipant.publishTrack(music.track, musicPublishOptions());
        setMusicOn(true);
        return null;
      } catch (e) {
        void musicStop().catch(() => {});
        music.stop();
        if (musicRef.current === music) musicRef.current = null;
        return musicErrorText(e);
      }
    },
    [stopMusic],
  );

  /** A note to the other end of control (see `REMOTE_NOTE_TOPIC`), to `to` alone. */
  const sendRemoteNote = useCallback(async (note: RemoteNote, to: string) => {
    await roomRef.current?.localParticipant.publishData(encodeRemoteNote(note), { reliable: true, destinationIdentities: [to], topic: REMOTE_NOTE_TOPIC });
  }, []);

  /** Sealed remote-control input to `to` alone: reliable (buttons, keys) or as fast as it goes (mouse moves). */
  const sendRemote = useCallback(async (packet: Uint8Array<ArrayBuffer>, to: string, reliable: boolean) => {
    await roomRef.current?.localParticipant.publishData(packet, { reliable, destinationIdentities: [to], topic: REMOTE_TOPIC });
  }, []);

  /** A sealed packet of the drawing board to everyone in the call, in order. */
  const sendDrawing = useCallback(async (packet: Uint8Array<ArrayBuffer>) => {
    await roomRef.current?.localParticipant.publishData(packet, { reliable: true, topic: DRAW_TOPIC });
  }, []);

  /** Our sealed pad state to `to` alone, as fast as it goes: the next one carries the whole state anyway. */
  const sendPad = useCallback(async (packet: Uint8Array<ArrayBuffer>, to: string) => {
    await roomRef.current?.localParticipant.publishData(packet, { reliable: false, destinationIdentities: [to], topic: PAD_TOPIC });
  }, []);

  /** While we control someone's PC (or play on it) their screen is played at once, with no buffer. */
  const lowLatency = useCallback(
    (identity: string, on: boolean) => {
      if (on) atOnceRef.current.add(identity);
      else atOnceRef.current.delete(identity);
      screenBuffer(identity);
    },
    [screenBuffer],
  );

  const screens: ScreenView[] = [];
  if (room && status !== "idle") {
    const own = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    if (own) screens.push({ identity: room.localParticipant.identity, isLocal: true, track: ownScreenShown ? own : null, watching: ownScreenShown, hasAudio: false });
    for (const participant of room.remoteParticipants.values()) {
      const publication = participant.getTrackPublication(Track.Source.ScreenShare);
      // Never a screen whose frames are not encrypted: like a voice, it would not be ours to trust.
      if (!publication || !publication.isEncrypted || callRef.current?.tainted.has(participant.identity)) continue;
      const watching = !closedScreens.has(participant.identity);
      screens.push({
        identity: participant.identity,
        isLocal: false,
        track: watching ? (publication.videoTrack ?? null) : null,
        watching,
        hasAudio: !!participant.getTrackPublication(Track.Source.ScreenShareAudio),
        frozen: participant.attributes?.[ATTR_SCREEN_FROZEN] === "1",
        phone: participant.attributes?.[ATTR_DEVICE] === "phone",
      });
    }
  }

  // A sound of the sound board, into the call with the voice.
  const playBoard = useCallback((id: string) => {
    const samples = boardSound(id);
    return !!samples && !!pipelineRef.current?.pipeline.playIntoCall(samples, BOARD_RATE);
  }, []);

  return {
    playBoard,
    status,
    error,
    address,
    channelId,
    participants,
    net,
    screens,
    watchScreen,
    micOn,
    deafened,
    transmitting,
    micLevel,
    inputs,
    outputs,
    join,
    leave,
    toggleMic,
    toggleDeafen,
    selectOutput,
    security,
    retryEncryption,
    sharing,
    shareScreen,
    shareOwn,
    sharePhone,
    sendRemoteNote,
    musicOn,
    musicPlayers,
    musicTrackOf,
    startMusic,
    stopMusic,
    shareFrozen,
    driveScreen,
    stopScreen,
    cameraOn,
    cameraStarting,
    cameras,
    startCamera,
    stopCamera,
    applyCamera,
    sendRemote,
    sendPad,
    sendDrawing,
    lowLatency,
  };
}
