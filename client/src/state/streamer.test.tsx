// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StreamerSection } from "../features/settings/StreamerSection";
import { Secret } from "../ui/Secret";
import { usePrefs } from "./prefs";
import { streamerActive, useStreaming } from "./streamer";

afterEach(() => {
  cleanup();
  act(() => {
    usePrefs.getState().setStreamer("auto");
    useStreaming.getState().setObs(false);
  });
});

describe("streamer mode", () => {
  it("is on by hand, or by itself only while OBS runs", () => {
    expect(streamerActive("on", false)).toBe(true);
    expect(streamerActive("auto", true)).toBe(true);
    expect(streamerActive("auto", false)).toBe(false);
    expect(streamerActive("off", true)).toBe(false);
  });

  it("hides an address while it is on, by itself when OBS starts", () => {
    render(<Secret>192.168.0.132:7350</Secret>);
    expect(screen.getByText("192.168.0.132:7350")).toBeTruthy();
    act(() => useStreaming.getState().setObs(true));
    expect(screen.queryByText("192.168.0.132:7350")).toBeNull();
    expect(screen.getByText("скрыто · режим стримера")).toBeTruthy();
    act(() => usePrefs.getState().setStreamer("off"));
    expect(screen.getByText("192.168.0.132:7350"), "off means off, OBS or not").toBeTruthy();
  });

  it("the settings pick the mode and say whether OBS is seen", () => {
    render(<StreamerSection />);
    expect(screen.getByText(/Сейчас выключен/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Включён" }));
    expect(usePrefs.getState().streamer).toBe("on");
    expect(screen.getByText(/Сейчас включён/)).toBeTruthy();
  });
});
