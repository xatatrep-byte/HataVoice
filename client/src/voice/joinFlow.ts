import { TrackEvent } from "livekit-client";

// The join sequence, kept apart from React so its races can be tested against fakes.
// Every step re-checks `isCurrent()`: a leave or a newer join may have happened during any await.

export type StepResult = { kind: "ok" } | { kind: "stale" } | { kind: "failed"; error: unknown };

export type JoinRoom = {
  connect(url: string, token: string): Promise<void>;
  startAudio(): Promise<void>;
  disconnect(): Promise<void>;
};

export type JoinMic = {
  mute(): Promise<unknown>;
  unmute(): Promise<unknown>;
  stop(): void;
};

const OK: StepResult = { kind: "ok" };
const STALE: StepResult = { kind: "stale" };

/** Gets a token and connects; a room left behind by a stale join is disconnected. */
export async function connectRoom({
  room,
  isCurrent,
  getToken,
}: {
  room: JoinRoom;
  /** False once a leave or a newer join has replaced this one. */
  isCurrent: () => boolean;
  getToken: () => Promise<{ url: string; token: string }>;
}): Promise<StepResult> {
  try {
    const { url, token } = await getToken();
    if (!isCurrent()) return STALE;
    await room.connect(url, token);
    await room.startAudio();
  } catch (error) {
    await room.disconnect();
    return isCurrent() ? { kind: "failed", error } : STALE;
  }
  if (isCurrent()) return OK;
  await room.disconnect();
  return STALE;
}

/**
 * Opens, prepares and publishes the mic, but only once `waitKeys` says the call's keys are in:
 * there is no unencrypted call. A mic that never reaches `onMic` is stopped, so a failed or
 * abandoned join never keeps the microphone open.
 */
export async function startMic<R extends JoinRoom, M extends JoinMic>({
  room,
  isCurrent,
  createMic,
  prepareMic,
  waitKeys,
  publish,
  wantSending,
  onMic,
}: {
  room: R;
  isCurrent: () => boolean;
  createMic: () => Promise<M>;
  prepareMic: (mic: M) => Promise<void>;
  /** Resolves when our own key is set; rejects when the keys will not come (or the call is gone). */
  waitKeys: () => Promise<void>;
  publish: (room: R, mic: M) => Promise<void>;
  /** Whether the mic should be live right now: mic button, deafen and push-to-talk. */
  wantSending: () => boolean;
  onMic: (mic: M) => void;
}): Promise<StepResult> {
  let mic: M | undefined;
  try {
    mic = await createMic();
    await prepareMic(mic);
    // Muted before publishing, so push-to-talk users never leak audio while joining.
    const wanted = wantSending();
    if (!wanted) await mic.mute();
    // The mic is open and ready while the keys come; nothing is published before them.
    await waitKeys();
    // Push-to-talk may have been let go while we waited: still muted at the moment of publishing.
    if (wanted && !wantSending()) await mic.mute();
    if (isCurrent()) await publish(room, mic);
  } catch (error) {
    mic?.stop();
    if (isCurrent()) return { kind: "failed", error };
    await room.disconnect();
    return STALE;
  }
  if (!isCurrent()) {
    mic.stop();
    await room.disconnect();
    return STALE;
  }
  onMic(mic);
  // The mic button, deafen or push-to-talk may have changed while publishing.
  await (wantSending() ? mic.unmute() : mic.mute());
  return OK;
}

type TrackEvents = {
  on(event: TrackEvent.Muted, handler: () => void): unknown;
  off(event: TrackEvent.Muted, handler: () => void): unknown;
};

/**
 * When the mic device disappears, LiveKit tries the default device and mutes the track if that
 * fails too. A mute while the user wants to be heard is that case. Returns an unsubscribe.
 */
export function watchMicLoss(track: TrackEvents, wantSending: () => boolean, onLost: () => void): () => void {
  const handler = () => {
    if (wantSending()) onLost();
  };
  track.on(TrackEvent.Muted, handler);
  return () => track.off(TrackEvent.Muted, handler);
}
