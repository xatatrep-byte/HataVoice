// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import agent from "../../src-tauri/src/watch_agent.js?raw";
import { page } from "./agentPage";

type Group = { items: string[]; active: number };
type Choices = Partial<Record<"players" | "season" | "episode" | "dub", Group>>;
type Agent = { command: (c: unknown) => void; scan: () => Choices };

function load(): Agent {
  delete (window as { __hvWatch?: unknown }).__hvWatch;
  new Function(agent)();
  return (window as unknown as { __hvWatch: Agent }).__hvWatch;
}

beforeEach(page);
afterEach(() => {
  document.documentElement.removeAttribute("data-hv-theater-on");
});

describe("the watch window's script finds the choices of a page", () => {
  it("the site's players, the player's seasons, episodes and dubs, each with the one chosen now", () => {
    const choices = load().scan();
    expect(choices.players).toEqual({ items: ["Плеер 1", "Плеер 2", "Плеер 3"], active: 0 });
    expect(choices.season).toEqual({ items: ["1 сезон", "2 сезон", "3 сезон", "4 сезон"], active: 0 });
    expect(choices.episode).toEqual({ items: ["1 серия", "2 серия", "3 серия", "4 серия"], active: 0 });
    expect(choices.dub).toEqual({ items: ["BTi Studios", "Eng.Original"], active: 0 });
  });

  it("leaves the site's menu and the picture's quality alone: those are no dubs", () => {
    const choices = load().scan();
    expect(JSON.stringify(choices)).not.toContain("Главная");
    expect(JSON.stringify(choices)).not.toContain("720p");
  });

  it("chooses by the label: a season or an episode by its number, a dub by its name, a player by its button", () => {
    const watch = load();
    watch.command({ op: "choose", kind: "episode", label: "Серия 3" });
    watch.command({ op: "choose", kind: "season", label: "2 сезон" });
    watch.command({ op: "choose", kind: "dub", label: "eng.original" });
    watch.command({ op: "choose", kind: "players", label: "Плеер 2" });
    const choices = watch.scan();
    expect(choices.episode?.active).toBe(2);
    expect(choices.season?.active).toBe(1);
    expect(choices.dub?.active).toBe(1);
    expect(choices.players?.active).toBe(1);
  });

  it("takes the player's speeds for no dub, and keeps its real dubs", () => {
    const speeds = ["0.5", "1", "1.25", "1.5", "2"].map((s, i) => `<div class="item_2mH${i === 1 ? " active_1Rh" : ""}">${s}</div>`).join("");
    document.querySelector(".list_5Wf")!.insertAdjacentHTML("beforeend", `<div class="settings_9Qx"><div class="menu_2sa">${speeds}</div></div>`);
    expect(load().scan().dub).toEqual({ items: ["BTi Studios", "Eng.Original"], active: 0 });
  });

  it("chooses in a list a player draws as a select", () => {
    document.querySelector(".list_5Wf")!.innerHTML = `<select name="translation"><option>Дубляж</option><option>LostFilm</option></select>`;
    let changed = "";
    document.querySelector("select[name=translation]")!.addEventListener("change", (e) => (changed = (e.target as HTMLSelectElement).value));
    const watch = load();
    expect(watch.scan().dub).toEqual({ items: ["Дубляж", "LostFilm"], active: 0 });
    watch.command({ op: "choose", kind: "dub", label: "LostFilm" });
    expect(changed).toBe("LostFilm");
    expect(watch.scan().dub?.active).toBe(1);
  });

  it("in the call shows the player alone, over the whole page, and gives the page back when told", () => {
    const watch = load();
    watch.command({ op: "theater", on: true });
    const shown = document.querySelector("[data-hv-theater]");
    expect(shown?.contains(document.querySelector("video"))).toBe(true);
    expect(shown?.contains(document.querySelector("nav"))).toBe(false);
    expect(document.documentElement.hasAttribute("data-hv-theater-on")).toBe(true);
    watch.command({ op: "theater", on: false });
    expect(document.querySelector("[data-hv-theater]")).toBeNull();
    expect(document.documentElement.hasAttribute("data-hv-theater-on")).toBe(false);
  });
});
