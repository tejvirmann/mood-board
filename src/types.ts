export type MediaKind = "image" | "video";

interface ItemBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
}

export interface MediaItem extends ItemBase {
  type: "media";
  /** Relative to the board's asset root, `/`-separated. */
  path: string;
}

export interface TextItem extends ItemBase {
  type: "text";
  text: string;
  fontSize: number;
}

/** Freehand stroke. `points` are flat [x0,y0,x1,y1,…] relative to the item's origin, in a `bw`×`bh` box. */
export interface StrokeItem extends ItemBase {
  type: "stroke";
  points: number[];
  bw: number;
  bh: number;
  /** `#rrggbb`, or `ink` which follows the theme's text colour. */
  color: string;
  /** Line width in world units. */
  size: number;
}

export type Item = MediaItem | TextItem | StrokeItem;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Unknown fields from newer versions are preserved on save by spreading the loaded object. */
export interface Board {
  schemaVersion: number;
  id: string;
  name: string;
  /** Relative to the board file (`./assets`, `../shared`) or absolute. */
  assetRoot: string;
  viewport: Viewport;
  items: Item[];
  [extra: string]: unknown;
}

export interface Entry {
  path: string;
  kind: MediaKind;
  size: number;
}

export interface Doc {
  path: string;
  board: Board;
  /** Absolute, resolved asset root. */
  rootAbs: string;
}

export type Tool = "select" | "pen" | "eraser";
export interface Pen {
  color: string;
  /** Screen pixels at draw time (converted to world units when the stroke is created). */
  size: number;
}
