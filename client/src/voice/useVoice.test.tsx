// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// The wiring of the encrypted call in `useVoice`, against a fake LiveKit room, a fake worker and a
// fake Rust side. The logic itself is tested in joinFlow, callSecurity and participants.

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => {
  const log: string[] = [];
  const state = {
    rooms: [] as any[],
    workers: [] as any[],
    keysHandler: null as null | ((event: any) => void),
    stateHandler: null as null | ((event: any) => void),
    mic: null as any,
    onLevel: null as null | ((db: number) => void),
    /** Holds `room.connect` until released. */
    connectGate: null as null | Promise<void>,
    /** What the next room's local participant is allowed to do. */
    canPublish: true,
    metersAdded: [] as string[],
    metersRemoved: [] as string[],
  };
  return { log, state };
});

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  class FakeRoom {
    static getLocalDevices = vi.fn(async () => []);
    options: any;
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    remoteParticipants = new Map<string, any>();
    localParticipant: any;
    constructor(options: any) {
      this.options = options;
      this.localParticipant = {
        identity: "me",
        name: "Me",
        isLocal: true,
        isSpeaking: false,
        isMicrophoneEnabled: true,
        attributes: {},
        permissions: { canPublish: h.state.canPublish },
        isE2EEEnabled: false,
        // Publications by source: only the screen is looked up this way, and nobody shows one here.
        getTrackPublication: () => undefined,
        publishTrack: vi.fn(async () => {
          h.log.push("publishTrack");
        }),
        unpublishTrack: vi.fn(async () => {}),
        setAttributes: vi.fn(async () => {}),
      };
      h.state.rooms.push(this);
    }
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    connect = vi.fn(async () => {
      h.log.push("connect");
      await h.state.connectGate;
    });
    startAudio = vi.fn(async () => {});
    disconnect = vi.fn(async () => {
      h.log.push("disconnect");
    });
    setE2EEEnabled = vi.fn(async (on: boolean) => {
      h.log.push(`setE2EEEnabled:${on}`);
      this.localParticipant.isE2EEEnabled = on;
    });
    switchActiveDevice = vi.fn(async () => {});
  }
  return {
    ...actual,
    Room: FakeRoom,
    createLocalAudioTrack: vi.fn(async () => {
      h.log.push("openMic");
      h.state.mic = {
        setAudioContext: vi.fn(async () => {}),
        setProcessor: vi.fn(async () => {}),
        mute: vi.fn(async () => {}),
        unmute: vi.fn(async () => {}),
        stop: vi.fn(() => h.log.push("micStop")),
        on: vi.fn(),
        off: vi.fn(),
        restartTrack: vi.fn(async () => {}),
      };
      return h.state.mic;
    }),
  };
});

vi.mock("../audio/audioContext", () => ({
  getAudioContext: () => ({ resume: vi.fn(async () => {}) }),
  applyOutputDevice: vi.fn(async () => {}),
}));
vi.mock("../audio/micPipeline", () => ({
  MicPipeline: class {
    constructor(options: { onLevel: (db: number) => void }) {
      h.state.onLevel = options.onLevel;
    }
    setGateOpen() {}
  },
}));
vi.mock("../audio/sounds", () => ({ playSound: vi.fn() }));
// The next try at a busy mic comes soon here, not after seconds.
vi.mock("./micRetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./micRetry")>()),
  micRetryDelay: () => 50,
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => null),
}));
vi.mock("./remoteMeters", () => ({
  RemoteVoiceMeters: class {
    tracker = { get: () => undefined };
    add(id: string) {
      h.state.metersAdded.push(id);
    }
    remove(id: string) {
      h.state.metersRemoved.push(id);
    }
    clear() {}
    sample() {}
  },
}));

vi.mock("../server/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/session")>();
  return {
    ...actual,
    voiceToken: vi.fn(async () => ({ url: "ws://127.0.0.1:1/x", token: "t" })),
    callJoin: vi.fn(async (address: string, channel: string) => {
      h.log.push(`callJoin:${address}/${channel}`);
    }),
    callLeave: vi.fn(async () => {
      h.log.push("callLeave");
    }),
    callPresence: vi.fn(async (address: string, channel: string, ids: string[]) => {
      h.log.push(`callPresence:${address}/${channel}:${ids.join(",")}`);
    }),
    onCallKeys: vi.fn(async (handler: (event: any) => void) => {
      h.state.keysHandler = handler;
      return () => {};
    }),
    onCallState: vi.fn(async (handler: (event: any) => void) => {
      h.state.stateHandler = handler;
      return () => {};
    }),
  };
});

import { createLocalAudioTrack } from "livekit-client";
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "../audio/settings";
import type { VolumeMap } from "../audio/volumes";
import { callJoin } from "../server/session";
import { MIC_RETRYING } from "./errors";
import { useVoice } from "./useVoice";

const ADDR = "1.2.3.4:7350";
const GENERAL = "general";
const ENCRYPTION_FAILED = "Не удалось зашифровать звонок";

/** 32 bytes of `byte` as base64url without padding, as the Rust side sends a key. */
const b64 = (byte: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const flush = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const hook = (volumes: VolumeMap = {}) =>
  renderHook(() => useVoice({ settings: DEFAULT_AUDIO_SETTINGS, pttOpen: false, volumes }));
type Voice = ReturnType<typeof hook>["result"];

const stateEvent = (state: string, extra: object = {}) => ({
  address: ADDR,
  channel: GENERAL,
  state,
  code: null,
  members: [],
  error: null,
  ...extra,
});

const keysEvent = (epoch: number, byte: number, channel = GENERAL) => ({
  address: ADDR,
  channel,
  epoch,
  keys: [{ identity: "me", index: epoch, key: b64(byte) }],
});

/** Starts a join and lets it get as far as it can without keys; `done` settles when the join does. */
async function join(result: Voice, channelId = GENERAL) {
  let done!: Promise<void>;
  act(() => {
    done = result.current.join({ address: ADDR, channelId });
  });
  await flush();
  return { done };
}

/** The call engine reports a secure call with `members` and delivers our key. */
async function secure(members: string[] = ["me"], epoch = 1, channel = GENERAL) {
  act(() => h.state.stateHandler!(stateEvent("secure", { code: "03817 55920 11111 22222 33333 44444", members, channel })));
  await act(async () => {
    h.state.keysHandler!(keysEvent(epoch, epoch, channel));
  });
  await flush(10);
}

/** A microphone publication of `identity` with its track, which counts what is done to it. */
function publicationOf(identity: string, key: string, encrypted: boolean) {
  const elements: HTMLElement[] = [];
  const track = {
    kind: "audio",
    mediaStreamTrack: { id: `${identity}-${key}-media` },
    attachedElements: elements,
    attach: vi.fn(() => {
      const element = document.createElement("audio");
      elements.push(element);
      return element;
    }),
    detach: vi.fn(() => elements.splice(0)),
    setVolume: vi.fn(),
  };
  const publication: any = {
    kind: "audio",
    source: "microphone",
    isEncrypted: encrypted,
    isDesired: true,
    track,
    setSubscribed: vi.fn((on: boolean) => {
      publication.isDesired = on;
    }),
  };
  return { publication, track };
}

/** The participant publishes one more track, as the server may make it look. */
function addPublication(person: ReturnType<typeof remote>, key: string, { encrypted }: { encrypted: boolean }) {
  const extra = publicationOf(person.participant.identity, key, encrypted);
  const id = `${person.participant.identity}-${key}`;
  person.participant.trackPublications.set(id, extra.publication);
  person.participant.audioTrackPublications.set(id, extra.publication);
  const remove = () => {
    person.participant.trackPublications.delete(id);
    person.participant.audioTrackPublications.delete(id);
  };
  return { ...extra, remove };
}

/** A remote participant with one microphone publication. */
function remote(
  room: any,
  identity: string,
  { encrypted = true, speaking = false }: { encrypted?: boolean; speaking?: boolean } = {},
) {
  const { publication, track } = publicationOf(identity, "mic", encrypted);
  const participant: any = {
    identity,
    name: identity,
    isLocal: false,
    isSpeaking: speaking,
    isMicrophoneEnabled: true,
    attributes: {},
    setVolume: vi.fn(),
    trackPublications: new Map([[`${identity}-mic`, publication]]),
    audioTrackPublications: new Map([[`${identity}-mic`, publication]]),
    getTrackPublication: (source: string) => [...participant.trackPublications.values()].find((pub: any) => pub.source === source),
  };
  room.remoteParticipants.set(identity, participant);
  return { participant, publication, track };
}

beforeEach(() => {
  h.log.length = 0;
  h.state.rooms.length = 0;
  h.state.workers.length = 0;
  h.state.keysHandler = null;
  h.state.stateHandler = null;
  h.state.mic = null;
  h.state.onLevel = null;
  h.state.connectGate = null;
  h.state.canPublish = true;
  h.state.metersAdded.length = 0;
  h.state.metersRemoved.length = 0;
  (globalThis as any).Worker = class {
    terminate = vi.fn(() => h.log.push("workerTerminate"));
    postMessage = vi.fn();
    constructor() {
      h.state.workers.push(this);
    }
  };
});

afterEach(() => {
  delete (globalThis as any).Worker;
  document.body.innerHTML = "";
});

describe("useVoice: an encrypted call", () => {
  it("turns encryption on before anything else and gives the room its own provider and worker", async () => {
    const { result } = hook();
    await flush();
    await join(result);

    const room = h.state.rooms[0];
    expect(room.options.e2ee.keyProvider).toBeTruthy();
    expect(room.options.e2ee.worker).toBe(h.state.workers[0]);
    expect(room.options.publishDefaults.red).toBe(false);
    expect(h.log.slice(0, 3)).toEqual(["connect", "setE2EEEnabled:true", `callJoin:${ADDR}/${GENERAL}`]);
    expect(h.log).not.toContain("publishTrack");
  });

  it("opens the mic while the keys come but publishes it only after our own key", async () => {
    const { result } = hook();
    await flush();
    const { done } = await join(result);
    expect(h.log).toContain("openMic");
    expect(h.log).not.toContain("publishTrack");
    expect(result.current.security.state).toBe("pending");
    expect(result.current.status).toBe("connected");

    // A group without our key yet changes nothing.
    act(() => h.state.stateHandler!(stateEvent("secure", { code: "1", members: ["me", "anya"] })));
    await flush(10);
    expect(h.log).not.toContain("publishTrack");

    await act(async () => {
      h.state.keysHandler!({
        address: ADDR,
        channel: GENERAL,
        epoch: 1,
        keys: [
          { identity: "anya", index: 1, key: b64(2) },
          { identity: "me", index: 1, key: b64(1) },
        ],
      });
    });
    await flush(10);
    await done;
    expect(h.log).toContain("publishTrack");
    expect(result.current.security.state).toBe("secure");
  });

  it("refuses to publish into a room that is not encrypting", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    h.state.rooms[0].localParticipant.isE2EEEnabled = false;
    await act(async () => {
      h.state.keysHandler!(keysEvent(1, 3));
    });
    await flush(10);
    expect(h.log).not.toContain("publishTrack");
    expect(result.current.error).toBe(ENCRYPTION_FAILED);
  });

  it("ignores the keys and the state of another channel", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    act(() => h.state.stateHandler!(stateEvent("secure", { channel: "music", members: ["me"] })));
    expect(result.current.security.state).toBe("pending");
    await act(async () => {
      h.state.keysHandler!(keysEvent(1, 3, "music"));
    });
    await flush(10);
    expect(h.log).not.toContain("publishTrack");
  });

  it("marks who is inside the encryption", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    remote(room, "anya");
    remote(room, "ghost");
    await secure(["me", "anya"]);
    expect(result.current.participants.map((p) => [p.identity, p.encrypted])).toEqual([
      ["me", true],
      ["anya", true],
      ["ghost", false],
    ]);
  });
});

describe("useVoice: the call engine", () => {
  it("reports who is in the room, ourselves included, and updates it as people come and go", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    expect(h.log).toContain(`callPresence:${ADDR}/${GENERAL}:me`);

    remote(room, "anya");
    act(() => room.emit("participantConnected"));
    await flush();
    expect(h.log).toContain(`callPresence:${ADDR}/${GENERAL}:me,anya`);

    room.remoteParticipants.delete("anya");
    act(() => room.emit("participantDisconnected", { identity: "anya" }));
    await flush();
    const reports = h.log.filter((line) => line.startsWith("callPresence"));
    expect(reports[reports.length - 1]).toBe(`callPresence:${ADDR}/${GENERAL}:me`);
  });

  it("does not report an empty room in the middle of a full reconnect", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    remote(room, "anya");
    h.log.length = 0;

    // LiveKit drops everyone first and only then says it is reconnecting.
    room.remoteParticipants.clear();
    act(() => {
      room.emit("participantDisconnected", { identity: "anya" });
      room.emit("reconnecting");
    });
    await flush();
    expect(h.log.filter((line) => line.startsWith("callPresence"))).toEqual([]);

    remote(room, "anya");
    act(() => room.emit("reconnected"));
    await flush();
    expect(h.log.filter((line) => line.startsWith("callPresence"))).toEqual([`callPresence:${ADDR}/${GENERAL}:me,anya`]);
  });

  it("ends the call engine and the worker when LiveKit drops us", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    h.log.length = 0;

    act(() => h.state.rooms[0].emit("disconnected"));
    await flush();
    expect(h.log).toContain("callLeave");
    expect(h.log).toContain("workerTerminate");
    expect(result.current.status).toBe("idle");
    expect(result.current.security.state).toBe("off");
    expect(result.current.error).toBe("Связь с каналом потеряна");
  });

  it("ends the call engine and the worker when we leave", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    await secure();
    h.log.length = 0;
    await act(async () => {
      await result.current.leave();
    });
    await flush();
    expect(h.log).toContain("callLeave");
    expect(h.log).toContain("workerTerminate");
    expect(result.current.security.state).toBe("off");
  });

  it("uses a new room, provider and worker for every join, and leaves the old call first", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    h.log.length = 0;
    await join(result, "music");

    expect(h.state.rooms).toHaveLength(2);
    expect(h.state.workers).toHaveLength(2);
    expect(h.state.rooms[1].options.e2ee.keyProvider).not.toBe(h.state.rooms[0].options.e2ee.keyProvider);
    expect(h.log.filter((line) => line === "callLeave" || line.startsWith("callJoin"))).toEqual([
      "callLeave",
      `callJoin:${ADDR}/music`,
    ]);
    expect(h.log.filter((line) => line === "workerTerminate")).toHaveLength(1);
  });

  it("does not start the engine for a join the user left while it connected", async () => {
    let release!: () => void;
    h.state.connectGate = new Promise<void>((resolve) => (release = resolve));
    const { result } = hook();
    await flush();
    await join(result);
    await act(async () => {
      await result.current.leave();
    });
    release();
    await flush(10);
    expect(h.log).not.toContain(`callJoin:${ADDR}/${GENERAL}`);
    expect(h.log).not.toContain("openMic");
    expect(h.log).toContain("workerTerminate");
  });

  it("stops the open mic when the user leaves while it waits for the keys", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    expect(h.log).toContain("openMic");
    await act(async () => {
      await result.current.leave();
    });
    await flush(10);
    expect(h.log).toContain("micStop");
    expect(h.log).not.toContain("publishTrack");
  });

  it("fails the join when the call engine cannot be started", async () => {
    vi.mocked(callJoin).mockRejectedValueOnce("Сервер недоступен");
    const { result } = hook();
    await flush();
    await join(result);
    await flush(10);
    expect(result.current.error).toBe(`${ENCRYPTION_FAILED}: Сервер недоступен`);
    expect(result.current.status).toBe("idle");
    expect(h.log).toContain("disconnect");
    expect(h.log).toContain("callLeave");
    expect(h.log).toContain("workerTerminate");
    expect(h.log).not.toContain("openMic");
  });
});

describe("useVoice: when the keys do not come", () => {
  it("says so, stops the mic, leaves the mic button on and retries on request", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    act(() => h.state.stateHandler!(stateEvent("failed", { error: ENCRYPTION_FAILED })));
    await flush();
    expect(result.current.error).toBe(ENCRYPTION_FAILED);
    expect(result.current.security.state).toBe("failed");
    expect(h.log).toContain("micStop");
    expect(h.log).not.toContain("publishTrack");
    expect(result.current.micOn).toBe(true);

    h.log.length = 0;
    await act(async () => {
      await result.current.retryEncryption();
    });
    await flush();
    expect(h.log).toContain(`callJoin:${ADDR}/${GENERAL}`);
    expect(h.log).toContain("openMic");
    expect(result.current.security.state).toBe("pending");
    await act(async () => {
      h.state.keysHandler!(keysEvent(2, 3));
    });
    await flush(10);
    expect(h.log).toContain("publishTrack");
  });

  it("puts the mic on air when the keys come after the call had given up", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    act(() => h.state.stateHandler!(stateEvent("failed", { error: ENCRYPTION_FAILED })));
    await flush();
    expect(h.log).not.toContain("publishTrack");
    await secure(["me"], 2);
    expect(h.log).toContain("publishTrack");
  });

  it("takes the encryption error off the screen once the call is secure and the mic is on air", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    act(() => h.state.stateHandler!(stateEvent("failed", { error: ENCRYPTION_FAILED })));
    await flush();
    expect(result.current.error).toBe(ENCRYPTION_FAILED);

    await secure(["me"], 2);
    expect(h.log).toContain("publishTrack");
    expect(result.current.error).toBeNull();
  });

  it("does not take another error off the screen when the call turns secure again", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    await secure(["me"], 1);
    expect(h.log).toContain("publishTrack");

    // The mic went away: a different problem, with its own text.
    act(() => h.state.mic.on.mock.calls.find(([event]: [string]) => event === "muted")![1]());
    const micError = result.current.error;
    expect(micError).toMatch(/^Микрофон отключился/);

    act(() => h.state.stateHandler!(stateEvent("pending")));
    await secure(["me"], 2);
    expect(result.current.error).toBe(micError);
  });

  it("keeps the reason of a failed retry instead of the generic text", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    act(() => h.state.stateHandler!(stateEvent("failed", { error: ENCRYPTION_FAILED })));
    await flush();

    // The retry's mic is already waiting for the new keys when the engine turns out not to start.
    let refuse!: (reason: unknown) => void;
    vi.mocked(callJoin).mockImplementationOnce(() => new Promise<void>((_, reject) => (refuse = reject)));
    h.log.length = 0;
    let retrying!: Promise<void>;
    act(() => {
      retrying = result.current.retryEncryption();
    });
    await flush();
    expect(h.log).toContain("openMic");

    await act(async () => {
      refuse("Сервер недоступен");
      await retrying;
    });
    await flush(10);
    expect(result.current.error).toBe(`${ENCRYPTION_FAILED}: Сервер недоступен`);
    expect(result.current.security.state).toBe("failed");
  });
});

describe("useVoice: the mic and the lock", () => {
  /** Whether the published mic was last muted or unmuted. */
  const micState = () => {
    const mic = h.state.mic;
    const muted = Math.max(0, ...mic.mute.mock.invocationCallOrder);
    const unmuted = Math.max(0, ...mic.unmute.mock.invocationCallOrder);
    return muted > unmuted ? "muted" : "live";
  };

  it("the mic is muted while the call is not secure", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    await secure(["me"], 1);
    expect(h.log).toContain("publishTrack");
    expect(micState()).toBe("live");

    // The group is lost and keyed anew: until then LiveKit would encrypt our voice with the old group's key.
    act(() => h.state.stateHandler!(stateEvent("pending")));
    expect(micState()).toBe("muted");
    act(() => h.state.onLevel!(-20));
    await flush();
    expect(micState()).toBe("muted");
    expect(result.current.transmitting).toBe(false);

    // Secure again: back on air, as the user had it.
    await secure(["me"], 2);
    act(() => h.state.onLevel!(-20));
    await flush();
    expect(micState()).toBe("live");
    expect(result.current.transmitting).toBe(true);

    act(() => h.state.stateHandler!(stateEvent("failed", { error: ENCRYPTION_FAILED })));
    await flush();
    expect(micState()).toBe("muted");

    // The user's own mute stands when the call is secure again.
    act(() => result.current.toggleMic());
    await flush();
    await secure(["me"], 3);
    expect(micState()).toBe("muted");
    act(() => result.current.toggleMic());
    await flush();
    expect(micState()).toBe("live");
  });
});

describe("useVoice: the mic after a switch", () => {
  it("publishes when a moderator unmutes us after we left a call that was still waiting for keys", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    expect(h.log).toContain("openMic");

    // Out of the first channel while its mic waits for keys, into one where we are muted.
    h.state.canPublish = false;
    h.log.length = 0;
    await join(result, "music");
    expect(h.log).not.toContain("openMic");

    const room = h.state.rooms[1];
    room.localParticipant.permissions = { canPublish: true };
    act(() => room.emit("participantPermissionsChanged", {}, room.localParticipant));
    await flush();
    expect(h.log).toContain("openMic");
    await act(async () => {
      h.state.keysHandler!(keysEvent(1, 1, "music"));
    });
    await flush(10);
    expect(h.log).toContain("publishTrack");
  });
});

describe("useVoice: a mic Windows does not give", () => {
  /** What getUserMedia says when another program holds the device, or it is not released yet. */
  const busy = () => Object.assign(new Error("Could not start audio source"), { name: "NotReadableError" });

  it("keeps the mic button on and opens the mic by itself on a later try", async () => {
    vi.mocked(createLocalAudioTrack).mockRejectedValueOnce(busy());
    const { result } = hook();
    await flush();
    await join(result);
    expect(result.current.error).toBe(MIC_RETRYING);
    expect(result.current.micOn).toBe(true);

    await flush(100);
    expect(h.log.filter((entry) => entry === "openMic")).toHaveLength(1);
    await secure();
    expect(h.log).toContain("publishTrack");
    expect(result.current.error).toBeNull();
  });

  it("captures the mic again when switching to another one failed, and puts it back on air", async () => {
    const { result, rerender } = renderHook((settings: AudioSettings) => useVoice({ settings, pttOpen: false, volumes: {} }), {
      initialProps: DEFAULT_AUDIO_SETTINGS,
    });
    await flush();
    await join(result);
    await secure();
    const mic = h.state.mic;
    // As LiveKit does: the old capture is stopped first, so a failed switch leaves no sound at all.
    mic.restartTrack.mockRejectedValueOnce(busy());
    mic.unmute.mockClear();

    rerender({ ...DEFAULT_AUDIO_SETTINGS, inputDeviceId: "communications" });
    await flush();
    expect(result.current.error).toBe(MIC_RETRYING);
    expect(result.current.micOn).toBe(true);

    await flush(100);
    expect(mic.restartTrack).toHaveBeenCalledTimes(2);
    expect(mic.restartTrack.mock.calls[1][0].deviceId).toEqual({ exact: "communications" });
    expect(mic.unmute).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("does not take a sound processing that will not start for a busy mic", async () => {
    // What audioWorklet.addModule says when a module will not load (as the window's CSP did to a data: URL).
    const failure = Object.assign(new Error("Unable to load a worklet's module."), { name: "AbortError" });
    vi.mocked(createLocalAudioTrack).mockImplementationOnce(async () => {
      h.log.push("openMic");
      h.state.mic = {
        setAudioContext: vi.fn(async () => {}),
        setProcessor: vi.fn(async () => {
          throw failure;
        }),
        mute: vi.fn(async () => {}),
        unmute: vi.fn(async () => {}),
        stop: vi.fn(() => h.log.push("micStop")),
        on: vi.fn(),
        off: vi.fn(),
        restartTrack: vi.fn(async () => {}),
      };
      return h.state.mic;
    });
    const { result } = hook();
    await flush();
    await join(result);
    await flush(100);
    expect(result.current.error).toBe("Обработка звука не запустилась: Unable to load a worklet's module.");
    expect(result.current.error).not.toBe(MIC_RETRYING);
    expect(h.log.filter((entry) => entry === "openMic"), "no retries of something a retry cannot fix").toHaveLength(1);
    expect(result.current.micOn).toBe(false);
  });

  it("still turns the mic off for a mic that is not there", async () => {
    vi.mocked(createLocalAudioTrack).mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotFoundError" }));
    const { result } = hook();
    await flush();
    await join(result);
    await flush(100);
    expect(result.current.micOn).toBe(false);
    expect(result.current.error).toBe("Микрофон не найден. Подключи его и выбери в настройках");
    expect(h.log.filter((entry) => entry === "openMic")).toHaveLength(0);
  });
});

describe("useVoice: on air", () => {
  it("shows no transmission until the mic is published", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    // Voice activation hears speech, but there is no key yet: nothing is sent.
    act(() => h.state.onLevel!(-20));
    await flush();
    expect(result.current.transmitting).toBe(false);
    expect(result.current.participants.find((p) => p.isLocal)?.speaking).toBe(false);

    await secure(["me"], 1);
    expect(h.log).toContain("publishTrack");
    expect(result.current.transmitting).toBe(true);
    expect(result.current.participants.find((p) => p.isLocal)?.speaking).toBe(true);
  });

  it("shows no transmission after leaving, until the next call has the mic published", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    act(() => h.state.onLevel!(-20));
    await secure(["me"], 1);
    expect(result.current.transmitting).toBe(true);

    await act(async () => {
      await result.current.leave();
    });
    await join(result, "music");
    act(() => h.state.onLevel!(-20));
    await flush();
    expect(result.current.transmitting).toBe(false);
  });
});

describe("useVoice: who is heard", () => {
  it("never plays or keeps a track that is not marked encrypted, even a member's", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const planted = remote(room, "anya", { encrypted: false });
    act(() => room.emit("trackPublished", planted.publication, planted.participant));
    act(() => room.emit("trackSubscribed", planted.track, planted.publication, planted.participant));
    await secure(["me", "anya"]);

    expect(planted.publication.setSubscribed).toHaveBeenCalledWith(false);
    expect(planted.track.attach).not.toHaveBeenCalled();
    expect(h.state.metersAdded).not.toContain("anya");
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });

  it("drops a track whose encryption turns off", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    expect(friend.track.attach).toHaveBeenCalled();

    friend.publication.isEncrypted = false;
    act(() => room.emit("participantEncryptionStatusChanged", false, friend.participant));
    expect(friend.publication.setSubscribed).toHaveBeenCalledWith(false);
    expect(friend.track.attachedElements).toHaveLength(0);
  });

  it("plays an encrypted member only once the call is secure", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    act(() => room.emit("trackSubscribed", friend.track, friend.publication, friend.participant));
    expect(friend.track.attach).not.toHaveBeenCalled();
    expect(h.state.metersAdded).toEqual([]);

    await secure(["me", "anya"]);
    expect(friend.track.attach).toHaveBeenCalledTimes(1);
    expect(friend.track.setVolume).toHaveBeenLastCalledWith(1);
    expect(h.state.metersAdded).toEqual(["anya"]);
    expect(friend.publication.setSubscribed).not.toHaveBeenCalled();
  });

  it("does not play, or draw a speaking ring for, someone outside the group", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const ghost = remote(room, "ghost", { speaking: true });
    const friend = remote(room, "anya", { speaking: true });
    act(() => room.emit("trackSubscribed", ghost.track, ghost.publication, ghost.participant));
    await secure(["me", "anya"]);

    expect(ghost.track.attach).not.toHaveBeenCalled();
    expect(h.state.metersAdded).toEqual(["anya"]);
    const views = result.current.participants;
    expect(views.find((p) => p.identity === "ghost")).toMatchObject({ speaking: false, level: 0, encrypted: false });
    expect(views.find((p) => p.identity === friend.participant.identity)).toMatchObject({ speaking: true });
  });

  it("stops playing a member the group drops, even though they keep sending", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    expect(friend.track.attachedElements).toHaveLength(1);

    act(() => h.state.stateHandler!(stateEvent("secure", { code: "2", members: ["me"] })));
    await flush();
    expect(friend.track.detach).toHaveBeenCalled();
    expect(friend.track.attachedElements).toHaveLength(0);
    expect(h.state.metersRemoved).toContain("anya");
  });

  it("stops playing everybody while the call is not secure", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    expect(friend.track.attachedElements).toHaveLength(1);

    act(() => h.state.stateHandler!(stateEvent("pending")));
    await flush();
    expect(friend.track.attachedElements).toHaveLength(0);
  });

  it("sets the volume of each track, not of the participant", async () => {
    const { result } = hook({ anya: { volume: 0.5, muted: false } });
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    expect(friend.track.setVolume).toHaveBeenLastCalledWith(0.5);
    expect(friend.participant.setVolume).not.toHaveBeenCalled();
  });

  it("does not attach a track nobody could hear, but still shows who speaks", async () => {
    const { result } = hook({ anya: { volume: 0, muted: false } });
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    expect(friend.track.attach).not.toHaveBeenCalled();
    expect(h.state.metersAdded).toEqual(["anya"]);
  });

  it("does not give a deafened user a burst when a member's track is attached again", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    expect(friend.track.attach).toHaveBeenCalledTimes(1);

    act(() => result.current.toggleDeafen());
    await flush();
    expect(friend.track.attachedElements).toHaveLength(0);

    // The group drops the member and takes them back while the user is deafened. A new gain node
    // plays at full volume for a moment before it ramps down, so the track stays off the graph.
    act(() => h.state.stateHandler!(stateEvent("secure", { code: "2", members: ["me"] })));
    act(() => h.state.stateHandler!(stateEvent("secure", { code: "3", members: ["me", "anya"] })));
    await flush();
    expect(friend.track.attach).toHaveBeenCalledTimes(1);

    act(() => result.current.toggleDeafen());
    await flush();
    expect(friend.track.attach).toHaveBeenCalledTimes(2);
    expect(friend.track.setVolume).toHaveBeenLastCalledWith(1);
  });

  it("detaches a member dropped from the group in the same tick as the call-state event", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    expect(friend.track.attachedElements).toHaveLength(1);

    act(() => {
      h.state.stateHandler!(stateEvent("secure", { code: "2", members: ["me"] }));
      // Still inside the event: React has not rendered and no effect has run, while old keys still decrypt.
      expect(friend.track.attachedElements).toHaveLength(0);
      expect(h.state.metersRemoved).toContain("anya");
    });
  });
});

describe("useVoice: an identity that shows an unencrypted track", () => {
  it("is silenced for the rest of the call when a decoy track is published next to its real one", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    const other = remote(room, "boris");
    await secure(["me", "anya", "boris"]);
    expect(friend.track.attachedElements).toHaveLength(1);
    expect(other.track.attachedElements).toHaveLength(1);

    // The server gives anya a second publication marked NONE: LiveKit stops decrypting all her frames.
    const decoy = addPublication(friend, "decoy", { encrypted: false });
    act(() => room.emit("trackPublished", decoy.publication, friend.participant));
    expect(decoy.publication.setSubscribed).toHaveBeenCalledWith(false);
    expect(friend.track.attachedElements).toHaveLength(0);
    expect(decoy.track.attach).not.toHaveBeenCalled();
    expect(result.current.participants.find((p) => p.identity === "anya")?.encrypted).toBe(false);

    // Taking the decoy away does not switch decryption back on, nor does a new group.
    decoy.remove();
    act(() => room.emit("trackUnpublished", decoy.publication, friend.participant));
    act(() => h.state.stateHandler!(stateEvent("secure", { code: "2", members: ["me", "anya", "boris"] })));
    act(() => room.emit("trackSubscribed", friend.track, friend.publication, friend.participant));
    await flush();
    expect(friend.track.attach).toHaveBeenCalledTimes(1);
    expect(friend.track.attachedElements).toHaveLength(0);
    expect(result.current.participants.find((p) => p.identity === "anya")?.encrypted).toBe(false);

    // Somebody else is not affected.
    expect(other.track.attachedElements).toHaveLength(1);
    expect(result.current.participants.find((p) => p.identity === "boris")?.encrypted).toBe(true);
  });

  it("is silenced when the decoy was there before we looked", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    addPublication(friend, "decoy", { encrypted: false });
    await secure(["me", "anya"]);
    expect(friend.track.attach).not.toHaveBeenCalled();
    expect(result.current.participants.find((p) => p.identity === "anya")?.encrypted).toBe(false);
  });

  it("is silenced when its encryption status changes to off, for the rest of the call", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    expect(friend.track.attachedElements).toHaveLength(1);

    // The worker says decryption for anya is off, whatever her publications look like.
    act(() => room.emit("participantEncryptionStatusChanged", false, friend.participant));
    expect(friend.track.attachedElements).toHaveLength(0);
    expect(result.current.participants.find((p) => p.identity === "anya")?.encrypted).toBe(false);

    act(() => room.emit("participantEncryptionStatusChanged", true, friend.participant));
    act(() => h.state.stateHandler!(stateEvent("secure", { code: "2", members: ["me", "anya"] })));
    await flush();
    expect(friend.track.attachedElements).toHaveLength(0);
  });

  it("is not mixed up with our own encryption status", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    await secure(["me", "anya"]);
    act(() => room.emit("participantEncryptionStatusChanged", false, room.localParticipant));
    await flush();
    expect(friend.track.attachedElements).toHaveLength(1);
  });

  it("passes sealed remote-control input on to Rust, and sends ours to one person only", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const { invoke } = await import("@tauri-apps/api/core");
    room.emit("dataReceived", new Uint8Array([1, 2, 255]), { identity: "anna", isLocal: false }, 0, "hv-rc");
    room.emit("dataReceived", new Uint8Array([9]), { identity: "anna", isLocal: false }, 0, "other");
    expect(invoke).toHaveBeenCalledWith("remote_input", { from: "anna", packet: "AQL_" });
    expect(invoke).not.toHaveBeenCalledWith("remote_input", expect.objectContaining({ packet: "CQ" }));
    room.localParticipant.publishData = vi.fn(async () => {});
    await act(() => result.current.sendRemote(new Uint8Array([7]), "anna", false));
    expect(room.localParticipant.publishData).toHaveBeenCalledWith(new Uint8Array([7]), { reliable: false, destinationIdentities: ["anna"], topic: "hv-rc" });
  });

  it("starts the next call clean", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const first = h.state.rooms[0];
    const decoy = remote(first, "anya", { encrypted: false });
    act(() => first.emit("trackPublished", decoy.publication, decoy.participant));
    await secure(["me", "anya"]);
    expect(result.current.participants.find((p) => p.identity === "anya")?.encrypted).toBe(false);

    await join(result, "music");
    const second = h.state.rooms[1];
    const again = remote(second, "anya");
    await secure(["me", "anya"], 1, "music");
    expect(again.track.attachedElements).toHaveLength(1);
    expect(result.current.participants.find((p) => p.identity === "anya")?.encrypted).toBe(true);
  });
});

describe("useVoice: cameras", () => {
  /** A camera publication of `person`, with its picture. */
  function cameraOf(person: ReturnType<typeof remote>, { encrypted = true }: { encrypted?: boolean } = {}) {
    const videoTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
    const publication: any = {
      kind: "video",
      source: "camera",
      isEncrypted: encrypted,
      isMuted: false,
      isDesired: true,
      track: videoTrack,
      videoTrack,
      setSubscribed: vi.fn((on: boolean) => {
        publication.isDesired = on;
      }),
      setVideoQuality: vi.fn(),
    };
    person.participant.trackPublications.set(`${person.participant.identity}-camera`, publication);
    return { publication, videoTrack };
  }
  const cameraIn = (result: Voice, identity: string) => result.current.participants.find((p) => p.identity === identity)?.camera ?? null;

  it("shows a friend's camera only once the call is secure, and only of someone inside its encryption", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    const camera = cameraOf(friend);
    cameraOf(remote(room, "ghost"));
    act(() => room.emit("trackSubscribed", camera.videoTrack, camera.publication, friend.participant));
    expect(cameraIn(result, "anya"), "not before the call is secure").toBeNull();
    await secure(["me", "anya"]);
    expect(cameraIn(result, "anya")).toBe(camera.videoTrack);
    expect(cameraIn(result, "ghost"), "outside the group").toBeNull();
    expect(camera.publication.setVideoQuality, "a friend's camera in full while few are on").toHaveBeenCalledWith(2);
  });

  it("never shows a camera that is not encrypted, and drops it", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    const friend = remote(room, "anya");
    const planted = cameraOf(friend, { encrypted: false });
    act(() => room.emit("trackPublished", planted.publication, friend.participant));
    await secure(["me", "anya"]);
    expect(cameraIn(result, "anya")).toBeNull();
    expect(planted.publication.setSubscribed).toHaveBeenCalledWith(false);
  });

  it("our camera waits for the keys, then goes out in VP8 at the chosen size", async () => {
    const { result } = hook();
    await flush();
    await join(result);
    const room = h.state.rooms[0];
    room.state = "connected";
    const local = room.localParticipant;
    local.setCameraEnabled = vi.fn(async (on: boolean) => {
      local.isCameraEnabled = on;
    });
    let problem: string | null = null;
    await act(async () => {
      problem = await result.current.startCamera({ deviceId: "default", quality: "720", mirror: true, facing: "user" });
    });
    expect(problem).toMatch(/ключи шифрования/);
    expect(local.setCameraEnabled).not.toHaveBeenCalled();
    await secure(["me"]);
    await act(async () => {
      problem = await result.current.startCamera({ deviceId: "cam-2", quality: "1080", mirror: true, facing: "user" });
    });
    expect(problem).toBeNull();
    expect(result.current.cameraOn).toBe(true);
    expect(local.setCameraEnabled).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ deviceId: { exact: "cam-2" }, resolution: { width: 1920, height: 1080, frameRate: 30 } }),
      expect.objectContaining({ videoCodec: "vp8", simulcast: true }),
    );
  });
});
