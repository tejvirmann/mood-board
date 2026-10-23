import { invoke } from "@tauri-apps/api/core";

export interface Thumb {
  path: string;
  w: number;
  h: number;
}

const MAX_PARALLEL = 4;
/** Longest side of each source image seen so far, so callers never ask for a tier above the original. */
export const sourceMax = new Map<string, number>();
const done = new Map<string, Thumb | null>();
const inflight = new Map<string, Promise<Thumb | null>>();
const queue: { key: string; run: () => void }[] = [];
let running = 0;

function pump() {
  // Newest request first: whatever is on screen now matters more than what scrolled past.
  while (running < MAX_PARALLEL && queue.length) {
    running++;
    queue.pop()!.run();
  }
}

/**
 * Cached thumbnail whose longest side is at most `size`. Resolves null if the file can't be decoded
 * natively (the caller then falls back to the original). Requests are de-duplicated and rate-limited.
 */
export function getThumb(rootAbs: string, rel: string, size: number): Promise<Thumb | null> {
  const key = `${rootAbs}/${rel}@${size}`;
  if (done.has(key)) return Promise.resolve(done.get(key)!);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = new Promise<Thumb | null>((resolve) => {
    queue.push({
      key,
      run: () => {
        invoke<Thumb>("thumbnail", { source: `${rootAbs}/${rel}`, size })
          .then((t) => resolve(t), () => resolve(null))
          .finally(() => {
            running--;
            pump();
          });
      },
    });
  }).then((t) => {
    if (t) sourceMax.set(`${rootAbs}/${rel}`, Math.max(t.w, t.h));
    done.set(key, t);
    inflight.delete(key);
    return t;
  });
  inflight.set(key, p);
  pump();
  return p;
}

/** Already-resolved thumbnail, if any (lets virtualised lists remount without a flash). */
export const peekThumb = (rootAbs: string, rel: string, size: number) => done.get(`${rootAbs}/${rel}@${size}`);
