import { invoke } from "@tauri-apps/api/core";
import { Texture } from "pixi.js";
import { assetUrl, fileUrl } from "../api";
import { getThumb } from "./thumbs";

/** Longest-side sizes of the cached thumbnails; the last tier is the original file. */
export const TIERS = [256, 1024, 2560];
export const ORIGINAL = TIERS.length;

const GPU_BUDGET = 512 * 1024 * 1024;
const MAX_LOADS = 6;

interface Entry {
  tex: Texture;
  bytes: number;
  refs: number;
  lastUsed: number;
}

/** Bounded-parallelism job queue; newest job first, jobs whose requester gave up are skipped. */
class Loader {
  private q: { run: () => Promise<void>; cancelled: () => boolean }[] = [];
  private active = 0;
  get pending() {
    return this.q.length + this.active;
  }
  add(run: () => Promise<void>, cancelled: () => boolean) {
    this.q.push({ run, cancelled });
    this.pump();
  }
  private pump() {
    while (this.active < MAX_LOADS && this.q.length) {
      const job = this.q.pop()!;
      if (job.cancelled()) continue;
      this.active++;
      job.run().catch(() => {}).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

async function bitmapFrom(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return createImageBitmap(await res.blob());
}

/**
 * Reference-counted GPU texture cache with LRU eviction. A texture is addressed by file + resolution
 * tier, so zooming out swaps to small thumbnails and the big ones are released and eventually freed.
 */
export class TextureCache {
  private map = new Map<string, Entry>();
  private loading = new Map<string, Promise<Entry | null>>();
  private bytes = 0;
  readonly loader = new Loader();
  clock = 0;

  get stats() {
    return { textures: this.map.size, mb: Math.round(this.bytes / 1048576), pending: this.loader.pending };
  }

  peek(key: string): Texture | null {
    return this.map.get(key)?.tex ?? null;
  }

  /** Synchronous `acquire` for an already-resident texture. */
  take(key: string): Texture | null {
    const e = this.map.get(key);
    if (!e) return null;
    e.refs++;
    e.lastUsed = ++this.clock;
    return e.tex;
  }

  /** Take a reference (must be paired with `release`). Resolves null if the file can't be loaded. */
  acquire(key: string, make: () => Promise<{ tex: Texture; bytes: number } | null>, cancelled: () => boolean): Promise<Texture | null> {
    const hit = this.map.get(key);
    if (hit) {
      hit.refs++;
      hit.lastUsed = ++this.clock;
      return Promise.resolve(hit.tex);
    }
    let p = this.loading.get(key);
    if (!p) {
      p = new Promise<Entry | null>((resolve) => {
        this.loader.add(
          async () => {
            const made = await make().catch((e) => {
              console.error("texture load failed", key, String(e));
              return null;
            });
            if (!made) return resolve(null);
            const e: Entry = { tex: made.tex, bytes: made.bytes, refs: 0, lastUsed: ++this.clock };
            this.map.set(key, e);
            this.bytes += e.bytes;
            resolve(e);
            this.evict();
          },
          () => {
            if (!cancelled()) return false;
            resolve(null);
            return true;
          },
        );
      }).finally(() => this.loading.delete(key));
      this.loading.set(key, p);
    }
    return p.then((e) => {
      if (!e) return null;
      e.refs++;
      e.lastUsed = ++this.clock;
      return e.tex;
    });
  }

  release(key: string) {
    const e = this.map.get(key);
    if (e && e.refs > 0) e.refs--;
  }

  private evict() {
    if (this.bytes <= GPU_BUDGET) return;
    const idle = [...this.map.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, e] of idle) {
      if (this.bytes <= GPU_BUDGET * 0.8) break;
      this.map.delete(k);
      this.bytes -= e.bytes;
      e.tex.destroy(true);
    }
  }

  clear() {
    for (const e of this.map.values()) e.tex.destroy(true);
    this.map.clear();
    this.bytes = 0;
  }
}

export const keyOf = (rootAbs: string, path: string, tier: number) => `${rootAbs}/${path}@${tier}`;

export function imageMaker(rootAbs: string, path: string, tier: number) {
  return async () => {
    let url = assetUrl(rootAbs, path);
    if (tier < ORIGINAL) {
      const t = await getThumb(rootAbs, path, TIERS[tier]);
      if (t) url = fileUrl(t.path);
    }
    const bmp = await bitmapFrom(url);
    return { tex: Texture.from(bmp), bytes: bmp.width * bmp.height * 4 };
  };
}

/** First frame of a video as a texture. */
export function posterMaker(rootAbs: string, path: string) {
  return () =>
    new Promise<{ tex: Texture; bytes: number } | null>((resolve) => {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.crossOrigin = "anonymous";
      const finish = (r: { tex: Texture; bytes: number } | null) => {
        v.removeAttribute("src");
        v.load();
        resolve(r);
      };
      v.onerror = () => finish(null);
      v.onloadeddata = () => {
        v.currentTime = Math.min(0.1, (v.duration || 0.2) / 2);
      };
      v.onseeked = () => {
        const s = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(v.videoWidth * s));
        c.height = Math.max(1, Math.round(v.videoHeight * s));
        c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
        finish({ tex: Texture.from(c), bytes: c.width * c.height * 4 });
      };
      v.src = assetUrl(rootAbs, path);
    });
}

export interface GifMeta {
  cols: number;
  frameW: number;
  frameH: number;
  delays: number[];
}
/** Sprite-sheet layout of each decoded GIF, keyed like its texture. */
export const gifMeta = new Map<string, GifMeta>();
const GIF_MAX_PIXELS = 4_000_000;

export function gifMaker(rootAbs: string, path: string, key: string) {
  return async () => {
    const a = await invoke<GifMeta & { path: string }>("gif_atlas", { source: `${rootAbs}/${path}`, maxPixels: GIF_MAX_PIXELS });
    gifMeta.set(key, a);
    const bmp = await bitmapFrom(fileUrl(a.path));
    return { tex: Texture.from(bmp), bytes: bmp.width * bmp.height * 4 };
  };
}
