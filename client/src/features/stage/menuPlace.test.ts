import { describe, expect, it } from "vitest";
import { MENU_EDGE, MENU_GAP, MENU_MAX_HEIGHT, placeActMenu, placeNear } from "./menuPlace";

const view = { width: 1100, height: 720 };
const size = { width: 340, height: 300 };

describe("placeActMenu", () => {
  it("opens under the click when it fits there", () => {
    const at = { x: 500, y: 200 };
    expect(placeActMenu(at, size, view)).toEqual({ left: 500 - 170, top: 200 + MENU_GAP, maxHeight: MENU_MAX_HEIGHT });
  });

  it("opens over the click when below there is no room", () => {
    const at = { x: 500, y: 600 };
    expect(placeActMenu(at, size, view).top).toBe(600 - MENU_GAP - 300);
  });

  it("keeps a long list small by the click, to scroll inside, not the whole window", () => {
    const place = placeActMenu({ x: 500, y: 200 }, { width: 340, height: 1000 }, view);
    expect(place.maxHeight).toBe(MENU_MAX_HEIGHT);
    expect(place.top, "under the click").toBe(200 + MENU_GAP);
    const low = placeActMenu({ x: 500, y: 650 }, { width: 340, height: 1000 }, view);
    expect(low.top, "over the click").toBe(650 - MENU_GAP - MENU_MAX_HEIGHT);
  });

  it("moves up to stay whole when neither side has room", () => {
    const place = placeActMenu({ x: 500, y: 360 }, { width: 340, height: 400 }, view);
    expect(place.top).toBe(720 - MENU_EDGE - 400);
  });

  it("never crosses the window's sides", () => {
    expect(placeActMenu({ x: 5, y: 200 }, size, view).left).toBe(MENU_EDGE);
    expect(placeActMenu({ x: 1095, y: 200 }, size, view).left).toBe(1100 - MENU_EDGE - 340);
  });

  it("keeps the menu inside the window wherever it is clicked", () => {
    for (const height of [120, 300, 450, 700, 1000]) {
      for (let y = 0; y <= view.height; y += 37) {
        for (let x = 0; x <= view.width; x += 91) {
          const place = placeActMenu({ x, y }, { width: 340, height }, view);
          const shown = Math.min(height, place.maxHeight);
          expect(place.top).toBeGreaterThanOrEqual(MENU_EDGE);
          expect(place.top + shown).toBeLessThanOrEqual(view.height - MENU_EDGE);
          expect(place.left).toBeGreaterThanOrEqual(MENU_EDGE);
          expect(place.left + 340).toBeLessThanOrEqual(view.width - MENU_EDGE);
        }
      }
    }
  });

  it("fits a phone held upright", () => {
    const phone = { width: 375, height: 740 };
    const place = placeActMenu({ x: 300, y: 500 }, { width: 340, height: 1000 }, phone);
    expect(place).toEqual({ left: 375 - MENU_EDGE - 340, top: 500 - MENU_GAP - MENU_MAX_HEIGHT, maxHeight: MENU_MAX_HEIGHT });
  });
});

describe("placeNear", () => {
  const view = { width: 1440, height: 900 };
  const size = { width: 260, height: 200 };

  it("puts a friend's menu under their tile when it fits", () => {
    const tile = { left: 100, top: 100, right: 300, bottom: 160 };
    expect(placeNear(tile, size, view)).toEqual({ left: 100, top: 160 + 6, maxHeight: view.height - 2 * MENU_EDGE });
  });

  it("over a tile at the bottom of the window (as in a call watching something), never under the window's edge", () => {
    const tile = { left: 130, top: 750, right: 280, bottom: 790 };
    expect(placeNear(tile, size, view)).toEqual({ left: 130, top: 750 - 6 - 200, maxHeight: view.height - 2 * MENU_EDGE });
  });

  it("within the window's sides, and scrolling when taller than the window", () => {
    const tile = { left: 1400, top: 400, right: 1440, bottom: 440 };
    const place = placeNear(tile, { width: 260, height: 2000 }, view);
    expect(place.left).toBe(1440 - MENU_EDGE - 260);
    expect(place.top).toBe(MENU_EDGE);
    expect(place.maxHeight).toBe(900 - 2 * MENU_EDGE);
  });
});
