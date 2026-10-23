import { dirname, loadBoard, logLine, quit, saveBoard, selftestArg } from "./api";
import type { Item } from "./types";
import { Graphics, Rectangle } from "pixi.js";
import { perf } from "./board/renderer";
import { readPalette } from "./board/theme";
import type { CanvasApi } from "./CanvasHost";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-frame intervals while `drive(t)` runs for `ms`. */
function measure(ms: number, drive: (t: number) => void): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let start = 0;
    let last = 0;
    const step = (now: number) => {
      if (!start) start = last = now;
      else {
        deltas.push(now - last);
        last = now;
      }
      const t = now - start;
      if (t >= ms) return resolve(deltas);
      drive(t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;

async function report(label: string, deltas: number[], api: CanvasApi) {
  const s = [...deltas].sort((a, b) => a - b);
  const avg = deltas.reduce((x, y) => x + y, 0) / Math.max(1, deltas.length);
  const f = api.renderer.frame;
  const t = api.renderer.textures.stats;
  await logLine(
    `${label}: frames=${deltas.length} avg=${avg.toFixed(1)}ms p50=${pct(s, 0.5).toFixed(1)} p95=${pct(s, 0.95).toFixed(1)} p99=${pct(s, 0.99).toFixed(1)} max=${(s.at(-1) ?? 0).toFixed(1)} ` +
      `slow(>20ms)=${deltas.filter((d) => d > 20).length} | render cpu avg=${(f.cpuMs / Math.max(1, f.count)).toFixed(2)}ms max=${f.maxMs.toFixed(1)}ms | textures=${t.textures} gpu~${t.mb}MB`,
  );
}

// ---- interaction checks: synthetic pointer/keyboard events against the real app ----------------------

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  return logLine(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/** Render the WebGL scene to a PNG and emit it on stderr (decode with scripts/extract-snaps.py). */
async function snap(label: string, api: CanvasApi) {
  const { renderer } = api;
  // the canvas background colour isn't part of the stage, so paint it in for the capture
  const bg = new Graphics().rect(0, 0, renderer.width, renderer.height).fill({ color: renderer.palette.bg });
  renderer.app.stage.addChildAt(bg, 0);
  const url = await renderer.app.renderer.extract.base64({ target: renderer.app.stage, frame: new Rectangle(0, 0, renderer.width, renderer.height), resolution: 2, format: "png" });
  bg.destroy();
  await logLine(`PNG ${label} ${url}`);
}

async function settle(api: CanvasApi) {
  let q = 0;
  const t = performance.now();
  while (q < 5 && performance.now() - t < 30000) {
    await sleep(100);
    q = api.renderer.busy ? 0 : q + 1;
  }
}

async function interactions(open: (p: string) => Promise<void>, getApi: () => CanvasApi | null, dir: string) {
  const path = `${dir}/interact.mb`;
  const media = (id: string, rel: string, x: number, y: number): Item => ({ id, type: "media", path: rel, x, y, width: 300, height: 200, rotation: 0, zIndex: 1 });
  await saveBoard(path, {
    schemaVersion: 1, id: "interact", name: "Interact", assetRoot: "./assets", viewport: { x: 0, y: 0, zoom: 1 },
    items: [
      media("a", "characters/img_0000.jpg", 0, 0),
      media("b", "locations/city/img_0001.jpg", 400, 0),
      media("c", "locations/forest/img_0002.jpg", 0, 300),
      { id: "t", type: "text", text: "Hello note", fontSize: 20, x: 400, y: 300, width: 250, height: 60, rotation: 0, zIndex: 2 },
    ],
  });
  await open(path);
  await sleep(600);
  const api = getApi()!;
  const { ctl, renderer } = api;
  const host = document.querySelector(".canvas") as HTMLElement;
  ctl.setViewport({ x: 100, y: 100, zoom: 1 });
  await sleep(200);
  const r = () => host.getBoundingClientRect();
  const sx = (wx: number) => r().left + 100 + wx * ctl.viewport.zoom;
  const sy = (wy: number) => r().top + 100 + wy * ctl.viewport.zoom;
  const ptr = (type: string, x: number, y: number, extra: PointerEventInit = {}) =>
    host.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra }));
  const drag = async (x0: number, y0: number, x1: number, y1: number, extra: PointerEventInit = {}) => {
    ptr("pointerdown", x0, y0, extra);
    for (let i = 1; i <= 8; i++) {
      ptr("pointermove", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, extra);
      await sleep(8);
    }
    ptr("pointerup", x1, y1, extra);
    await sleep(150);
  };
  const key = async (k: string, extra: KeyboardEventInit = {}) => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
    await sleep(150);
  };
  const items = () => ctl.itemsSnapshot;
  const get = (id: string) => items().find((i) => i.id === id)!;

  await drag(sx(150), sy(100), sx(150), sy(100));
  await check("click selects", ctl.selectionIds.join() === "a", ctl.selectionIds.join());

  await drag(sx(150), sy(100), sx(230), sy(140));
  await check("drag moves item", get("a").x === 80 && get("a").y === 40, `${get("a").x},${get("a").y}`);
  await key("z", { metaKey: true });
  await check("undo restores position", get("a").x === 0 && get("a").y === 0, `${get("a").x},${get("a").y}`);
  await key("z", { metaKey: true, shiftKey: true });
  await check("redo reapplies", get("a").x === 80, `${get("a").x}`);

  await drag(sx(900), sy(700), sx(-50), sy(-50));
  await check("marquee selects all", ctl.selectionIds.length === 4, `${ctl.selectionIds.length}`);
  const before = items().map((i) => ({ id: i.id, x: i.x, y: i.y }));
  await drag(sx(100), sy(40), sx(120), sy(60));
  const moved = before.every((b) => get(b.id).x === b.x + 20 && get(b.id).y === b.y + 20);
  await check("group move", moved);
  await drag(sx(1200), sy(1200), sx(1210), sy(1210));
  await check("click empty deselects", ctl.selectionIds.length === 0);

  // resize image b by its SE handle (aspect locked)
  await drag(sx(get("b").x + 150), sy(get("b").y + 100), sx(get("b").x + 150), sy(get("b").y + 100));
  const b0 = { ...get("b") } as Item;
  await drag(sx(b0.x + b0.width), sy(b0.y + b0.height), sx(b0.x + b0.width + 60), sy(b0.y + b0.height));
  await check("resize keeps aspect", get("b").width === 360 && get("b").height === 240, `${get("b").width}x${get("b").height}`);

  // text: side handle reflows, corner handle scales font
  const t0 = get("t");
  await drag(sx(t0.x + 10), sy(t0.y + 10), sx(t0.x + 10), sy(t0.y + 10));
  const tt = get("t") as Item & { fontSize: number };
  await drag(sx(tt.x + tt.width), sy(tt.y + tt.height / 2), sx(tt.x + tt.width + 100), sy(tt.y + tt.height / 2));
  const t1 = get("t") as typeof tt;
  await check("text side handle changes width not font", t1.width === tt.width + 100 && t1.fontSize === tt.fontSize, `w ${tt.width}→${t1.width} fs ${tt.fontSize}→${t1.fontSize}`);
  await drag(sx(t1.x + t1.width), sy(t1.y + t1.height), sx(t1.x + t1.width + t1.width), sy(t1.y + t1.height + 40));
  const t2 = get("t") as typeof tt;
  await check("text corner handle scales font", t2.fontSize > t1.fontSize * 1.5, `fs ${t1.fontSize}→${t2.fontSize}`);

  // pen + eraser
  const n0 = items().length;
  await key("p");
  await drag(sx(700), sy(600), sx(900), sy(650));
  const last = items().at(-1)!;
  await check("pen draws a stroke", items().length === n0 + 1 && last.type === "stroke", `${items().length} items, last=${last.type}`);
  await key("e");
  await drag(sx(800), sy(550), sx(800), sy(700));
  await check("eraser removes stroke", items().length === n0 && !items().some((i) => i.type === "stroke"), `${items().length} items`);
  await key("z", { metaKey: true });
  await check("undo brings stroke back", items().some((i) => i.type === "stroke"));
  await key("v");

  // new note via double click
  host.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: sx(1000), clientY: sy(100) }));
  await sleep(150);
  const ta = host.querySelector("textarea.note-editor") as HTMLTextAreaElement | null;
  await check("double-click opens note editor", !!ta);
  if (ta) {
    ta.value = "A brand new note";
    ta.dispatchEvent(new Event("input"));
    ta.blur();
    await sleep(200);
    const note = items().find((i) => i.type === "text" && i.text === "A brand new note");
    await check("note saved on blur", !!note && note.height > 0, note ? `h=${note.height}` : "missing");
  }

  // delete
  await drag(sx(get("c").x + 150), sy(get("c").y + 100), sx(get("c").x + 150), sy(get("c").y + 100));
  await key("Delete");
  await check("delete removes selection", !items().some((i) => i.id === "c"));

  // autosave: what's on disk matches what's in memory
  await sleep(1500);
  const disk = JSON.parse((await loadBoard(path)).json) as { items: Item[] };
  await check("autosave wrote the board", disk.items.length === items().length && disk.items.some((i) => i.type === "stroke") && !disk.items.some((i) => i.id === "c"), `disk ${disk.items.length} vs memory ${items().length}`);
  ctl.fit();
  await sleep(300);
  await settle(api);
  await snap("interact-dark", api);
  document.documentElement.dataset.theme = "light";
  renderer.setPalette(readPalette("light"));
  await check("light palette differs", renderer.palette.bg === 0xececef, `bg=${renderer.palette.bg.toString(16)}`);
  await logLine("palette=" + JSON.stringify(renderer.palette));
  await sleep(300);
  await snap("interact-light", api);
  document.documentElement.dataset.theme = "dark";
  renderer.setPalette(readPalette("dark"));
  await check("renderer has a view per item", renderer.viewCount === items().length, `${renderer.viewCount} vs ${items().length}`);
}

/**
 * Scripted benchmark, only active when the app is launched with MB_SELFTEST=/path/to/board.mb.
 * Opens the board, lets textures settle, then pans and zooms while measuring frame times. Logs to stderr and quits.
 */
export async function runSelfTest(open: (path: string) => Promise<void>, getApi: () => CanvasApi | null) {
  const arg = await selftestArg().catch(() => null);
  if (!arg) return;
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    void logLine("console.error " + a.map(String).join(" "));
    orig(...a);
  };
  window.addEventListener("error", (e) => void logLine("window error " + e.message));
  window.addEventListener("unhandledrejection", (e) => void logLine("unhandled rejection " + String(e.reason)));

  perf.log = (m) => void logLine("perf " + m);
  try {
    await logLine(`selftest: ${arg}`);
    await logLine(`caps: ImageDecoder=${typeof (window as any).ImageDecoder} OffscreenCanvas=${typeof OffscreenCanvas} Worker=${typeof Worker} createImageBitmap=${typeof createImageBitmap} UA=${navigator.userAgent}`);
    const t0 = performance.now();
    await open(arg);
    let api = getApi();
    for (let i = 0; i < 300 && (!api || api.renderer.viewCount === 0); i++) {
      await sleep(100);
      api = getApi();
    }
    if (!api) throw new Error("canvas never became ready");
    const { ctl, renderer } = api;
    await logLine(`opened: items=${renderer.viewCount} size=${ctl.size.w}x${ctl.size.h} dpr=${devicePixelRatio} (${(performance.now() - t0).toFixed(0)}ms)`);

    ctl.fit();
    const fitVp = { ...ctl.viewport };
    const ts = performance.now();
    let quiet = 0;
    while (quiet < 5 && performance.now() - ts < 60000) {
      await sleep(100);
      quiet = renderer.busy ? 0 : quiet + 1;
    }
    await logLine(`settled at fit zoom=${fitVp.zoom.toFixed(3)} in ${(performance.now() - ts).toFixed(0)}ms | textures=${renderer.textures.stats.textures} gpu~${renderer.textures.stats.mb}MB`);

    await snap("bench-fit", api);
    renderer.resetFrameStats();
    await report("pan @fit", await measure(4000, (t) => ctl.setViewport({ zoom: fitVp.zoom, x: fitVp.x + Math.sin(t / 600) * 500, y: fitVp.y + Math.cos(t / 800) * 300 })), api);

    // zoom from the fit view in to 1:1-ish and back, around the middle of the view
    const { w, h } = ctl.size;
    const zIn = Math.max(1, fitVp.zoom * 6);
    renderer.resetFrameStats();
    const zoomDeltas = await measure(6000, (t) => {
      const k = (1 - Math.cos((t / 6000) * Math.PI * 2)) / 2; // 0 → 1 → 0
      const zoom = fitVp.zoom * Math.pow(zIn / fitVp.zoom, k);
      const cx = (w / 2 - fitVp.x) / fitVp.zoom;
      const cy = (h / 2 - fitVp.y) / fitVp.zoom;
      ctl.setViewport({ zoom, x: w / 2 - cx * zoom, y: h / 2 - cy * zoom });
    });
    await report("zoom fit→x6→fit", zoomDeltas, api);

    let q = 0;
    const tz = performance.now();
    while (q < 5 && performance.now() - tz < 30000) {
      await sleep(100);
      q = renderer.busy ? 0 : q + 1;
    }
    renderer.resetFrameStats();
    await sleep(1500);
    await logLine(`idle: renderer frames in 1.5s = ${renderer.frame.count} (0 means no wasted work)`);
    await interactions(open, getApi, dirname(arg));
    await logLine(failures ? `SELFTEST DONE with ${failures} failure(s)` : "SELFTEST DONE, all checks passed");
  } catch (e) {
    await logLine("SELFTEST FAILED " + String(e));
  }
  await quit();
}
