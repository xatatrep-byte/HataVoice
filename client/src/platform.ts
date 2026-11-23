import { android, IS_ANDROID } from "./platform/android";

export { IS_ANDROID };

const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
const touches = typeof navigator === "undefined" ? 0 : (navigator.maxTouchPoints ?? 0);

/** An iPhone or an iPad (an iPad's web view says «Macintosh», but a Mac has no touch screen). */
export const IS_IOS = /iphone|ipad|ipod/i.test(agent) || (/macintosh/i.test(agent) && touches > 1);

/**
 * A phone or a tablet: the layout is for fingers, there are no windows over other apps and no control of this device by
 * a friend. What a platform merely lacks is asked of the platform instead (see `canShareScreen`, `CAN_HOST`).
 */
export const IS_MOBILE = IS_ANDROID || IS_IOS;

/** This device as words in a sentence: «на этом ПК» or «на этом телефоне». */
export const THIS_DEVICE = IS_MOBILE ? "этом телефоне" : "этом ПК";

/** A Mac: the window's buttons are the system's own on the left, and shortcuts go with ⌘. */
export const IS_MAC = /macintosh|mac os x/i.test(agent) && !IS_IOS;

/**
 * A server of one's own can run here: a PC, or an Android phone (the server and LiveKit start from the app's libraries).
 * iOS lets an app start no programs.
 */
export const CAN_HOST = !IS_IOS;

/**
 * The studio composes its frame with MediaStreamTrackProcessor and WebCodecs: a PC's WebView2 and Android's WebView have
 * both; WebKit (a Mac's and an iPhone's web view) has no MediaStreamTrackProcessor outside workers yet: there it is
 * offered once the engine has what it takes.
 */
export const HAS_STUDIO = (!IS_MOBILE && !IS_MAC) || (!IS_IOS && "MediaStreamTrackProcessor" in globalThis && "VideoEncoder" in globalThis);

/** A shortcut as this system writes it: «⌘K» on Apple's, «Ctrl+K» elsewhere. */
export function shortcut(key: string, apple = IS_MAC || IS_IOS): string {
  return apple ? `⌘${key}` : `Ctrl+${key}`;
}

/** A webcam (or a phone's camera) can be asked for here. */
export function canUseCamera(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/** The screen can be shown: the web view's own capture, or Android's (MediaProjection) in the phone app. */
export function canShareScreen(): boolean {
  if (typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function") return true;
  return IS_ANDROID && android() !== null;
}
