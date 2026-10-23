import { assetUrl, kindOf } from "../api";
import type { Item, MediaItem, Pen, StrokeItem, TextItem, Tool, Viewport } from "../types";
import { bottomZ, hitItem, itemRect, newId, rectsIntersect, round1, simplify, strokeHit, topZ, unionRect, unionRects, type Rect } from "./geometry";
import { FONT, LINE_HEIGHT, NOTE_PAD, BoardRenderer, drawStroke, textHeight } from "./renderer";

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;
const MIN_MEDIA = 24;
const HANDLE = 8; // px
const HANDLE_HIT = 8;
const DRAG_THRESHOLD = 3;
const VIEWPORT_NOTIFY_MS = 200;

type Handle = "nw" | "ne" | "sw" | "se" | "e" | "w";

type Drag =
  | { k: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { k: "move"; sx: number; sy: number; ids: string[]; origin: Map<string, { x: number; y: number }>; started: boolean; clickId: string | null }
  | { k: "resize"; h: Handle; id: string; sx: number; sy: number; o: Rect; started: boolean }
  | { k: "marquee"; sx: number; sy: number; cx: number; cy: number; base: Set<string> }
  | { k: "pen"; pts: number[] }
  | { k: "erase"; hit: Set<string>; last: { x: number; y: number } };

export interface Host {
  onCommit(items: Item[]): void;
  onViewport(vp: Viewport): void;
  onSelect(ids: string[]): void;
  onDropAsset(path: string, wx: number, wy: number): void;
}

export interface Props {
  items: Item[];
  selection: string[];
  tool: Tool;
  pen: Pen;
}

export class BoardController {
  private items: Item[] = [];
  /** Lists we applied via emit() whose React round-trip hasn't arrived yet. */
  private emitted: Item[][] = [];
  private sel = new Set<string>();
  private tool: Tool = "select";
  private pen: Pen = { color: "ink", size: 3 };
  private vp: Viewport = { x: 0, y: 0, zoom: 1 };
  private drag: Drag | null = null;
  private space = false;
  private preview = new Map<string, Rect>();
  private marquee: Rect | null = null;
  private rect: DOMRect;
  private notifyTimer = 0;

  private editor: { ta: HTMLTextAreaElement; item: TextItem; isNew: boolean } | null = null;
  private video: { box: HTMLDivElement; el: HTMLVideoElement; grip: HTMLDivElement; path: string } | null = null;
  private cleanup: (() => void)[] = [];

  constructor(private host: HTMLElement, private r: BoardRenderer, private cb: Host) {
    this.rect = host.getBoundingClientRect();
    const on = (t: HTMLElement | Window, ev: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn, opts);
      this.cleanup.push(() => t.removeEventListener(ev, fn, opts));
    };
    on(host, "pointerdown", (e) => this.down(e));
    on(host, "pointermove", (e) => this.move(e));
    on(host, "pointerup", (e) => this.up(e));
    on(host, "pointercancel", (e) => this.up(e));
    on(host, "dblclick", (e) => this.dbl(e));
    on(host, "wheel", (e) => this.wheel(e), { passive: false });
    on(host, "contextmenu", (e) => e.preventDefault());
    on(host, "dragover", (e) => e.preventDefault());
    on(host, "drop", (e) => this.drop(e));
    // WKWebView reports trackpad pinch as non-standard gesture events.
    let last = 1;
    on(host, "gesturestart", (e) => {
      e.preventDefault();
      last = 1;
    });
    on(host, "gesturechange", (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, e.scale / last);
      last = e.scale;
    });
    const typing = (e: KeyboardEvent) => ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName);
    on(window, "keydown", (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e)) {
        e.preventDefault();
        this.space = true;
        this.updateCursor();
      }
    });
    on(window, "keyup", (e: KeyboardEvent) => {
      if (e.code === "Space") {
        this.space = false;
        this.updateCursor();
      }
    });
    const ro = new ResizeObserver(() => {
      this.rect = host.getBoundingClientRect();
      r.resize(host.clientWidth, host.clientHeight);
      this.refresh();
    });
    ro.observe(host);
    this.cleanup.push(() => ro.disconnect());
  }

  // ---- state from React ---------------------------------------------------------------------
  setProps(p: Props) {
    const echo = this.emitted.indexOf(p.items);
    if (echo >= 0) {
      // React handing back a list we already applied locally in emit()
      this.emitted.splice(0, echo + 1);
    } else if (p.items !== this.items) {
      // a change that didn't originate here (undo, delete, font size, new board…)
      this.emitted = [];
      this.items = p.items;
      this.preview.clear();
      this.r.setItems(p.items);
      this.drag = this.drag?.k === "pen" || this.drag?.k === "erase" ? this.drag : null;
    }
    this.sel = new Set(p.selection);
    if (p.tool !== this.tool) {
      this.tool = p.tool;
      this.endEdit();
    }
    this.pen = p.pen;
    this.refresh();
  }

  loadViewport(vp: Viewport) {
    this.vp = vp;
    this.r.setViewport(vp);
    this.refresh();
  }

  get itemsSnapshot() {
    return this.items;
  }
  get selectionIds() {
    return [...this.sel];
  }
  get viewport() {
    return this.vp;
  }
  get size() {
    return { w: this.host.clientWidth, h: this.host.clientHeight };
  }
  viewCenter() {
    const { w, h } = this.size;
    return { x: (w / 2 - this.vp.x) / this.vp.zoom, y: (h / 2 - this.vp.y) / this.vp.zoom };
  }

  // ---- viewport -----------------------------------------------------------------------------
  private setVp(vp: Viewport) {
    this.vp = vp;
    this.r.setViewport(vp);
    this.refresh();
    clearTimeout(this.notifyTimer);
    this.notifyTimer = window.setTimeout(() => this.cb.onViewport(this.vp), VIEWPORT_NOTIFY_MS);
  }

  setViewport(vp: Viewport) {
    this.setVp(vp);
  }

  private zoomAt(cx: number, cy: number, factor: number) {
    const vp = this.vp;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * factor));
    const k = zoom / vp.zoom;
    const px = cx - this.rect.left;
    const py = cy - this.rect.top;
    this.setVp({ zoom, x: px - (px - vp.x) * k, y: py - (py - vp.y) * k });
  }

  zoomTo(zoom: number) {
    const { w, h } = this.size;
    const c = this.viewCenter();
    this.setVp({ zoom, x: w / 2 - c.x * zoom, y: h / 2 - c.y * zoom });
  }

  fit(items: Item[] = this.items) {
    const u = unionRect(items);
    const { w, h } = this.size;
    if (!u) return this.setVp({ x: 0, y: 0, zoom: 1 });
    const zoom = Math.min(2, Math.max(MIN_ZOOM, Math.min(w / Math.max(1, u.w), h / Math.max(1, u.h)) * 0.9));
    this.setVp({ zoom, x: w / 2 - (u.x + u.w / 2) * zoom, y: h / 2 - (u.y + u.h / 2) * zoom });
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else {
      this.setVp({ ...this.vp, x: this.vp.x - e.deltaX, y: this.vp.y - e.deltaY });
    }
  }

  // ---- coordinates --------------------------------------------------------------------------
  private screen(e: PointerEvent) {
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }
  private world(sx: number, sy: number) {
    return { x: (sx - this.vp.x) / this.vp.zoom, y: (sy - this.vp.y) / this.vp.zoom };
  }
  private toScreen(r: Rect): Rect {
    const z = this.vp.zoom;
    return { x: r.x * z + this.vp.x, y: r.y * z + this.vp.y, w: r.w * z, h: r.h * z };
  }
  private rectOf(i: Item): Rect {
    return this.preview.get(i.id) ?? itemRect(i);
  }
  private selected(): Item[] {
    return this.items.filter((i) => this.sel.has(i.id));
  }

  // ---- handles ------------------------------------------------------------------------------
  private handles(): { h: Handle; x: number; y: number }[] {
    const sel = this.selected();
    if (sel.length !== 1 || this.editor || this.tool !== "select") return [];
    const it = sel[0];
    const s = this.toScreen(this.rectOf(it));
    const hs: { h: Handle; x: number; y: number }[] = [
      { h: "nw", x: s.x, y: s.y },
      { h: "ne", x: s.x + s.w, y: s.y },
      { h: "sw", x: s.x, y: s.y + s.h },
      { h: "se", x: s.x + s.w, y: s.y + s.h },
    ];
    if (it.type === "text") {
      hs.push({ h: "w", x: s.x, y: s.y + s.h / 2 }, { h: "e", x: s.x + s.w, y: s.y + s.h / 2 });
    }
    return hs;
  }

  private handleAt(sx: number, sy: number): Handle | null {
    for (const h of this.handles()) if (Math.abs(sx - h.x) <= HANDLE_HIT && Math.abs(sy - h.y) <= HANDLE_HIT) return h.h;
    return null;
  }

  // ---- pointer ------------------------------------------------------------------------------
  private down(e: PointerEvent) {
    if ((e.target as HTMLElement).closest(".video-layer")) return;
    this.rect = this.host.getBoundingClientRect();
    this.endEdit();
    const s = this.screen(e);
    const w = this.world(s.x, s.y);
    this.capture(e.pointerId);

    if (e.button === 1 || this.space) {
      this.drag = { k: "pan", sx: e.clientX, sy: e.clientY, vx: this.vp.x, vy: this.vp.y };
      return this.updateCursor();
    }
    if (e.button !== 0) return;

    if (this.tool === "pen") {
      this.drag = { k: "pen", pts: [w.x, w.y] };
      return this.drawLive();
    }
    if (this.tool === "eraser") {
      this.drag = { k: "erase", hit: new Set(), last: w };
      return this.eraseAt(w.x, w.y, w.x, w.y);
    }

    const handle = this.handleAt(s.x, s.y);
    if (handle) {
      const it = this.selected()[0];
      this.drag = { k: "resize", h: handle, id: it.id, sx: e.clientX, sy: e.clientY, o: itemRect(it), started: false };
      return;
    }

    const hit = hitItem(this.items, w.x, w.y, 6 / this.vp.zoom);
    if (hit) {
      let clickId: string | null = null;
      if (e.shiftKey) {
        const next = new Set(this.sel);
        if (next.has(hit.id)) {
          next.delete(hit.id);
          this.setSelection([...next]);
          return;
        }
        next.add(hit.id);
        this.setSelection([...next]);
      } else if (!this.sel.has(hit.id)) {
        this.setSelection([hit.id]);
      } else if (this.sel.size > 1) {
        clickId = hit.id; // collapse to this item on release if it turns out to be a click, not a drag
      }
      this.beginMove(e.clientX, e.clientY, clickId);
      return;
    }

    this.drag = { k: "marquee", sx: s.x, sy: s.y, cx: s.x, cy: s.y, base: e.shiftKey ? new Set(this.sel) : new Set() };
    if (!e.shiftKey) this.setSelection([]);
  }

  private capture(id: number) {
    try {
      this.host.setPointerCapture(id);
    } catch {
      /* not an active pointer (synthetic events in the self-test) */
    }
  }

  private beginMove(cx: number, cy: number, clickId: string | null) {
    const ids = [...this.sel];
    const origin = new Map<string, { x: number; y: number }>();
    for (const i of this.items) if (this.sel.has(i.id)) origin.set(i.id, { x: i.x, y: i.y });
    this.drag = { k: "move", sx: cx, sy: cy, ids, origin, started: false, clickId };
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d) return this.hover(e);
    const z = this.vp.zoom;
    if (d.k === "pan") {
      this.setVp({ ...this.vp, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) });
    } else if (d.k === "move") {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.started && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.started = true;
      this.hideVideo();
      for (const id of d.ids) {
        const o = d.origin.get(id)!;
        const it = this.items.find((i) => i.id === id)!;
        const nx = o.x + dx / z;
        const ny = o.y + dy / z;
        this.preview.set(id, { x: nx, y: ny, w: it.width, h: it.height });
        this.r.view(id)?.root.position.set(nx, ny);
      }
      this.r.requestRender();
      this.drawOverlay();
    } else if (d.k === "resize") {
      this.resizeTo(d, e);
    } else if (d.k === "marquee") {
      const s = this.screen(e);
      d.cx = s.x;
      d.cy = s.y;
      const a = this.world(Math.min(d.sx, s.x), Math.min(d.sy, s.y));
      const b = this.world(Math.max(d.sx, s.x), Math.max(d.sy, s.y));
      this.marquee = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
      const next = new Set(d.base);
      for (const i of this.items) if (rectsIntersect(itemRect(i), this.marquee)) next.add(i.id);
      this.sel = next;
      this.drawOverlay();
    } else if (d.k === "pen") {
      const evs = e.getCoalescedEvents?.() ?? [e];
      const minD = 1.5 / z;
      for (const ev of evs.length ? evs : [e]) {
        const w = this.world(ev.clientX - this.rect.left, ev.clientY - this.rect.top);
        const n = d.pts.length;
        if (Math.hypot(w.x - d.pts[n - 2], w.y - d.pts[n - 1]) >= minD) d.pts.push(w.x, w.y);
      }
      this.drawLive();
    } else if (d.k === "erase") {
      const s = this.screen(e);
      const w = this.world(s.x, s.y);
      this.eraseAt(d.last.x, d.last.y, w.x, w.y);
      d.last = w;
    }
  }

  private resizeTo(d: Extract<Drag, { k: "resize" }>, e: PointerEvent) {
    const it = this.items.find((i) => i.id === d.id);
    const root = this.r.view(d.id)?.root;
    if (!it || !root) return;
    const z = this.vp.zoom;
    const dx = (e.clientX - d.sx) / z;
    const dy = (e.clientY - d.sy) / z;
    if (!d.started && Math.hypot(dx, dy) * z < 2) return;
    d.started = true;
    this.hideVideo();
    const { o } = d;
    const cx = d.h.includes("e") ? 1 : d.h.includes("w") ? -1 : 0;
    const cy = d.h.includes("s") ? 1 : d.h.includes("n") ? -1 : 0;
    let rect: Rect;

    if (it.type === "text" && cy === 0) {
      // side handle: reflow the note to a new width
      const w = Math.max(60, o.w + cx * dx);
      const h = textHeight(it.text, it.fontSize, w);
      rect = { x: cx < 0 ? o.x + o.w - w : o.x, y: o.y, w, h };
      this.r.view(d.id)?.update({ ...it, x: rect.x, y: rect.y, width: w, height: h });
    } else if (it.type === "text") {
      // corner handle: scale the whole note, font size included
      const s = Math.min(40, Math.max(0.1, (o.w + cx * dx) / o.w));
      rect = { x: cx < 0 ? o.x + o.w - o.w * s : o.x, y: cy < 0 ? o.y + o.h - o.h * s : o.y, w: o.w * s, h: o.h * s };
      root.position.set(rect.x, rect.y);
      root.scale.set(s);
    } else {
      const lock = !e.shiftKey;
      const min = it.type === "stroke" ? 4 : MIN_MEDIA;
      let w = Math.max(min, o.w + cx * dx);
      let h = Math.max(min, o.h + cy * dy);
      if (lock) {
        h = (w * o.h) / o.w;
        if (h < min) {
          h = min;
          w = (h * o.w) / o.h;
        }
      }
      rect = { x: cx < 0 ? o.x + o.w - w : o.x, y: cy < 0 ? o.y + o.h - h : o.y, w, h };
      root.position.set(rect.x, rect.y);
      root.scale.set(w / o.w, h / o.h);
    }
    this.preview.set(d.id, rect);
    this.r.requestRender();
    this.drawOverlay();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId);
    if (!d) return;

    if (d.k === "move") {
      if (d.started) {
        const items = this.items.map((i) => {
          const p = d.origin.has(i.id) ? this.preview.get(i.id) : null;
          return p ? { ...i, x: Math.round(p.x), y: Math.round(p.y) } : i;
        });
        this.commit(items, d.ids);
      } else if (d.clickId) {
        this.setSelection([d.clickId]);
      }
    } else if (d.k === "resize") {
      const p = this.preview.get(d.id);
      if (d.started && p) {
        const items = this.items.map((i) => {
          if (i.id !== d.id) return i;
          if (i.type === "text") {
            const s = p.w / d.o.w;
            const corner = d.h.length === 2;
            const fontSize = corner ? Math.max(4, Math.round(i.fontSize * s)) : i.fontSize;
            const width = Math.round(p.w);
            return { ...i, x: Math.round(p.x), y: Math.round(p.y), width, fontSize, height: textHeight(i.text, fontSize, width) };
          }
          return { ...i, x: Math.round(p.x), y: Math.round(p.y), width: Math.max(1, Math.round(p.w)), height: Math.max(1, Math.round(p.h)) };
        });
        this.commit(items, [d.id]);
      }
    } else if (d.k === "marquee") {
      this.marquee = null;
      this.cb.onSelect([...this.sel]);
    } else if (d.k === "pen") {
      this.r.live.clear();
      this.finishStroke(d.pts);
    } else if (d.k === "erase") {
      if (d.hit.size) this.emit(this.items.filter((i) => !d.hit.has(i.id)));
    }
    this.drawOverlay();
    this.updateCursor();
    this.updateVideo();
  }

  /** Send a new item list to the app and adopt it locally right away (React catches up a frame later). */
  private emit(items: Item[]) {
    this.items = items;
    this.emitted.push(items);
    this.r.setItems(items); // draw it now; React's copy of the same list is recognised in setProps
    this.cb.onCommit(items);
  }

  /** Hand a finished gesture to the app; if nothing changed, put the preview back. */
  private commit(items: Item[], touched: string[]) {
    this.emit(items);
    // React re-renders async; clear previews now so a no-op change doesn't leave stale transforms.
    for (const id of touched) {
      const it = items.find((i) => i.id === id);
      if (it) this.r.view(id)?.update(it as never);
    }
    this.preview.clear();
  }

  private hover(e: PointerEvent) {
    if (this.tool !== "select" || this.space) return;
    const s = this.screen(e);
    const h = this.handleAt(s.x, s.y);
    this.host.style.cursor = h ? (h === "e" || h === "w" ? "ew-resize" : h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize") : "default";
  }

  private updateCursor() {
    this.host.style.cursor = this.space ? (this.drag?.k === "pan" ? "grabbing" : "grab") : this.tool === "select" ? "default" : "crosshair";
  }

  // ---- drawing tools ------------------------------------------------------------------------
  private penColor() {
    return this.pen.color === "ink" ? this.r.palette.text : parseInt(this.pen.color.replace("#", ""), 16);
  }

  private drawLive() {
    const d = this.drag;
    if (d?.k !== "pen") return;
    drawStroke(this.r.live, { points: d.pts, width: 1, height: 1, bw: 1, bh: 1, size: this.pen.size / this.vp.zoom }, this.penColor());
    this.r.requestRender();
  }

  private finishStroke(raw: number[]) {
    const z = this.vp.zoom;
    const pts = simplify(raw, 0.5 / z);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
    const ox = round1(x0);
    const oy = round1(y0);
    const rel = pts.map((v, i) => round1(v - (i % 2 ? oy : ox)));
    const w = Math.max(1, round1(x1 - ox));
    const h = Math.max(1, round1(y1 - oy));
    const stroke: StrokeItem = {
      id: newId(), type: "stroke", x: ox, y: oy, width: w, height: h, rotation: 0, zIndex: topZ(this.items),
      points: rel.length >= 4 ? rel : [0, 0, 0, 0], bw: w, bh: h, color: this.pen.color, size: round1(this.pen.size / z),
    };
    this.emit([...this.items, stroke]);
  }

  private eraseAt(ax: number, ay: number, bx: number, by: number) {
    const d = this.drag;
    if (d?.k !== "erase") return;
    const tol = 8 / this.vp.zoom;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (tol / 2)));
    for (let k = 0; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps;
      const y = ay + ((by - ay) * k) / steps;
      for (const i of this.items) {
        if (i.type === "stroke" && !d.hit.has(i.id) && strokeHit(i, x, y, tol)) {
          d.hit.add(i.id);
          const v = this.r.view(i.id);
          if (v) v.root.visible = false;
        }
      }
    }
    this.r.requestRender();
  }

  // ---- selection ----------------------------------------------------------------------------
  private setSelection(ids: string[]) {
    this.sel = new Set(ids);
    this.cb.onSelect(ids);
    this.refresh();
  }

  private drawOverlay() {
    const g = this.r.overlay;
    g.clear();
    const accent = this.r.palette.accent;
    const sel = this.selected();
    for (const i of sel) {
      const s = this.toScreen(this.rectOf(i));
      g.rect(s.x, s.y, s.w, s.h).stroke({ width: 1.5, color: accent });
    }
    if (sel.length > 1) {
      const u = unionRects(sel.map((i) => this.rectOf(i)));
      if (u) {
        const s = this.toScreen(u);
        g.rect(s.x - 3, s.y - 3, s.w + 6, s.h + 6).stroke({ width: 1, color: accent, alpha: 0.5 });
      }
    }
    for (const h of this.handles()) {
      if (h.h === "e" || h.h === "w") g.roundRect(h.x - 3, h.y - 9, 6, 18, 3);
      else g.rect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE);
      g.fill({ color: this.r.palette.handle }).stroke({ width: 1.5, color: accent });
    }
    if (this.drag?.k === "marquee") {
      const d = this.drag;
      g.rect(Math.min(d.sx, d.cx), Math.min(d.sy, d.cy), Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy))
        .fill({ color: accent, alpha: 0.08 })
        .stroke({ width: 1, color: accent, alpha: 0.8 });
    }
    this.r.requestRender();
  }

  /** Redraw everything that depends on viewport, selection or items. */
  refresh() {
    this.drawOverlay();
    this.placeEditor();
    this.updateVideo();
    this.updateCursor();
  }

  // ---- text editing -------------------------------------------------------------------------
  private dbl(e: MouseEvent) {
    if (this.tool !== "select") return;
    const s = { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
    const w = this.world(s.x, s.y);
    const hit = hitItem(this.items, w.x, w.y, 6 / this.vp.zoom);
    if (hit?.type === "text") this.beginEdit(hit, false);
    else if (!hit) this.createText(w);
  }

  createText(at?: { x: number; y: number }) {
    const z = this.vp.zoom;
    const fontSize = Math.round(Math.min(400, Math.max(10, 18 / z)));
    const width = fontSize * 15;
    const c = at ?? { x: this.viewCenter().x - width / 2, y: this.viewCenter().y - fontSize };
    const item: TextItem = {
      id: newId(), type: "text", text: "", fontSize, x: Math.round(c.x), y: Math.round(c.y), width,
      height: textHeight("", fontSize, width), rotation: 0, zIndex: topZ(this.items),
    };
    this.beginEdit(item, true);
  }

  beginEdit(item: TextItem, isNew: boolean) {
    this.endEdit();
    const ta = document.createElement("textarea");
    ta.className = "note-editor";
    ta.value = item.text;
    ta.spellcheck = false;
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.max(item.height * this.vp.zoom, ta.scrollHeight)}px`;
    });
    ta.addEventListener("blur", () => this.endEdit());
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) ta.blur();
      e.stopPropagation();
    });
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.host.appendChild(ta);
    this.editor = { ta, item, isNew };
    this.r.setEditing(isNew ? null : item.id);
    this.placeEditor();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  private placeEditor() {
    const ed = this.editor;
    if (!ed) return;
    const { x, y, zoom: z } = this.vp;
    const i = ed.item;
    const s = ed.ta.style;
    s.left = `${i.x * z + x}px`;
    s.top = `${i.y * z + y}px`;
    s.width = `${i.width * z}px`;
    s.minHeight = `${i.height * z}px`;
    s.fontSize = `${i.fontSize * z}px`;
    s.lineHeight = String(LINE_HEIGHT);
    s.padding = `${NOTE_PAD * z}px`;
    s.borderRadius = `${4 * z}px`;
    s.fontFamily = FONT;
    s.height = "auto";
    s.height = `${Math.max(i.height * z, ed.ta.scrollHeight)}px`;
  }

  endEdit() {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    const text = ed.ta.value;
    ed.ta.remove();
    this.r.setEditing(null);
    const cur = this.items.find((i) => i.id === ed.item.id);
    if (ed.isNew) {
      if (text.trim()) {
        const it = { ...ed.item, text, height: textHeight(text, ed.item.fontSize, ed.item.width) };
        this.emit([...this.items, it]);
        this.setSelection([it.id]);
      }
    } else if (cur?.type === "text") {
      if (!text.trim()) {
        this.emit(this.items.filter((i) => i.id !== cur.id));
        this.setSelection([]);
      } else if (text !== cur.text) {
        this.emit(this.items.map((i) => (i.id === cur.id ? { ...cur, text, height: textHeight(text, cur.fontSize, cur.width) } : i)));
      }
    }
  }

  // ---- video overlay ------------------------------------------------------------------------
  /** A selected video gets a real <video controls> on top of the canvas: play/pause, scrub, volume. */
  private updateVideo() {
    const sel = this.selected();
    const it = sel.length === 1 && sel[0].type === "media" && kindOf(sel[0].path) === "video" ? (sel[0] as MediaItem) : null;
    if (!it || this.tool !== "select" || this.r.missing.has(it.id) || (this.drag && this.drag.k !== "pan")) return this.hideVideo();
    if (!this.video) {
      const box = document.createElement("div");
      box.className = "video-layer";
      const grip = document.createElement("div");
      grip.className = "video-grip";
      grip.title = "Drag to move";
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.capture(e.pointerId);
        this.beginMove(e.clientX, e.clientY, null);
      });
      const el = document.createElement("video");
      el.controls = true;
      el.loop = true;
      el.preload = "metadata";
      box.append(grip, el);
      this.host.appendChild(box);
      this.video = { box, el, grip, path: "" };
    }
    const v = this.video;
    const url = assetUrl(this.r.rootAbs, it.path);
    if (v.path !== url) {
      v.el.pause();
      v.el.src = url;
      v.path = url;
    }
    const s = this.toScreen(this.rectOf(it));
    v.box.style.cssText = `left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px`;
  }

  private hideVideo() {
    if (!this.video) return;
    this.video.el.pause();
    this.video.box.remove();
    this.video = null;
  }

  // ---- drops --------------------------------------------------------------------------------
  private drop(e: DragEvent) {
    const path = e.dataTransfer?.getData("application/x-mb-asset");
    if (!path) return;
    e.preventDefault();
    const w = this.world(e.clientX - this.rect.left, e.clientY - this.rect.top);
    this.cb.onDropAsset(path, w.x, w.y);
  }

  // ---- misc ---------------------------------------------------------------------------------
  zOrder(ids: string[], toFront: boolean): Item[] {
    const picked = this.items.filter((i) => ids.includes(i.id)).sort((a, b) => a.zIndex - b.zIndex);
    let z = toFront ? topZ(this.items) : bottomZ(this.items) - picked.length + 1;
    const next = new Map(picked.map((i) => [i.id, z++]));
    return this.items.map((i) => (next.has(i.id) ? { ...i, zIndex: next.get(i.id)! } : i));
  }

  destroy() {
    this.endEdit();
    this.hideVideo();
    clearTimeout(this.notifyTimer);
    this.cleanup.forEach((f) => f());
  }
}
