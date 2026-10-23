import type { Item, StrokeItem } from "../types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const itemRect = (i: Item): Rect => ({ x: i.x, y: i.y, w: i.width, h: i.height });

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const unionRect = (items: Item[]) => unionRects(items.map(itemRect));

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** True when world point (wx, wy) is within `tol` of the stroke's centre line. */
export function strokeHit(s: StrokeItem, wx: number, wy: number, tol: number): boolean {
  const sx = s.width / s.bw;
  const sy = s.height / s.bh;
  const r = tol + s.size / 2;
  const p = s.points;
  const px = wx - s.x;
  const py = wy - s.y;
  if (p.length < 4) return Math.hypot(px - p[0] * sx, py - p[1] * sy) <= r;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (distToSegment(px, py, p[i] * sx, p[i + 1] * sy, p[i + 2] * sx, p[i + 3] * sy) <= r) return true;
  }
  return false;
}

/** Topmost item under a world point. Strokes hit on their line, everything else on its box. */
export function hitItem(items: Item[], wx: number, wy: number, tol: number): Item | null {
  let best: Item | null = null;
  for (const i of items) {
    if (best && i.zIndex < best.zIndex) continue;
    const inBox = wx >= i.x && wx <= i.x + i.width && wy >= i.y && wy <= i.y + i.height;
    if (i.type === "stroke" ? strokeHit(i, wx, wy, tol) : inBox) best = i;
  }
  return best;
}

/** Ramer–Douglas–Peucker on a flat point list. */
export function simplify(pts: number[], eps: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let max = eps;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[2 * i], pts[2 * i + 1], pts[2 * a], pts[2 * a + 1], pts[2 * b], pts[2 * b + 1]);
      if (d > max) {
        max = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

export const newId = () => crypto.randomUUID();
export const topZ = (items: Item[]) => items.reduce((z, i) => Math.max(z, i.zIndex), 0) + 1;
export const bottomZ = (items: Item[]) => items.reduce((z, i) => Math.min(z, i.zIndex), 0) - 1;
export const round1 = (n: number) => Math.round(n * 10) / 10;
