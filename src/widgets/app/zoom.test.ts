import { describe, expect, it } from "vitest";

import { IDENTITY, MAX_ZOOM, clampView, panBy, quarterTurn, toGrid, turnMatrix, unturn, zoomAt, type Turn } from "./zoom";

describe("plan zoom", () => {
  it("keeps the plan point under the pointer fixed", () => {
    const zoomed = zoomAt(IDENTITY, 2, 300, 200, 700, 460);
    expect(toGrid(zoomed, 300, 200, 1)).toEqual(toGrid(IDENTITY, 300, 200, 1));
  });

  it("never zooms below 1x or above the cap", () => {
    expect(zoomAt(IDENTITY, 0.5, 10, 10, 700, 460).k).toBe(1);
    expect(zoomAt({ k: 7, x: 0, y: 0 }, 4, 0, 0, 700, 460).k).toBe(MAX_ZOOM);
  });

  it("never pans past an edge", () => {
    expect(panBy(IDENTITY, 50, 50, 700, 460)).toEqual(IDENTITY);
    const zoomed = { k: 2, x: -100, y: -100 };
    expect(panBy(zoomed, 10_000, 10_000, 700, 460)).toEqual({ k: 2, x: 0, y: 0 });
    expect(panBy(zoomed, -10_000, -10_000, 700, 460)).toEqual({ k: 2, x: -700, y: -460 });
  });

  it("maps a box point to grid units through the zoom", () => {
    const view = clampView({ k: 4, x: -400, y: -200 }, 700, 460);
    expect(toGrid(view, 0, 0, 0.35)).toEqual({ x: 400 / 1.4, y: 200 / 1.4 });
  });
});

describe("plan rotation", () => {
  // A page as stored, 400 wide and 300 high; turned a quarter it fills a 300 x 400 box.
  const apply = (m: number[], x: number, y: number) => ({ x: m[0]! * x + m[2]! * y + m[4]!, y: m[1]! * x + m[3]! * y + m[5]! });
  const box = (turn: Turn) => (turn === 90 || turn === 270 ? { w: 300, h: 400 } : { w: 400, h: 300 });

  it("turns the page clockwise into the box", () => {
    expect(apply(turnMatrix(90, 300, 400), 0, 0)).toEqual({ x: 300, y: 0 });
    expect(apply(turnMatrix(90, 300, 400), 400, 0)).toEqual({ x: 300, y: 400 });
    expect(apply(turnMatrix(180, 400, 300), 0, 0)).toEqual({ x: 400, y: 300 });
    expect(apply(turnMatrix(270, 300, 400), 0, 0)).toEqual({ x: 0, y: 400 });
    expect(apply(turnMatrix(0, 400, 300), 10, 20)).toEqual({ x: 10, y: 20 });
  });

  it("maps a box point back to the page point drawn there, for every turn", () => {
    for (const turn of [0, 90, 180, 270] as const) {
      const { w, h } = box(turn);
      for (const [x, y] of [[0, 0], [400, 300], [123, 45], [399, 1]] as const) {
        const drawn = apply(turnMatrix(turn, w, h), x, y);
        expect(drawn.x, `${turn}`).toBeGreaterThanOrEqual(0);
        expect(drawn.x, `${turn}`).toBeLessThanOrEqual(w);
        expect(drawn.y, `${turn}`).toBeLessThanOrEqual(h);
        expect(unturn(turn, drawn.x, drawn.y, w, h), `${turn} ${x},${y}`).toEqual({ x, y });
      }
    }
  });

  it("hit-tests through zoom and turn together", () => {
    const view = clampView({ k: 2, x: -100, y: -150 }, 300, 400);
    const page = { x: 250, y: 60 };
    const drawn = apply(turnMatrix(90, 300, 400), page.x, page.y);
    const screen = { x: drawn.x * view.k + view.x, y: drawn.y * view.k + view.y };
    const back = toGrid(view, screen.x, screen.y, 1);
    expect(unturn(90, back.x, back.y, 300, 400)).toEqual(page);
  });

  it("draws anything but a quarter turn as stored", () => {
    for (const value of [undefined, null, 45, 360, -90, "90"]) expect(quarterTurn(value), String(value)).toBe(0);
    expect(quarterTurn(270)).toBe(270);
  });
});
