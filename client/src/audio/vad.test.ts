import { describe, expect, it, vi } from "vitest";
import { createVoiceGate } from "./vad";

const gate = () => {
  const onChange = vi.fn();
  return { onChange, g: createVoiceGate({ thresholdDb: -50, holdMs: 300, onChange }) };
};

describe("createVoiceGate", () => {
  it("opens immediately when the level reaches the threshold", () => {
    const { g, onChange } = gate();
    g.feed(-60, 0);
    expect(onChange).not.toHaveBeenCalled();
    g.feed(-50, 10);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("closes only after 300 ms below the threshold", () => {
    const { g, onChange } = gate();
    g.feed(-40, 0);
    g.feed(-70, 100);
    g.feed(-70, 350);
    expect(onChange.mock.calls).toEqual([[true]]);
    g.feed(-70, 401);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("speech during the hold cancels the pending close", () => {
    const { g, onChange } = gate();
    g.feed(-40, 0);
    g.feed(-70, 100);
    g.feed(-40, 300);
    g.feed(-70, 350);
    g.feed(-70, 600);
    expect(onChange.mock.calls).toEqual([[true]]);
    g.feed(-70, 651);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("reports each state change once", () => {
    const { g, onChange } = gate();
    g.feed(-40, 0);
    g.feed(-35, 20);
    g.feed(-30, 40);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a higher threshold stops quieter speech from opening", () => {
    const { g, onChange } = gate();
    g.setThreshold(-30);
    g.feed(-40, 0);
    expect(onChange).not.toHaveBeenCalled();
    g.feed(-25, 10);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
