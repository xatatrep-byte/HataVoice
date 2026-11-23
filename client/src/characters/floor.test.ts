import { describe, expect, it } from "vitest";
import { visibleFloor } from "./scene";

const deg = (d: number) => (d * Math.PI) / 180;

describe("the floor one may walk on", () => {
  it("is the whole stage in a wide picture", () => {
    // A PC's call: 16:9, the camera 6 m away.
    const horizontal = Math.atan(Math.tan(deg(15)) * (16 / 9));
    expect(visibleFloor(16, horizontal).x).toBe(4.6);
  });

  it("is only what a phone held upright sees, so nobody walks out of the picture", () => {
    const horizontal = Math.atan(Math.tan(deg(15)) * 0.5);
    const floor = visibleFloor(7.9, horizontal);
    expect(floor.x).toBeLessThan(1);
    expect(floor.x).toBeGreaterThanOrEqual(0.6);
    expect(floor.back).toBe(-1.5);
    expect(floor.front).toBe(1.45);
  });
});
