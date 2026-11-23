import { describe, expect, it } from "vitest";
import tauriConf from "../../src-tauri/tauri.conf.json";
import { inlineAsset } from "./inline";

describe("what the build may put inside the code as a data: URL", () => {
  it("never a script: worklets and workers load by URL, and the window's CSP takes only its own files", () => {
    const scriptSrc = tauriConf.app.security.csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "))!;
    expect(scriptSrc).not.toContain("data:");
    expect(scriptSrc).not.toContain("blob:");
    for (const file of ["C:/Voices/client/src/audio/voiceFxWorklet.js", "/x/src/studio/meterWorklet.js", "/x/worker.mjs", "/x/node_modules/a/rnnoiseWorklet.js?url"]) {
      expect(inlineAsset(file), file).toBe(false);
    }
  });

  it("leaves the rest to Vite's own rule", () => {
    expect(inlineAsset("/x/src/assets/icon.png")).toBeUndefined();
    expect(inlineAsset("/x/rnnoise.wasm")).toBeUndefined();
  });
});
