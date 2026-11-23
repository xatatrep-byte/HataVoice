/**
 * Whether the build may put an asset inside the code as a `data:` URL (Vite's `build.assetsInlineLimit`). Never a
 * script: audio worklets and workers are loaded by URL, and the window's CSP (`script-src 'self'`) takes only the
 * app's own files, so an inlined one fails to load (`addModule` says AbortError) — the voice changer did, and with it
 * the whole mic. Anything else: Vite's own size rule (`undefined`).
 */
export function inlineAsset(file: string): false | undefined {
  return /\.m?js(\?|$)/.test(file) ? false : undefined;
}
