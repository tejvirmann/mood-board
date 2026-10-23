export type ThemeName = "light" | "dark";

/** Colours the WebGL scene needs, read from the same CSS variables the UI uses. */
export interface Palette {
  name: ThemeName;
  bg: number;
  dot: number;
  text: number;
  note: number;
  accent: number;
  handle: number;
  placeholder: number;
  placeholderLine: number;
}

/** `#rgb` or `#rrggbb` (minifiers shorten `#ffffff` to `#fff`). */
const hex = (s: string) => {
  let h = s.trim().replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return parseInt(h, 16);
};

export function readPalette(name: ThemeName): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string) => hex(cs.getPropertyValue(k));
  return {
    name,
    bg: v("--canvas"),
    dot: v("--dot"),
    text: v("--text"),
    note: v("--note"),
    accent: v("--accent"),
    handle: v("--handle"),
    placeholder: v("--placeholder"),
    placeholderLine: v("--placeholder-line"),
  };
}
