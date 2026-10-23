import { Application, CanvasTextMetrics, Container, Graphics, Rectangle, Sprite, Text, TextStyle, Texture, TilingSprite } from "pixi.js";
import { basename, kindOf } from "../api";
import type { Item, MediaItem, StrokeItem, TextItem, Viewport } from "../types";
import type { Palette } from "./theme";
import { ORIGINAL, TIERS, TextureCache, gifMaker, gifMeta, imageMaker, keyOf, posterMaker } from "./textures";
import { sourceMax } from "./thumbs";

export const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
export const NOTE_PAD = 8;
export const LINE_HEIGHT = 1.35;

/** Set by the self-test to see which step of a slow frame was responsible. */
export const perf = { log: (_msg: string) => {} };

const CULL_MARGIN = 256; // CSS px beyond the viewport that stay loaded
const UPLOAD_BUDGET = 5 * 1024 * 1024; // bytes of new texture per frame
const MAX_ANIMATED_GIFS = 12;
const MAX_GIF_BYTES = 12 * 1024 * 1024;

const textStyle = (fontSize: number, width: number, fill: number) =>
  new TextStyle({ fontFamily: FONT, fontSize, fill, wordWrap: true, wordWrapWidth: Math.max(1, width - NOTE_PAD * 2), lineHeight: fontSize * LINE_HEIGHT, breakWords: true });

/** Height a note needs for its text at the given width. */
export function textHeight(text: string, fontSize: number, width: number): number {
  const m = CanvasTextMetrics.measureText(text || " ", textStyle(fontSize, width, 0), undefined, true);
  return Math.ceil(m.height + NOTE_PAD * 2);
}

const colorOf = (c: string, p: Palette) => (c === "ink" ? p.text : parseInt(c.replace("#", ""), 16));
const isGif = (path: string) => path.toLowerCase().endsWith(".gif");
const normPath = (p: string) => p.normalize("NFC");

interface View {
  id: string;
  root: Container;
  item: Item;
  update(item: Item): void;
  /** Called once per frame-with-view-changes for views inside (or near) the viewport. */
  sync(visible: boolean, px: number): void;
  restyle(): void;
  destroy(): void;
}

export class BoardRenderer {
  readonly app = new Application();
  readonly textures = new TextureCache();
  readonly world = new Container();
  /** Screen-space overlay (selection, marquee), redrawn by the controller. */
  readonly overlay = new Graphics();
  /** World-space layer above all items for live pen strokes. */
  readonly live = new Graphics();
  readonly pendingAssign: { view: MediaView; key: string; tex: Texture }[] = [];

  vp: Viewport = { x: 0, y: 0, zoom: 1 };
  palette!: Palette;
  rootAbs = "";
  sizes = new Map<string, number>();
  missing = new Set<string>();
  width = 1;
  height = 1;
  gifSlots = 0;
  textRes = 1;

  private views = new Map<string, View>();
  private grid!: TilingSprite;
  private gridTex: Texture | null = null;
  private dirtyView = true;
  private raf = 0;
  private lastT = 0;
  private alive = true;
  frame = { count: 0, cpuMs: 0, maxMs: 0 };

  async init(host: HTMLElement, palette: Palette) {
    this.palette = palette;
    await this.app.init({
      background: palette.bg,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      autoStart: false,
      powerPreference: "high-performance",
      preference: "webgl",
      width: host.clientWidth || 800,
      height: host.clientHeight || 600,
    });
    if (!this.alive) return this.destroy();
    this.app.ticker.stop();
    this.app.stage.eventMode = "none";
    this.world.sortableChildren = true;
    this.live.zIndex = 1e9;
    this.world.addChild(this.live);
    this.buildGrid();
    this.app.stage.addChild(this.grid, this.world, this.overlay);
    host.prepend(this.app.canvas);
    this.app.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    this.resize(host.clientWidth, host.clientHeight);
    this.applyViewport();
  }

  // ---- scene --------------------------------------------------------------------------------
  private buildGrid() {
    const T = 48; // 24 world units drawn at 2x
    const c = document.createElement("canvas");
    c.width = c.height = T;
    const g = c.getContext("2d")!;
    g.fillStyle = "#" + this.palette.dot.toString(16).padStart(6, "0");
    g.beginPath();
    g.arc(T / 2, T / 2, 1.6, 0, Math.PI * 2);
    g.fill();
    const tex = Texture.from(c);
    tex.source.style.addressMode = "repeat";
    if (this.grid) {
      this.grid.texture = tex;
    } else {
      this.grid = new TilingSprite({ texture: tex, width: this.width, height: this.height });
    }
    this.gridTex?.destroy(true);
    this.gridTex = tex;
  }

  setPalette(p: Palette) {
    this.palette = p;
    this.app.renderer.background.color = p.bg;
    this.buildGrid();
    this.views.forEach((v) => v.restyle());
    this.requestRender();
  }

  setScene(rootAbs: string, sizes: Map<string, number>, missing: Set<string>) {
    const changed = rootAbs !== this.rootAbs || missing !== this.missing;
    this.rootAbs = rootAbs;
    this.sizes = sizes;
    this.missing = missing;
    if (changed) {
      this.views.forEach((v) => v instanceof MediaView && v.invalidate());
      this.dirtyView = true;
      this.requestRender();
    }
  }

  setItems(items: Item[]) {
    const seen = new Set<string>();
    for (const it of items) {
      seen.add(it.id);
      let v = this.views.get(it.id);
      if (v && v.item.type !== it.type) {
        v.destroy();
        this.views.delete(it.id);
        v = undefined;
      }
      if (!v) {
        v = it.type === "media" ? new MediaView(it, this) : it.type === "text" ? new TextView(it, this) : new StrokeView(it, this);
        this.views.set(it.id, v);
        this.world.addChild(v.root);
        v.update(it);
      } else if (v.item !== it) {
        v.update(it);
      }
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        v.destroy();
        this.views.delete(id);
      }
    }
    this.dirtyView = true;
    this.requestRender();
  }

  view(id: string) {
    return this.views.get(id);
  }

  /** Re-render one note (editing hides its rasterised text so the DOM editor can take over). */
  setEditing(id: string | null) {
    this.views.forEach((v) => v instanceof TextView && v.setHidden(v.id === id));
    this.requestRender();
  }

  // ---- viewport -----------------------------------------------------------------------------
  resize(w: number, h: number) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.app.renderer.resize(this.width, this.height);
    this.grid.width = this.width;
    this.grid.height = this.height;
    this.dirtyView = true;
    this.requestRender();
  }

  setViewport(vp: Viewport) {
    this.vp = vp;
    this.applyViewport();
    this.dirtyView = true;
    this.requestRender();
  }

  private applyViewport() {
    const { x, y, zoom } = this.vp;
    this.world.position.set(x, y);
    this.world.scale.set(zoom);
    this.grid.tilePosition.set(x, y);
    this.grid.tileScale.set(zoom / 2);
    this.grid.visible = zoom * 24 >= 8;
  }

  // ---- frame loop ---------------------------------------------------------------------------
  requestRender() {
    if (!this.raf && this.alive) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(t: number) {
    this.raf = 0;
    if (!this.alive) return;
    const dt = this.lastT ? Math.min(100, t - this.lastT) : 16;
    this.lastT = t;
    const start = performance.now();

    if (this.dirtyView) {
      this.dirtyView = false;
      this.updateViews();
    }
    const t1 = performance.now();
    // Textures upload to the GPU on first draw; cap the bytes per frame so a burst of loads can't stall one.
    for (let budget = UPLOAD_BUDGET; budget > 0 && this.pendingAssign.length; ) {
      const a = this.pendingAssign.shift()!;
      budget -= a.tex.source.pixelWidth * a.tex.source.pixelHeight * 4;
      a.view.apply(a.key, a.tex);
    }
    let animating = false;
    for (const v of this.views.values()) {
      if (v instanceof MediaView && v.tickGif(dt)) animating = true;
    }
    const t2 = performance.now();
    this.app.render();

    const ms = performance.now() - start;
    if (ms > 12) perf.log(`slow tick ${ms.toFixed(1)}ms: views=${(t1 - start).toFixed(1)} assign+gif=${(t2 - t1).toFixed(1)} render=${(performance.now() - t2).toFixed(1)}`);
    this.frame.count++;
    this.frame.cpuMs += ms;
    this.frame.maxMs = Math.max(this.frame.maxMs, ms);
    if (animating || this.pendingAssign.length) this.requestRender();
    else this.lastT = 0;
  }

  private updateViews() {
    const { x, y, zoom } = this.vp;
    const m = CULL_MARGIN;
    const dpr = this.app.renderer.resolution;
    for (const v of this.views.values()) {
      const i = v.item;
      const sx = i.x * zoom + x;
      const sy = i.y * zoom + y;
      const sw = i.width * zoom;
      const sh = i.height * zoom;
      const vis = sx < this.width + m && sx + sw > -m && sy < this.height + m && sy + sh > -m;
      v.sync(vis, Math.max(sw, sh) * dpr);
    }
  }

  /** Force a view-state recompute (used by the controller after programmatic changes). */
  invalidate() {
    this.dirtyView = true;
    this.requestRender();
  }

  get viewCount() {
    return this.views.size;
  }

  get busy() {
    return this.textures.stats.pending > 0 || this.pendingAssign.length > 0;
  }

  resetFrameStats() {
    this.frame = { count: 0, cpuMs: 0, maxMs: 0 };
  }

  destroy() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.views.forEach((v) => v.destroy());
    this.views.clear();
    this.textures.clear();
    this.gridTex?.destroy(true);
    try {
      this.app.destroy(true, { children: true });
    } catch {
      /* init may not have completed */
    }
  }
}

// ---- views --------------------------------------------------------------------------------------

function place(root: Container, i: Item) {
  root.position.set(i.x, i.y);
  root.scale.set(1);
  root.zIndex = i.zIndex;
}

interface GifPlayer {
  sprite: Sprite;
  frames: Texture[];
  starts: number[];
  total: number;
  t: number;
  idx: number;
  key: string;
}

class MediaView implements View {
  readonly id: string;
  readonly root = new Container();
  item: MediaItem;
  private sprite = new Sprite(Texture.EMPTY);
  private ph = new Graphics();
  private label: Text | null = null;
  private badge: Graphics | null = null;
  private player: GifPlayer | null = null;
  private gifLoading = false;
  private gifFailed = false;
  private shownKey: string | null = null;
  private shownTier = -1;
  private wantKey: string | null = null;
  private broken = false;
  private visible = false;
  private alive = true;
  private lastPx = 0;
  private isVideo: boolean;

  constructor(item: MediaItem, private r: BoardRenderer) {
    this.id = item.id;
    this.item = item;
    this.isVideo = kindOf(item.path) === "video";
    this.root.addChild(this.ph, this.sprite);
    this.ph.visible = false;
    this.sprite.visible = false;
  }

  private get path() {
    return normPath(this.item.path);
  }
  private get isMissing() {
    return this.r.missing.has(this.item.id);
  }

  update(item: MediaItem) {
    const pathChanged = item.path !== this.item.path;
    this.item = item;
    place(this.root, item);
    if (pathChanged) {
      this.isVideo = kindOf(item.path) === "video";
      this.invalidate();
    }
    this.layout();
  }

  /** Drop everything loaded for this view (file changed, folder changed, or went missing). */
  invalidate() {
    this.dropGif();
    this.dropTexture();
    this.broken = false;
    this.gifFailed = false;
    this.lastPx = 0;
  }

  restyle() {
    this.layout();
  }

  private layout() {
    const { width: w, height: h } = this.item;
    this.sprite.setSize(w, h);
    this.player?.sprite.setSize(w, h);
    const missing = this.isMissing || this.broken;
    const showPh = missing || !this.shownKey;
    this.ph.visible = showPh && this.visible;
    if (this.ph.visible) {
      const p = this.r.palette;
      this.ph.clear();
      this.ph.rect(0, 0, w, h).fill({ color: missing ? p.placeholder : p.note });
      if (missing) this.ph.rect(0, 0, w, h).stroke({ width: 1.5, color: p.placeholderLine, alpha: 0.8 });
    }
    if (missing && this.visible) {
      if (!this.label) {
        this.label = new Text({ text: "", style: textStyle(13, 200, 0) });
        this.root.addChild(this.label);
      }
      const p = this.r.palette;
      this.label.style = textStyle(Math.max(12, Math.min(18, w / 14)), w, p.text);
      this.label.text = `Missing file\n${basename(this.item.path)}`;
      this.label.alpha = 0.7;
      this.label.position.set(NOTE_PAD, NOTE_PAD);
      this.label.visible = true;
    } else if (this.label) {
      this.label.visible = false;
    }
    this.sprite.visible = !missing && !!this.shownKey && !this.player;
    this.drawBadge();
  }

  private drawBadge() {
    const show = this.isVideo && !!this.shownKey && !this.isMissing;
    if (!show) {
      if (this.badge) this.badge.visible = false;
      return;
    }
    if (!this.badge) {
      this.badge = new Graphics();
      this.root.addChild(this.badge);
    }
    const { width: w, height: h } = this.item;
    const r = Math.max(10, Math.min(40, Math.min(w, h) * 0.12));
    const g = this.badge;
    g.visible = true;
    g.clear();
    g.circle(w / 2, h / 2, r).fill({ color: 0x000000, alpha: 0.55 });
    g.poly([w / 2 - r * 0.3, h / 2 - r * 0.45, w / 2 - r * 0.3, h / 2 + r * 0.45, w / 2 + r * 0.5, h / 2]).fill({ color: 0xffffff, alpha: 0.95 });
  }

  sync(vis: boolean, px: number) {
    const was = this.visible;
    this.visible = vis;
    this.root.visible = vis;
    this.lastPx = px;
    if (!vis) {
      if (was) {
        this.dropGif();
        this.dropTexture();
      }
      return;
    }
    if (this.isMissing || this.broken) {
      this.dropTexture();
      this.layout();
      return;
    }
    if (this.isVideo) {
      this.want(keyOf(this.r.rootAbs, this.path, -1), -1);
    } else {
      const max = sourceMax.get(`${this.r.rootAbs}/${this.path}`);
      let want = 0;
      if (max !== undefined) {
        want = ORIGINAL;
        for (let i = 0; i < TIERS.length; i++) {
          if (px <= TIERS[i] * 1.15) {
            want = i;
            break;
          }
        }
        // never ask for more resolution than the file has
        let cover = ORIGINAL;
        for (let i = 0; i < TIERS.length; i++) {
          if (max <= TIERS[i]) {
            cover = i;
            break;
          }
        }
        want = Math.min(want, cover);
        // keep a higher tier until it is clearly oversized, to avoid thrashing at tier edges
        if (this.shownTier > want && want >= 0 && this.shownTier - 1 >= 0 && px > TIERS[this.shownTier - 1] * 0.55 && this.shownTier <= ORIGINAL) want = this.shownTier;
      }
      this.want(keyOf(this.r.rootAbs, this.path, want), want);
    }
    this.maybeAnimate();
    this.layout();
  }

  private want(key: string, tier: number) {
    if (this.wantKey === key) return;
    this.wantKey = key;
    const hit = this.r.textures.take(key);
    if (hit) return this.apply(key, hit, tier);
    const maker = tier < 0 ? posterMaker(this.r.rootAbs, this.path) : imageMaker(this.r.rootAbs, this.path, tier);
    void this.r.textures
      .acquire(key, maker, () => !this.alive || this.wantKey !== key || !this.visible)
      .then((tex) => {
        if (!tex) {
          if (this.wantKey === key && this.alive) {
            this.wantKey = null;
            if (tier !== ORIGINAL && tier >= 0 && !this.shownKey) this.broken = true;
            this.layout();
            this.r.requestRender();
          }
          return;
        }
        if (!this.alive || this.wantKey !== key) return this.r.textures.release(key);
        this.r.pendingAssign.push({ view: this, key, tex });
        this.r.requestRender();
      });
  }

  /** Swap in a loaded texture and release the previous one. */
  apply(key: string, tex: Texture, tier?: number) {
    if (!this.alive || this.wantKey !== key) return this.r.textures.release(key);
    const old = this.shownKey;
    this.sprite.texture = tex;
    this.shownKey = key;
    this.shownTier = tier ?? Number(key.slice(key.lastIndexOf("@") + 1));
    if (old && old !== key) this.r.textures.release(old);
    this.layout();
    this.maybeAnimate();
    this.r.requestRender();
  }

  private dropTexture() {
    if (this.shownKey) this.r.textures.release(this.shownKey);
    this.shownKey = null;
    this.wantKey = null;
    this.shownTier = -1;
    this.sprite.texture = Texture.EMPTY;
    this.sprite.visible = false;
  }

  // ---- animated GIFs: decoded to a sprite sheet in Rust, played back by swapping sub-rectangles ----
  private canAnimate() {
    const bytes = this.r.sizes.get(this.path) ?? Infinity;
    return isGif(this.item.path) && !this.gifFailed && this.visible && !!this.shownKey && !this.isMissing && bytes <= MAX_GIF_BYTES && this.lastPx >= 48 && this.r.vp.zoom >= 0.08;
  }

  private maybeAnimate() {
    if (this.player) {
      if (!this.canAnimate()) this.dropGif();
      return;
    }
    if (this.gifLoading || !this.canAnimate() || this.r.gifSlots >= MAX_ANIMATED_GIFS) return;
    this.gifLoading = true;
    this.r.gifSlots++;
    const key = `${this.r.rootAbs}/${this.path}@gif`;
    void this.r.textures.acquire(key, gifMaker(this.r.rootAbs, this.path, key), () => !this.alive || !this.canAnimate()).then((tex) => {
      this.gifLoading = false;
      const meta = gifMeta.get(key);
      if (!tex || !meta) {
        this.r.gifSlots--;
        this.gifFailed = true;
        return;
      }
      if (!this.alive || !this.canAnimate() || this.player) {
        this.r.gifSlots--;
        return this.r.textures.release(key);
      }
      const frames = meta.delays.map((_, i) => new Texture({ source: tex.source, frame: new Rectangle((i % meta.cols) * meta.frameW, Math.floor(i / meta.cols) * meta.frameH, meta.frameW, meta.frameH) }));
      const starts: number[] = [];
      let total = 0;
      for (const d of meta.delays) {
        starts.push(total);
        total += d;
      }
      const sprite = new Sprite(frames[0]);
      sprite.setSize(this.item.width, this.item.height);
      this.root.addChildAt(sprite, 1);
      this.player = { sprite, frames, starts, total, t: 0, idx: 0, key };
      this.layout();
      this.r.requestRender();
    });
  }

  private dropGif() {
    const p = this.player;
    if (!p) return;
    this.player = null;
    p.sprite.destroy();
    p.frames.forEach((t) => t.destroy(false));
    this.r.textures.release(p.key);
    this.r.gifSlots--;
    this.layout();
  }

  tickGif(dtMs: number) {
    const p = this.player;
    if (!p || !this.visible) return false;
    p.t = (p.t + dtMs) % p.total;
    let i = p.idx;
    if (p.t < p.starts[i]) i = 0;
    while (i + 1 < p.starts.length && p.starts[i + 1] <= p.t) i++;
    if (i !== p.idx) {
      p.idx = i;
      p.sprite.texture = p.frames[i];
    }
    return true;
  }

  destroy() {
    this.alive = false;
    this.dropGif();
    this.dropTexture();
    this.root.destroy({ children: true });
  }
}

class TextView implements View {
  readonly id: string;
  readonly root = new Container();
  item: TextItem;
  private bg = new Graphics();
  private txt: Text;
  private sig = "";
  private res = 1;
  private hidden = false;

  constructor(item: TextItem, private r: BoardRenderer) {
    this.id = item.id;
    this.item = item;
    this.txt = new Text({ text: item.text, style: textStyle(item.fontSize, item.width, r.palette.text) });
    this.txt.position.set(NOTE_PAD, NOTE_PAD);
    this.root.addChild(this.bg, this.txt);
  }

  update(item: TextItem) {
    this.item = item;
    place(this.root, item);
    this.redraw();
  }

  restyle() {
    this.sig = "";
    this.redraw();
  }

  setHidden(h: boolean) {
    this.hidden = h;
    this.txt.visible = !h;
  }

  private redraw() {
    const i = this.item;
    const p = this.r.palette;
    const sig = `${i.text}|${i.fontSize}|${i.width}|${i.height}|${p.name}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.bg.clear().roundRect(0, 0, i.width, i.height, 4).fill({ color: p.note });
    this.txt.style = textStyle(i.fontSize, i.width, p.text);
    this.txt.text = i.text;
    this.txt.visible = !this.hidden;
  }

  sync(vis: boolean) {
    this.root.visible = vis;
    if (!vis) return;
    // Rasterise at the on-screen scale (quantised) so text stays sharp when zoomed in, cheap when out.
    const want = this.r.vp.zoom * this.r.app.renderer.resolution;
    const steps = [0.5, 1, 1.5, 2, 3, 4];
    let res = steps.find((s) => s >= want) ?? 4;
    res = Math.min(res, Math.max(0.5, 4096 / Math.max(1, this.item.width)));
    if (res !== this.res) {
      this.res = res;
      this.txt.resolution = res;
    }
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

class StrokeView implements View {
  readonly id: string;
  readonly root = new Container();
  item: StrokeItem;
  private g = new Graphics();
  private drawn: StrokeItem | null = null;
  private drawnTheme = "";

  constructor(item: StrokeItem, private r: BoardRenderer) {
    this.id = item.id;
    this.item = item;
    this.root.addChild(this.g);
  }

  update(item: StrokeItem) {
    this.item = item;
    place(this.root, item);
    this.redraw();
  }

  restyle() {
    this.redraw();
  }

  private redraw() {
    const s = this.item;
    const theme = this.r.palette.name;
    const d = this.drawn;
    if (d && d.points === s.points && d.width === s.width && d.height === s.height && d.color === s.color && d.size === s.size && this.drawnTheme === theme) return;
    this.drawn = s;
    this.drawnTheme = theme;
    drawStroke(this.g, s, colorOf(s.color, this.r.palette));
  }

  sync(vis: boolean) {
    this.root.visible = vis;
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

/** Smooth polyline through the points (quadratic curves via midpoints). Coordinates are in item space. */
export function drawStroke(g: Graphics, s: Pick<StrokeItem, "points" | "width" | "height" | "bw" | "bh" | "size">, color: number) {
  const sx = s.width / s.bw;
  const sy = s.height / s.bh;
  const p = s.points;
  g.clear();
  if (p.length < 4 || (p.length === 4 && p[0] === p[2] && p[1] === p[3])) {
    g.circle(p[0] * sx, p[1] * sy, s.size / 2).fill({ color });
    return;
  }
  g.moveTo(p[0] * sx, p[1] * sy);
  for (let i = 2; i + 3 < p.length; i += 2) {
    g.quadraticCurveTo(p[i] * sx, p[i + 1] * sy, ((p[i] + p[i + 2]) / 2) * sx, ((p[i + 1] + p[i + 3]) / 2) * sy);
  }
  g.lineTo(p[p.length - 2] * sx, p[p.length - 1] * sy);
  g.stroke({ width: s.size, color, cap: "round", join: "round" });
}
