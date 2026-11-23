/**
 * Android's side of the app (`packaging/android/overlay/.../Native.kt`), reached as `HataNative`: an object WebView puts
 * only into the program's own page, never into a site in a player frame. The page sends small JSON words (`op`);
 * Android answers with words (`ev`) and, for a shared screen, with raw bytes (pictures and sound).
 */

type NativeObject = {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

/** What this phone's Android can do, told once the page says hello. */
export type AndroidFeatures = { screen: boolean; screenAudio: boolean; pip: boolean; binary: boolean; control?: boolean };

export type AndroidWord = { ev: string } & Record<string, unknown>;

const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
export const IS_ANDROID = /android/i.test(agent);

/** Bytes that came as base64 text (an older WebView passes only text). */
export function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class AndroidBridge {
  private readonly words = new Set<(word: AndroidWord) => void>();
  private readonly bytes = new Set<(buffer: ArrayBuffer) => void>();
  features: AndroidFeatures | null = null;

  constructor(private readonly native: NativeObject) {
    native.addEventListener("message", this.onMessage);
    this.send({ op: "hello" });
  }

  private readonly onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data instanceof ArrayBuffer) {
      for (const handler of this.bytes) handler(data);
      return;
    }
    if (typeof data !== "string") return;
    let word: AndroidWord;
    try {
      word = JSON.parse(data) as AndroidWord;
    } catch {
      return;
    }
    if (!word || typeof word.ev !== "string") return;
    if (word.ev === "bin") {
      if (typeof word.b64 !== "string") return;
      const buffer = fromBase64(word.b64);
      for (const handler of this.bytes) handler(buffer);
      return;
    }
    if (word.ev === "hello" && typeof word.features === "object" && word.features) this.features = word.features as AndroidFeatures;
    for (const handler of this.words) handler(word);
  };

  send(word: { op: string } & Record<string, unknown>) {
    this.native.postMessage(JSON.stringify(word));
  }

  /** Every word from Android until the returned function is called. */
  on(handler: (word: AndroidWord) => void): () => void {
    this.words.add(handler);
    return () => this.words.delete(handler);
  }

  onBytes(handler: (buffer: ArrayBuffer) => void): () => void {
    this.bytes.add(handler);
    return () => this.bytes.delete(handler);
  }

  /** The first word for which `wanted` holds, or null after `ms`. */
  next(wanted: (word: AndroidWord) => boolean, ms: number): Promise<AndroidWord | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, ms);
      const off = this.on((word) => {
        if (!wanted(word)) return;
        clearTimeout(timer);
        off();
        resolve(word);
      });
    });
  }
}

let bridge: AndroidBridge | null | undefined;

/** Android's side, in the Android app; null anywhere else. */
export function android(): AndroidBridge | null {
  if (bridge === undefined) {
    const native = (globalThis as { HataNative?: NativeObject }).HataNative;
    bridge = native && typeof native.postMessage === "function" ? new AndroidBridge(native) : null;
  }
  return bridge;
}
