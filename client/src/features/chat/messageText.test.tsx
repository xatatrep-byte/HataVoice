// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async (url: string) => void opened.push(url)) }));

import { MessageText } from "./MessageText";

afterEach(() => {
  cleanup();
  opened.length = 0;
});

describe("MessageText", () => {
  it("marks bold, italic and code", () => {
    const { container } = render(<MessageText text={"это **важно**, это *тихо*, а это `код`"} />);
    expect(container.querySelector("strong")!.textContent).toBe("важно");
    expect(container.querySelector("em")!.textContent).toBe("тихо");
    expect(container.querySelector("code")!.textContent).toBe("код");
    expect(container.textContent).toBe("это важно, это тихо, а это код");
  });

  it("keeps a code block as it is, marks and all", () => {
    const { container } = render(<MessageText text={"смотри:\n```\nfn main() { **нет** }\n```\nвот"} />);
    const block = container.querySelector("pre code")!;
    expect(block.textContent).toBe("fn main() { **нет** }\n");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("opens http(s) links in the browser, without the dot after them", () => {
    render(<MessageText text="глянь https://example.com/a?b=1. и http://site.ru" />);
    const link = screen.getByRole("link", { name: "https://example.com/a?b=1" });
    fireEvent.click(link);
    expect(opened).toEqual(["https://example.com/a?b=1"]);
    expect(screen.getByRole("link", { name: "http://site.ru" })).toBeTruthy();
  });

  it("links nothing but http(s)", () => {
    render(<MessageText text="javascript:alert(1) file:///C:/x ftp://a.b" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("never runs HTML: a tag is shown as the text it is", () => {
    const { container } = render(<MessageText text={'<img src=x onerror="alert(1)"><b>жирно</b>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror="alert(1)"><b>жирно</b>');
  });
});
