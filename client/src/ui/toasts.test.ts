// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useErrorToast, useToasts } from "./toasts";

const shown = () => useToasts.getState().toasts.map((t) => t.text);

beforeEach(() => useToasts.setState({ toasts: [] }));

describe("useErrorToast", () => {
  it("shows the current problem, and takes it away once it is over", () => {
    const { rerender } = renderHook(({ text }: { text: string | null }) => useErrorToast(text), {
      initialProps: { text: "Микрофон не открылся" as string | null },
    });
    expect(shown()).toEqual(["Микрофон не открылся"]);

    rerender({ text: "Связь с каналом потеряна" });
    expect(shown()).toEqual(["Связь с каналом потеряна"]);

    rerender({ text: null });
    expect(shown()).toEqual([]);
  });

  it("leaves the other notifications alone", () => {
    useToasts.getState().push({ kind: "error", text: "Комната удалена" });
    const { rerender } = renderHook(({ text }: { text: string | null }) => useErrorToast(text), {
      initialProps: { text: "Микрофон не открылся" as string | null },
    });
    rerender({ text: null });
    expect(shown()).toEqual(["Комната удалена"]);
  });
});
