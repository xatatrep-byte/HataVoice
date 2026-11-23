import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { parsePrefs, usePrefs } from "./prefs";

describe("parsePrefs", () => {
  it("gives defaults for missing data", () => {
    expect(parsePrefs(null)).toEqual({
      nickname: "",
      color: "blue",
      frame: null,
      character: null,
      stage3d: true,
      stageLook: "studio",
      overlay: false,
      overlaySpots: {},
      overlaySize: 0.26,
      musicMini: true,
      musicDuck: true,
      musicVolume: 1,
      musicSend: 1,
      musicMuted: false,
      clipboardInvites: true,
      autoJoin: false,
      lastChannels: {},
      appearance: DEFAULT_APPEARANCE,
      onboarded: false,
      showGame: true,
      customGames: [],
      notifyMode: "mentions",
      notifyText: true,
      screen: { resolution: "1080", fps: "60", codec: "auto", audio: true },
      codecPicked: false,
      remoteBanner: true,
      camera: { deviceId: "default", quality: "720", mirror: true, facing: "user" },
      streamer: "auto",
      drawerPinned: false,
      seenHints: [],
      phonePip: true,
      phoneRoute: "auto",
      phonePttKey: null,
      phoneScreenSet: false,
      phoneOnline: false,
    });
    expect(parsePrefs({ streamer: "loud" }).streamer).toBe("auto");
    // The panel's pin and the hints seen: only what they can be.
    expect(parsePrefs({ drawerPinned: "yes", seenHints: ["more", 3, null] })).toMatchObject({ drawerPinned: false, seenHints: ["more"] });
    expect(parsePrefs({ drawerPinned: true }).drawerPinned).toBe(true);
    // A phone's own: the small window, where the call is heard, the push-to-talk key as Android names it.
    expect(parsePrefs({ phonePip: false, phoneRoute: "speaker", phonePttKey: "KEYCODE_VOLUME_DOWN" })).toMatchObject({ phonePip: false, phoneRoute: "speaker", phonePttKey: "KEYCODE_VOLUME_DOWN" });
    expect(parsePrefs({ phoneRoute: "loud", phonePttKey: "rm -rf" })).toMatchObject({ phoneRoute: "auto", phonePttKey: null });
    expect(parsePrefs({ camera: { facing: "environment" } }).camera.facing).toBe("environment");
    expect(parsePrefs({ camera: { facing: "sideways" } }).camera.facing).toBe("user");
    expect(parsePrefs({ character: "c1.tall.f6d1b1.ff8a4c.bun.3b2a20.cat.happy", stage3d: false })).toMatchObject({
      character: "c1.tall.f6d1b1.ff8a4c.bun.3b2a20.cat.happy",
      stage3d: false,
    });
    expect(parsePrefs({ character: "c1.dragon" }).character).toBeNull();
    // Where the characters stand: one of the looks, the studio otherwise.
    expect(parsePrefs({ stageLook: "sunset" }).stageLook).toBe("sunset");
    expect(parsePrefs({ stageLook: "moon" }).stageLook).toBe("studio");
    // Each person's place on the desktop: two parts of the screen; anything else is dropped. The size stays in bounds.
    expect(parsePrefs({ overlay: true, overlaySpots: { anna: [0.2, 0.9], bob: [2, 0.5], eve: "here" }, overlaySize: 5 })).toMatchObject({
      overlay: true,
      overlaySpots: { anna: [0.2, 0.9] },
      overlaySize: 0.6,
    });
    expect(parsePrefs({ streamer: "on" }).streamer).toBe("on");
    expect(parsePrefs({ screen: { resolution: "4320", fps: "240", codec: "h264", audio: false } }).screen).toEqual({ resolution: "1080", fps: "60", codec: "h264", audio: false });
    // The presets of before 0.12 become a size and a rate.
    expect(parsePrefs({ screen: { preset: "text", codec: "auto", audio: true } }).screen).toMatchObject({ resolution: "1440", fps: "30" });
    expect(parsePrefs({ screen: { preset: "max" } }).screen).toMatchObject({ resolution: "2160", fps: "60" });
    // AV1 goes encrypted in an envelope now (av1Envelope.ts): a choice of it is kept.
    expect(parsePrefs({ screen: { codec: "av1" } }).screen.codec).toBe("av1");
    // The old default, «Авто (VP9)», is the new «Авто»; VP9 itself is chosen as vp9svc.
    expect(parsePrefs({ screen: { codec: "vp9" } }).screen.codec).toBe("auto");
    expect(parsePrefs({ screen: { codec: "vp9svc" } }).screen.codec).toBe("vp9svc");
    // The camera: any device name, one of the sizes, the mirror on unless turned off.
    expect(parsePrefs({ camera: { deviceId: "cam-2", quality: "1080", mirror: false } }).camera).toEqual({ deviceId: "cam-2", quality: "1080", mirror: false, facing: "user" });
    expect(parsePrefs({ camera: { deviceId: 7, quality: "4k", mirror: "no" } }).camera).toEqual({ deviceId: "default", quality: "720", mirror: true, facing: "user" });
    expect(parsePrefs({ notifyMode: "loud", notifyText: false })).toMatchObject({ notifyMode: "mentions", notifyText: false });
    expect(parsePrefs("garbage")).toEqual(parsePrefs(null));
  });

  it("keeps valid fields, replaces unknown accents and clamps the scale", () => {
    const prefs = parsePrefs({
      nickname: "Петя",
      color: "pink",
      appearance: { theme: "light", accent: "lime", scale: 300 },
      onboarded: true,
    });
    expect(prefs.nickname).toBe("Петя");
    expect(prefs.color).toBe("pink");
    expect(prefs.onboarded).toBe(true);
    expect(prefs.appearance).toEqual({ ...DEFAULT_APPEARANCE, theme: "light", accent: null, scale: 125 });
  });

  it("remembers whether to show the game you play", () => {
    expect(parsePrefs({ showGame: false }).showGame).toBe(false);
    expect(parsePrefs({ showGame: "no" }).showGame).toBe(true);
  });

  it("keeps the games you added yourself, dropping broken ones", () => {
    const games = parsePrefs({ customGames: [{ exe: "mygame.exe", title: "Моя игра" }, { exe: 5 }, "x", { exe: "a.exe", title: "" }] }).customGames;
    expect(games).toEqual([{ exe: "mygame.exe", title: "Моя игра" }]);
  });

  it("chooses the codec by the video card only until the person chooses one", () => {
    usePrefs.setState({ codecPicked: false, screen: { resolution: "1080", fps: "60", codec: "auto", audio: true } });
    usePrefs.getState().tuneCodec("h264");
    expect(usePrefs.getState().screen.codec).toBe("h264");
    expect(usePrefs.getState().codecPicked).toBe(false);
    // Size or sound changed: still not a choice of codec.
    usePrefs.getState().setScreen({ fps: "30" });
    expect(usePrefs.getState().codecPicked).toBe(false);
    usePrefs.getState().setScreen({ codec: "av1" });
    expect(usePrefs.getState().codecPicked).toBe(true);
    usePrefs.getState().tuneCodec("h264");
    expect(usePrefs.getState().screen.codec).toBe("av1");
    expect(parsePrefs({ codecPicked: true }).codecPicked).toBe(true);
    expect(parsePrefs({ codecPicked: "yes" }).codecPicked).toBe(false);
  });

  it("cuts overlong nicknames and rejects unknown colors", () => {
    expect(parsePrefs({ nickname: "x".repeat(40) }).nickname).toHaveLength(32);
    expect(parsePrefs({ color: "black" }).color).toBe("blue");
    expect(parsePrefs({ appearance: { scale: 10 } }).appearance.scale).toBe(90);
  });
});
