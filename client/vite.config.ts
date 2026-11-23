/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { inlineAsset } from "./src/build/inline";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  // Worklets and workers stay files of their own: the window's CSP refuses scripts from data: URLs.
  build: { assetsInlineLimit: inlineAsset },
  // Tests: a stylesheet read as text (`?raw`, styles.test.ts) must come with its text. Vitest leaves every CSS file empty
  // by default, and the check that no two sheets style the same class saw nothing and always passed.
  test: { css: { include: [/\.css\?raw$/] } },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Bind IPv4 explicitly: on Windows "localhost" may resolve to ::1 only.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
