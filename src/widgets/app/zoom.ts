export interface View {
  k: number;
  x: number;
  y: number;
}

export const IDENTITY: View = { k: 1, x: 0, y: 0 };

// The page image is 8192 px wide and the panel about 700 CSS px, so the image stays sharp to
// roughly 6x at DPR 2; past that the geometry still draws crisply over a soft image.
export const MAX_ZOOM = 8;

/** Keep the zoomed plan covering the box: never smaller than 1x, never panned past an edge. */
export function clampView(view: View, width: number, height: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(1, view.k));
  const x = Math.min(0, Math.max(width - width * k, view.x));
  const y = Math.min(0, Math.max(height - height * k, view.y));
  return { k, x, y };
}

/** Zoom by `factor` keeping the plan point under (px, py) where it is. */
export function zoomAt(view: View, factor: number, px: number, py: number, width: number, height: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(1, view.k * factor));
  const ratio = k / view.k;
  return clampView({ k, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio }, width, height);
}

export function panBy(view: View, dx: number, dy: number, width: number, height: number): View {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, width, height);
}

/** Box point (CSS px from the canvas's top-left) to plan grid units. */
export function toGrid(view: View, px: number, py: number, gridScale: number): { x: number; y: number } {
  return { x: (px - view.x) / (gridScale * view.k), y: (py - view.y) / (gridScale * view.k) };
}

export type Turn = 0 | 90 | 180 | 270;

/** A sheet's display rotation; anything but a quarter turn draws the sheet as stored. */
export function quarterTurn(value: unknown): Turn {
  return value === 90 || value === 180 || value === 270 ? value : 0;
}

export const sideways = (turn: Turn) => turn === 90 || turn === 270;

/** The canvas transform that draws the page as stored turned clockwise into a box of this size. */
export function turnMatrix(turn: Turn, width: number, height: number): [number, number, number, number, number, number] {
  if (turn === 90) return [0, 1, -1, 0, width, 0];
  if (turn === 180) return [-1, 0, 0, -1, width, height];
  if (turn === 270) return [0, -1, 1, 0, 0, height];
  return [1, 0, 0, 1, 0, 0];
}

/** Box point (zoom undone) back to the page as stored: the inverse of turnMatrix. */
export function unturn(turn: Turn, x: number, y: number, width: number, height: number): { x: number; y: number } {
  if (turn === 90) return { x: y, y: width - x };
  if (turn === 180) return { x: width - x, y: height - y };
  if (turn === 270) return { x: height - y, y: x };
  return { x, y };
}
