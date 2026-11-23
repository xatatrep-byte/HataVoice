import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { installContextMenuGuard } from "./app/contextMenu";
import { OVERLAY_LABEL } from "./characters/overlay";
import { OverlayApp } from "./characters/OverlayApp";
import { BannerApp } from "./features/remote/BannerApp";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./theme/tokens.css";
import "./ui/ui.css";
import "./theme/parts.css";
import "./theme/frames.css";
import "./theme/compact.css";
import "./theme/phone.css";

// Linux: this web view is hidden and only carries calls for the window in a browser.
const relay = (window as { __HV_RELAY__?: { port: number; secret: string } }).__HV_RELAY__;
const label = isTauri() ? getCurrentWindow().label : "main";
// No «Назад / Обновить / Печать» on right click, in any of our windows.
installContextMenuGuard();

if (relay) void import("./platform/relay").then(({ runRelay }) => runRelay(relay));
else ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* The windows over other apps draw the call's characters, or the remote-control banner, and nothing else. */}
    {label === OVERLAY_LABEL ? <OverlayApp /> : label === "remote-banner" ? <BannerApp /> : <App />}
  </React.StrictMode>,
);
