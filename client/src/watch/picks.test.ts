import { describe, expect, it } from "vitest";
import { nextChoice, picked, picksOf, readChoices, readPicks, sameChoice, viewerPicks, type Choices } from "./picks";

const page: Choices = {
  players: { items: ["Плеер 1", "Плеер 2", "Плеер 3"], active: 0 },
  season: { items: ["1 сезон", "2 сезон"], active: 0 },
  episode: { items: ["1 серия", "2 серия", "3 серия"], active: 0 },
  dub: { items: ["BTi Studios", "Eng.Original"], active: 0 },
};
const at = (choices: Choices, kind: keyof Choices, active: number): Choices => ({ ...choices, [kind]: { ...choices[kind]!, active } });

describe("the same choice in two players' words", () => {
  it("a season, an episode or a player by its number; a dub by its letters", () => {
    expect(sameChoice("season", "1 сезон", "Сезон 1")).toBe(true);
    expect(sameChoice("episode", "Серия 10", "1 серия")).toBe(false);
    expect(sameChoice("players", "Плеер 2", "плеер №2")).toBe(true);
    expect(sameChoice("dub", "BTi Studios", "bti studios")).toBe(true);
    expect(sameChoice("dub", "LostFilm", "Lost Film")).toBe(true);
    expect(sameChoice("dub", "LostFilm", "Кубик в Кубе")).toBe(false);
  });
});

describe("following everyone's choice", () => {
  it("chooses one thing at a time: the player, then the season, the episode, the dub", () => {
    const picks = { players: "Плеер 2", season: "2 сезон", episode: "3 серия", dub: "Eng.Original" };
    expect(nextChoice(picks, page)).toEqual({ kind: "players", label: "Плеер 2" });
    expect(nextChoice(picks, at(page, "players", 1))).toEqual({ kind: "season", label: "2 сезон" });
    expect(nextChoice(picks, at(at(at(page, "players", 1), "season", 1), "episode", 2))).toEqual({ kind: "dub", label: "Eng.Original" });
    expect(nextChoice(picks, at(at(at(at(page, "players", 1), "season", 1), "episode", 2), "dub", 1)), "all as everyone has it").toBeNull();
  });

  it("leaves what this page cannot show: a list it has not, or not that item in it", () => {
    expect(nextChoice({ season: "5 сезон", dub: "Eng.Original" }, page)).toEqual({ kind: "dub", label: "Eng.Original" });
    expect(nextChoice({ players: "Плеер 2" }, { season: page.season })).toBeNull();
    expect(nextChoice({}, page)).toBeNull();
  });
});

describe("what a viewer chose in the site's own player", () => {
  it("is everyone's choice from then on; a new episode starts from its beginning, a new dub keeps the time", () => {
    const picks = picksOf(page);
    expect(viewerPicks(page, at(page, "episode", 2), picks)).toEqual({ picks: { ...picks, episode: "3 серия" }, restart: true });
    expect(viewerPicks(page, at(page, "dub", 1), picks)).toEqual({ picks: { ...picks, dub: "Eng.Original" }, restart: false });
  });

  it("is nothing while the page loads other lists: another player or season has its own defaults", () => {
    const other: Choices = { ...page, episode: { items: ["1 серия", "2 серия"], active: 0 } };
    expect(viewerPicks(at(page, "episode", 2), other, { ...picksOf(page), episode: "3 серия" })).toBeNull();
    expect(viewerPicks({ season: page.season }, page, {}), "a list that was not there before").toBeNull();
  });

  it("is nothing when nothing changed, or when the page only came to what everyone has", () => {
    expect(viewerPicks(page, page, picksOf(page))).toBeNull();
    expect(viewerPicks(null, page, {})).toBeNull();
    expect(viewerPicks(page, at(page, "episode", 2), { ...picksOf(page), episode: "Серия 3" }), "our own doing").toBeNull();
  });
});

describe("a choice made in the call", () => {
  it("a new season drops the episode and starts from the beginning; a dub keeps both", () => {
    const picks = { season: "1 сезон", episode: "3 серия", dub: "BTi Studios" };
    expect(picked(picks, "season", "2 сезон")).toEqual({ picks: { season: "2 сезон", dub: "BTi Studios" }, restart: true });
    expect(picked(picks, "episode", "2 серия")).toEqual({ picks: { ...picks, episode: "2 серия" }, restart: true });
    expect(picked(picks, "dub", "Eng.Original")).toEqual({ picks: { ...picks, dub: "Eng.Original" }, restart: false });
  });
});

describe("choices as a site's page tells them", () => {
  it("are trimmed to sane sizes and kinds, as the page writes them", () => {
    const raw = {
      players: { items: ["Плеер 1", 7, "x".repeat(200)], active: 9 },
      season: { items: "nope", active: 0 },
      hack: { items: ["a", "b"], active: 0 },
      dub: { items: Array.from({ length: 500 }, (_, i) => `Озвучка ${i}`), active: 1 },
    };
    const choices = readChoices(raw);
    expect(Object.keys(choices).sort()).toEqual(["dub", "players"]);
    expect(choices.players).toEqual({ items: ["Плеер 1", "7", "x".repeat(60)], active: 2 });
    expect(choices.dub!.items.length).toBe(60);
    expect(readChoices("x")).toEqual({});
  });

  it("everyone's picks: four kinds, short words", () => {
    expect(readPicks({ season: "2 сезон", dub: "x".repeat(99), hack: "y", episode: 3 })).toEqual({ season: "2 сезон", dub: "x".repeat(60) });
    expect(readPicks(null)).toEqual({});
  });
});
