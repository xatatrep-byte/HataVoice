// @vitest-environment jsdom
import { expect, it } from "vitest";
import agent from "../../src-tauri/src/watch_agent.js?raw";
import { page } from "./agentPage";

const MARK = "⁣HV⁣";

// A file of its own: one script per page, as in the watch window (scripts of other checks would answer too).
it("tells the program the choices with the video, in the page's title, the site's own title kept", () => {
  page();
  new Function(agent)();
  expect(document.title.startsWith(MARK)).toBe(true);
  const word = JSON.parse(document.title.slice(MARK.length)) as { t: string; c: { players?: { items: string[] } }; v: unknown };
  expect(word.t).toBe("Половое воспитание 1 сезон 1 серия");
  expect(word.c.players?.items).toEqual(["Плеер 1", "Плеер 2", "Плеер 3"]);
});
