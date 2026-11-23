// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installContextMenuGuard, keepsBrowserMenu } from "./contextMenu";

describe("the right-click menu", () => {
  it("is kept in text fields and over selected text, and nowhere else", () => {
    document.body.innerHTML = `
      <input id="name" type="text"><input id="box" type="checkbox"><textarea id="note"></textarea>
      <div id="edit" contenteditable="true"><span id="inside">x</span></div><button id="btn">Кнопка</button>`;
    const el = (id: string) => document.getElementById(id);
    expect(keepsBrowserMenu(el("name"), "")).toBe(true);
    expect(keepsBrowserMenu(el("note"), "")).toBe(true);
    expect(keepsBrowserMenu(el("inside"), "")).toBe(true);
    expect(keepsBrowserMenu(el("box"), "")).toBe(false);
    expect(keepsBrowserMenu(el("btn"), "")).toBe(false);
    expect(keepsBrowserMenu(el("btn"), "выделенный текст")).toBe(true);
  });

  it("is stopped by the guard on the page, and the guard can be taken off", () => {
    document.body.innerHTML = `<div id="stage"></div>`;
    const remove = installContextMenuGuard();
    const first = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.getElementById("stage")!.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    remove();
    const second = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.getElementById("stage")!.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });
});
