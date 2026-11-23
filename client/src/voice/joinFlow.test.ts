import { describe, expect, it, vi } from "vitest";
import { TrackEvent } from "livekit-client";
import { connectRoom, startMic, watchMicLoss } from "./joinFlow";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fakeRoom = () => ({
  connect: vi.fn(async (_url: string, _token: string) => {}),
  startAudio: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
});

const fakeMic = () => {
  const mic = {
    muted: false,
    stopped: false,
    log: [] as string[],
    mute: vi.fn(async () => {
      mic.muted = true;
      mic.log.push("mute");
    }),
    unmute: vi.fn(async () => {
      mic.muted = false;
      mic.log.push("unmute");
    }),
    stop: vi.fn(() => {
      mic.stopped = true;
    }),
  };
  return mic;
};

const token = async () => ({ url: "ws://lk", token: "t" });

describe("connectRoom", () => {
  it("connects and starts audio when nothing interrupts", async () => {
    const room = fakeRoom();
    expect(await connectRoom({ room, isCurrent: () => true, getToken: token })).toEqual({ kind: "ok" });
    expect(room.connect).toHaveBeenCalledWith("ws://lk", "t");
    expect(room.startAudio).toHaveBeenCalled();
  });

  it("never connects when the user left during the token request", async () => {
    const room = fakeRoom();
    let current = true;
    const result = await connectRoom({
      room,
      isCurrent: () => current,
      getToken: async () => {
        current = false;
        return token();
      },
    });
    expect(result).toEqual({ kind: "stale" });
    expect(room.connect).not.toHaveBeenCalled();
  });

  it("disconnects a room that finished connecting after the user left", async () => {
    const room = fakeRoom();
    let current = true;
    room.connect.mockImplementation(async () => {
      current = false;
    });
    expect(await connectRoom({ room, isCurrent: () => current, getToken: token })).toEqual({ kind: "stale" });
    expect(room.disconnect).toHaveBeenCalled();
  });

  it("does not report a connect aborted by leaving as an error", async () => {
    const room = fakeRoom();
    let current = true;
    room.connect.mockImplementation(async () => {
      current = false;
      throw new Error("Client initiated disconnect");
    });
    expect(await connectRoom({ room, isCurrent: () => current, getToken: token })).toEqual({ kind: "stale" });
  });

  it("reports a real connect failure and disconnects", async () => {
    const room = fakeRoom();
    const error = new Error("could not establish signal connection");
    room.connect.mockRejectedValue(error);
    expect(await connectRoom({ room, isCurrent: () => true, getToken: token })).toEqual({ kind: "failed", error });
    expect(room.disconnect).toHaveBeenCalled();
  });
});

describe("startMic", () => {
  const steps = (mic: ReturnType<typeof fakeMic>, room = fakeRoom()) => ({
    room,
    isCurrent: () => true,
    createMic: async () => mic,
    prepareMic: vi.fn(async () => {}),
    waitKeys: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    wantSending: () => true,
    onMic: vi.fn(),
  });

  it("publishes a muted mic when the user is not sending yet", async () => {
    const mic = fakeMic();
    const s = { ...steps(mic), wantSending: () => false };
    s.publish.mockImplementation(async () => {
      mic.log.push("publish");
    });
    expect(await startMic(s)).toEqual({ kind: "ok" });
    expect(mic.log.slice(0, 2)).toEqual(["mute", "publish"]);
    expect(mic.muted).toBe(true);
    expect(s.onMic).toHaveBeenCalledWith(mic);
  });

  it("applies a mute that happened while publishing", async () => {
    const mic = fakeMic();
    let sending = true;
    const s = { ...steps(mic), wantSending: () => sending };
    s.publish.mockImplementation(async () => {
      sending = false;
    });
    await startMic(s);
    expect(mic.muted).toBe(true);
  });

  it("applies an unmute that happened while publishing", async () => {
    const mic = fakeMic();
    let sending = false;
    const s = { ...steps(mic), wantSending: () => sending };
    s.publish.mockImplementation(async () => {
      sending = true;
    });
    await startMic(s);
    expect(mic.muted).toBe(false);
  });

  it("stops the mic and disconnects when the user left during publishing", async () => {
    const mic = fakeMic();
    let current = true;
    const s = { ...steps(mic), isCurrent: () => current };
    s.publish.mockImplementation(async () => {
      current = false;
      throw new Error("cannot publish track when not connected");
    });
    expect(await startMic(s)).toEqual({ kind: "stale" });
    expect(mic.stopped).toBe(true);
    expect(s.room.disconnect).toHaveBeenCalled();
    expect(s.onMic).not.toHaveBeenCalled();
  });

  it("does not publish a mic prepared after the user left", async () => {
    const mic = fakeMic();
    let current = true;
    const s = { ...steps(mic), isCurrent: () => current };
    s.prepareMic.mockImplementation(async () => {
      current = false;
    });
    expect(await startMic(s)).toEqual({ kind: "stale" });
    expect(s.publish).not.toHaveBeenCalled();
    expect(mic.stopped).toBe(true);
  });

  it("stops the mic and reports a publish failure", async () => {
    const mic = fakeMic();
    const error = new Error("publish timed out");
    const s = steps(mic);
    s.publish.mockRejectedValue(error);
    expect(await startMic(s)).toEqual({ kind: "failed", error });
    expect(mic.stopped).toBe(true);
    expect(s.room.disconnect).not.toHaveBeenCalled();
  });

  it("reports a mic that could not be opened", async () => {
    const error = Object.assign(new Error("no device"), { name: "NotFoundError" });
    const s = {
      ...steps(fakeMic()),
      createMic: async () => {
        throw error;
      },
    };
    expect(await startMic(s)).toEqual({ kind: "failed", error });
  });

  it("does not publish the mic until the keys are ready", async () => {
    const mic = fakeMic();
    const keys = deferred();
    const s = steps(mic);
    s.waitKeys.mockReturnValue(keys.promise);
    s.prepareMic.mockImplementation(async () => {
      mic.log.push("prepare");
    });
    s.publish.mockImplementation(async () => {
      mic.log.push("publish");
    });
    const result = startMic(s);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.waitKeys).toHaveBeenCalledTimes(1);
    expect(s.publish).not.toHaveBeenCalled();
    expect(s.onMic).not.toHaveBeenCalled();

    keys.resolve();
    expect(await result).toEqual({ kind: "ok" });
    expect(s.publish).toHaveBeenCalledTimes(1);
    // The mic is opened and prepared while the keys come, then published.
    expect(mic.log.slice(0, 2)).toEqual(["prepare", "publish"]);
  });

  it("waits for the keys with the mic already muted when the user is not sending", async () => {
    const mic = fakeMic();
    const keys = deferred();
    const s = { ...steps(mic), wantSending: () => false };
    s.waitKeys.mockImplementation(() => {
      mic.log.push("wait");
      return keys.promise;
    });
    s.publish.mockImplementation(async () => {
      mic.log.push("publish");
    });
    const result = startMic(s);
    await new Promise((resolve) => setTimeout(resolve, 0));
    keys.resolve();
    await result;
    expect(mic.log.slice(0, 3)).toEqual(["mute", "wait", "publish"]);
  });

  it("mutes a mic the user released while the keys were coming", async () => {
    const mic = fakeMic();
    const keys = deferred();
    let sending = true;
    const s = { ...steps(mic), wantSending: () => sending };
    s.waitKeys.mockReturnValue(keys.promise);
    s.publish.mockImplementation(async () => {
      mic.log.push("publish");
    });
    const result = startMic(s);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sending = false;
    keys.resolve();
    await result;
    // Not a moment on air after the user let go: muted before it is published.
    expect(mic.log.slice(0, 2)).toEqual(["mute", "publish"]);
    expect(mic.muted).toBe(true);
  });

  it("stops the mic when the keys never come", async () => {
    const mic = fakeMic();
    const error = new Error("Не удалось зашифровать звонок");
    const s = steps(mic);
    s.waitKeys.mockRejectedValue(error);
    expect(await startMic(s)).toEqual({ kind: "failed", error });
    expect(mic.stopped).toBe(true);
    expect(s.publish).not.toHaveBeenCalled();
    expect(s.onMic).not.toHaveBeenCalled();
    expect(s.room.disconnect).not.toHaveBeenCalled();
  });

  it("does not publish keys that came after the user left", async () => {
    const mic = fakeMic();
    let current = true;
    const keys = deferred();
    const s = { ...steps(mic), isCurrent: () => current };
    s.waitKeys.mockReturnValue(keys.promise);
    const result = startMic(s);
    await new Promise((resolve) => setTimeout(resolve, 0));
    current = false;
    keys.resolve();
    expect(await result).toEqual({ kind: "stale" });
    expect(s.publish).not.toHaveBeenCalled();
    expect(mic.stopped).toBe(true);
    expect(s.room.disconnect).toHaveBeenCalled();
  });

  it("does not report keys that failed after the user left as an error", async () => {
    const mic = fakeMic();
    let current = true;
    const s = { ...steps(mic), isCurrent: () => current };
    s.waitKeys.mockImplementation(async () => {
      current = false;
      throw new Error("call ended");
    });
    expect(await startMic(s)).toEqual({ kind: "stale" });
    expect(mic.stopped).toBe(true);
    expect(s.publish).not.toHaveBeenCalled();
  });

  it("waits for a slow publish without reporting the mic early", async () => {
    const mic = fakeMic();
    const publishing = deferred();
    const s = steps(mic);
    s.publish.mockReturnValue(publishing.promise);
    const result = startMic(s);
    await Promise.resolve();
    expect(s.onMic).not.toHaveBeenCalled();
    publishing.resolve();
    expect(await result).toEqual({ kind: "ok" });
  });
});

describe("watchMicLoss", () => {
  const fakeTrack = () => {
    const handlers = new Map<string, () => void>();
    return {
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
      off: vi.fn((event: string) => handlers.delete(event)),
      emit: (event: string) => handlers.get(event)?.(),
    };
  };

  it("reports a mute LiveKit did on its own while the user was sending", () => {
    const track = fakeTrack();
    const onLost = vi.fn();
    watchMicLoss(track, () => true, onLost);
    track.emit(TrackEvent.Muted);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("ignores mutes the app asked for", () => {
    const track = fakeTrack();
    const onLost = vi.fn();
    watchMicLoss(track, () => false, onLost);
    track.emit(TrackEvent.Muted);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("stops watching when unsubscribed", () => {
    const track = fakeTrack();
    const onLost = vi.fn();
    watchMicLoss(track, () => true, onLost)();
    track.emit(TrackEvent.Muted);
    expect(onLost).not.toHaveBeenCalled();
  });
});
