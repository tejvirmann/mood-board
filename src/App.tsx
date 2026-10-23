import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Browser from "./Browser";
import CanvasHost, { type CanvasApi } from "./CanvasHost";
import {
  assetUrl, basename, dirname, kindOf, loadBoard, pickBoardToCreate, pickBoardToOpen, pickFolder, pickMediaFile,
  probe, saveBoard, scanDir, setRoot, takePendingOpen,
} from "./api";
import { newId, topZ } from "./board/geometry";
import { textHeight } from "./board/renderer";
import { getThumb } from "./board/thumbs";
import type { ThemeName } from "./board/theme";
import { runSelfTest } from "./selftest";
import type { Board, Doc, Entry, Item, Pen, TextItem, Tool, Viewport } from "./types";

const RECENT_KEY = "mb.recent";
const THEME_KEY = "mb.theme";
const HISTORY_LIMIT = 200;
const START_SIZE = 420;
const SAVE_DELAY = 500; // content edits
const VIEW_SAVE_DELAY = 2000; // pan/zoom only
const PEN_COLORS = ["ink", "#ff5c5c", "#ff9f43", "#f7d046", "#4cd964", "#4da3ff", "#b36bff"];
const PEN_SIZES = [2, 4, 8];

type Status = { kind: "saved" | "saving" } | { kind: "error"; msg: string };
type ThemePref = "auto" | "light" | "dark";

const EMPTY_SET = new Set<string>();
const NO_SELECTION: string[] = [];

function store<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable; these are conveniences only */
  }
}

function normalizeBoard(raw: Partial<Board>, path: string): Board {
  return {
    ...raw,
    schemaVersion: raw.schemaVersion ?? 1,
    id: raw.id ?? newId(),
    name: raw.name ?? basename(path).replace(/\.mb$/, ""),
    assetRoot: raw.assetRoot ?? "./assets",
    viewport: raw.viewport ?? { x: 0, y: 0, zoom: 1 },
    items: Array.isArray(raw.items) ? raw.items : [],
  };
}

export default function App() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const docRef = useRef<Doc | null>(null);
  docRef.current = doc;
  const [docKey, setDocKey] = useState(0);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [scanned, setScanned] = useState(false);
  const [rootMissing, setRootMissing] = useState(false);
  const [selection, setSelection] = useState<string[]>(NO_SELECTION);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [tool, setTool] = useState<Tool>("select");
  const [pen, setPen] = useState<Pen>({ color: "ink", size: 4 });
  const [sidebar, setSidebar] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: "saved" });
  const [notice, setNotice] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => store<string[]>(RECENT_KEY, []));
  const canvas = useRef<CanvasApi | null>(null);

  // ---- theme ---------------------------------------------------------------------------------
  const [themePref, setThemePref] = useState<ThemePref>(() => store<ThemePref>(THEME_KEY, "auto"));
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const f = () => setSystemDark(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  const theme: ThemeName = themePref === "auto" ? (systemDark ? "dark" : "light") : themePref;
  // layout effect: the CSS variables must be in place before the canvas (a passive effect) reads them
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const cycleTheme = () => {
    const next: ThemePref = themePref === "auto" ? "light" : themePref === "light" ? "dark" : "auto";
    setThemePref(next);
    remember(THEME_KEY, next);
  };

  // ---- autosave ------------------------------------------------------------------------------
  const dirty = useRef<"none" | "view" | "content">("none");
  const [rev, setRev] = useState(0);

  const touch = useCallback((quiet = false) => {
    if (!quiet) dirty.current = "content";
    else if (dirty.current === "none") dirty.current = "view";
    setRev((r) => r + 1);
    setStatus({ kind: "saving" });
  }, []);

  const saveNow = useCallback(async () => {
    const d = docRef.current;
    if (!d || dirty.current === "none") return;
    dirty.current = "none";
    try {
      await saveBoard(d.path, d.board);
      if (dirty.current === "none") setStatus({ kind: "saved" });
    } catch (e) {
      dirty.current = "content";
      setStatus({ kind: "error", msg: String(e) });
    }
  }, []);

  useEffect(() => {
    if (dirty.current === "none") return;
    const t = setTimeout(saveNow, dirty.current === "content" ? SAVE_DELAY : VIEW_SAVE_DELAY);
    return () => clearTimeout(t);
  }, [rev, saveNow]);

  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async () => {
      await saveNow();
    });
    return () => void un.then((f) => f());
  }, [saveNow]);

  // ---- items + undo/redo ---------------------------------------------------------------------
  const undoStack = useRef<Item[][]>([]);
  const redoStack = useRef<Item[][]>([]);

  /** Replace the board's items. `history: false` is used by undo/redo themselves. */
  const setItems = useCallback(
    (items: Item[], history = true) => {
      const d = docRef.current;
      if (!d || items === d.board.items) return;
      if (history) {
        undoStack.current.push(d.board.items);
        if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
        redoStack.current = [];
      }
      const next = { ...d, board: { ...d.board, items } };
      docRef.current = next; // synchronous, so back-to-back commits build on each other
      setDoc(next);
      touch();
    },
    [touch],
  );

  const swapHistory = useCallback(
    (from: Item[][], to: Item[][]) => {
      const d = docRef.current;
      const target = from.pop();
      if (!d || !target) return;
      to.push(d.board.items);
      setItems(target, false);
      const ids = new Set(target.map((i) => i.id));
      setSelection((s) => s.filter((id) => ids.has(id)));
    },
    [setItems],
  );
  const undo = useCallback(() => swapHistory(undoStack.current, redoStack.current), [swapHistory]);
  const redo = useCallback(() => swapHistory(redoStack.current, undoStack.current), [swapHistory]);

  const mutate = useCallback(
    (fn: (b: Board) => Board, quiet = false) => {
      const d = docRef.current;
      if (!d) return;
      const next = { ...d, board: fn(d.board) };
      docRef.current = next;
      setDoc(next);
      touch(quiet);
    },
    [touch],
  );
  const onViewport = useCallback((viewport: Viewport) => mutate((b) => ({ ...b, viewport }), true), [mutate]);

  // ---- opening / creating boards -------------------------------------------------------------
  const rescan = useCallback(async (root: string) => {
    setScanned(false);
    try {
      setEntries(await scanDir(root));
      setRootMissing(false);
    } catch {
      setEntries([]);
      setRootMissing(true);
    }
    setScanned(true);
  }, []);

  const show = useCallback(
    (next: Doc) => {
      dirty.current = "none";
      undoStack.current = [];
      redoStack.current = [];
      docRef.current = next;
      setDoc(next);
      setDocKey((k) => k + 1);
      setSelection(NO_SELECTION);
      setStatus({ kind: "saved" });
      const list = [next.path, ...store<string[]>(RECENT_KEY, []).filter((p) => p !== next.path)].slice(0, 8);
      remember(RECENT_KEY, list);
      setRecent(list);
      void rescan(next.rootAbs);
    },
    [rescan],
  );

  const openPath = useCallback(
    async (path: string) => {
      await saveNow();
      try {
        const { json, rootAbs } = await loadBoard(path);
        show({ path, board: normalizeBoard(JSON.parse(json), path), rootAbs });
      } catch (e) {
        const list = store<string[]>(RECENT_KEY, []).filter((p) => p !== path);
        remember(RECENT_KEY, list);
        setRecent(list);
        setNotice(`Couldn't open ${basename(path)}: ${e}`);
      }
    },
    [saveNow, show],
  );

  const openDialog = useCallback(async () => {
    const p = await pickBoardToOpen();
    if (p) await openPath(p);
  }, [openPath]);

  const newBoard = useCallback(async () => {
    const path = await pickBoardToCreate();
    if (!path) return;
    const dir = dirname(path);
    const folder = await pickFolder(dir);
    await saveNow();
    try {
      const board = normalizeBoard({ assetRoot: folder ? await setRoot(path, folder) : "./assets" }, path);
      await saveBoard(path, board);
      show({ path, board, rootAbs: folder ?? `${dir}/assets` });
    } catch (e) {
      setNotice(`Couldn't create board: ${e}`);
    }
  }, [saveNow, show]);

  const changeFolder = useCallback(async () => {
    const d = docRef.current;
    if (!d) return;
    const folder = await pickFolder(d.rootAbs);
    if (!folder) return;
    const assetRoot = await setRoot(d.path, folder);
    const next = { ...d, rootAbs: folder, board: { ...d.board, assetRoot } };
    docRef.current = next;
    setDoc(next);
    touch();
    void rescan(folder);
  }, [rescan, touch]);

  useEffect(() => {
    void takePendingOpen().then((p) => {
      if (p) void openPath(p);
    });
    const un = listen<string>("open-file", (e) => void openPath(e.payload));
    return () => void un.then((f) => f());
  }, [openPath]);

  useEffect(() => {
    if (doc) void getCurrentWindow().setTitle(`${doc.board.name} — Moodboard`);
  }, [doc?.board.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- derived scene info --------------------------------------------------------------------
  const sizes = useMemo(() => new Map(entries.map((e) => [e.path.normalize("NFC"), e.size])), [entries]);
  const items = doc?.board.items;
  const missing = useMemo(() => {
    if (!scanned || !items) return EMPTY_SET;
    const m = new Set<string>();
    for (const i of items) if (i.type === "media" && !sizes.has(i.path.normalize("NFC"))) m.add(i.id);
    return m.size ? m : EMPTY_SET;
  }, [scanned, items, sizes]);

  // ---- board actions -------------------------------------------------------------------------
  const addMedia = useCallback(
    async (path: string, at?: { x: number; y: number }) => {
      const d = docRef.current;
      const api = canvas.current;
      if (!d || !api) return;
      const kind = kindOf(path);
      let w = 400, h = 300;
      if (kind === "image") {
        const t = await getThumb(d.rootAbs, path, 256);
        if (t) ({ w, h } = t);
        else ({ w, h } = await probe(assetUrl(d.rootAbs, path), kind));
      } else {
        ({ w, h } = await probe(assetUrl(d.rootAbs, path), kind));
      }
      // ~420 world units, but never smaller than 120px or larger than 700px on screen
      const z = api.ctl.viewport.zoom;
      const target = Math.min(700 / z, Math.max(120 / z, START_SIZE));
      const s = target / Math.max(w, h);
      const width = Math.max(1, Math.round(w * s));
      const height = Math.max(1, Math.round(h * s));
      const c = at ?? api.ctl.viewCenter();
      const cur = docRef.current!.board.items;
      const id = newId();
      setItems([...cur, { id, type: "media", path, x: Math.round(c.x - width / 2), y: Math.round(c.y - height / 2), width, height, rotation: 0, zIndex: topZ(cur) }]);
      setSelection([id]);
    },
    [setItems],
  );

  const removeSelected = useCallback(() => {
    const d = docRef.current;
    const sel = new Set(selectionRef.current);
    if (!d || !sel.size) return;
    setItems(d.board.items.filter((i) => !sel.has(i.id)));
    setSelection(NO_SELECTION);
  }, [setItems]);

  const reorder = useCallback(
    (toFront: boolean) => {
      const api = canvas.current;
      if (api && selectionRef.current.length) setItems(api.ctl.zOrder(selectionRef.current, toFront));
    },
    [setItems],
  );

  const selectedTexts = useMemo(
    () => (doc ? doc.board.items.filter((i): i is TextItem => i.type === "text" && selection.includes(i.id)) : []),
    [doc, selection],
  );
  const setFontSize = useCallback(
    (size: number) => {
      const d = docRef.current;
      if (!d) return;
      const fs = Math.max(4, Math.min(800, Math.round(size)));
      const ids = new Set(selectionRef.current);
      setItems(d.board.items.map((i) => (i.type === "text" && ids.has(i.id) ? { ...i, fontSize: fs, height: textHeight(i.text, fs, i.width) } : i)));
    },
    [setItems],
  );

  // ---- relinking -----------------------------------------------------------------------------
  const missingSelected = useMemo(
    () => (doc ? doc.board.items.filter((i) => i.type === "media" && missing.has(i.id) && selection.includes(i.id)) : []),
    [doc, missing, selection],
  );

  /** Apply `path` swaps to missing items and report how many were fixed. */
  const applyRelinks = useCallback(
    (changes: Map<string, string>, label: string) => {
      const d = docRef.current;
      if (!d) return;
      if (!changes.size) return setNotice(`${label}: nothing could be matched.`);
      setItems(d.board.items.map((i) => (i.type === "media" && changes.has(i.id) ? { ...i, path: changes.get(i.id)! } : i)));
      setNotice(`${label}: relinked ${changes.size} ${changes.size === 1 ? "item" : "items"}.`);
    },
    [setItems],
  );

  const relinkSelected = useCallback(async () => {
    const d = docRef.current;
    const target = missingSelected[0];
    if (!d || !target || target.type !== "media") return;
    const f = await pickMediaFile(d.rootAbs);
    if (!f) return;
    const rootN = d.rootAbs.normalize("NFC") + "/";
    const fileN = f.normalize("NFC");
    if (!fileN.startsWith(rootN)) return setNotice("Pick a file inside the asset folder, or change the asset folder first (folder button, top left).");
    const newPath = fileN.slice(rootN.length);
    const changes = new Map<string, string>([[target.id, newPath]]);
    // Same folder move? Infer the old→new prefix and fix the other missing items that follow it.
    const oldParts = target.path.normalize("NFC").split("/");
    const newParts = newPath.split("/");
    let k = 0;
    while (k < oldParts.length && k < newParts.length && oldParts[oldParts.length - 1 - k] === newParts[newParts.length - 1 - k]) k++;
    const oldPre = oldParts.slice(0, oldParts.length - k).join("/");
    const newPre = newParts.slice(0, newParts.length - k).join("/");
    if (k > 0 && oldPre !== newPre) {
      for (const i of d.board.items) {
        if (i.type !== "media" || i.id === target.id || !missing.has(i.id)) continue;
        const p = i.path.normalize("NFC");
        const rest = oldPre === "" ? p : p.startsWith(oldPre + "/") ? p.slice(oldPre.length + 1) : null;
        if (rest === null) continue;
        const cand = newPre === "" ? rest : `${newPre}/${rest}`;
        if (sizes.has(cand)) changes.set(i.id, cand);
      }
    }
    applyRelinks(changes, "Relink");
  }, [missingSelected, missing, sizes, applyRelinks]);

  /** Match each missing item to a file of the same name anywhere in the folder (when unambiguous). */
  const relinkByName = useCallback(() => {
    const d = docRef.current;
    if (!d) return;
    const byName = new Map<string, string[]>();
    for (const e of entries) {
      const k = basename(e.path).normalize("NFC").toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), e.path.normalize("NFC")]);
    }
    const changes = new Map<string, string>();
    for (const i of d.board.items) {
      if (i.type !== "media" || !missing.has(i.id)) continue;
      const hits = byName.get(basename(i.path).normalize("NFC").toLowerCase());
      if (hits?.length === 1) changes.set(i.id, hits[0]);
    }
    applyRelinks(changes, "Find by name");
  }, [entries, missing, applyRelinks]);

  // ---- keyboard ------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const api = canvas.current;
      if (mod && k === "o") return e.preventDefault(), void openDialog();
      if (mod && k === "n") return e.preventDefault(), void newBoard();
      if (mod && k === "s") return e.preventDefault(), void saveNow();
      if (!docRef.current) return;
      if (mod && k === "z") return e.preventDefault(), e.shiftKey ? redo() : undo();
      if (mod && k === "y") return e.preventDefault(), redo();
      if (mod && k === "a") return e.preventDefault(), setSelection(docRef.current.board.items.map((i) => i.id));
      if (e.key === "Delete" || e.key === "Backspace") return e.preventDefault(), removeSelected();
      if (e.key === "Escape") return tool !== "select" ? setTool("select") : setSelection(NO_SELECTION);
      if (e.key === "Tab") return e.preventDefault(), setSidebar((s) => !s);
      if (mod && e.key === "]") return e.preventDefault(), reorder(true);
      if (mod && e.key === "[") return e.preventDefault(), reorder(false);
      if (mod && e.key === "0") return e.preventDefault(), api?.ctl.zoomTo(1);
      if (e.shiftKey && e.code === "Digit1") return e.preventDefault(), api?.ctl.fit();
      if (mod || e.altKey) return;
      if (k === "v") return setTool("select");
      if (k === "p") return setTool("pen");
      if (k === "e") return setTool("eraser");
      if (k === "t") return e.preventDefault(), setTool("select"), api?.ctl.createText();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog, newBoard, saveNow, undo, redo, removeSelected, reorder, tool]);

  // ---- self-test (MB_SELFTEST=<board.mb>) ------------------------------------------------------
  useEffect(() => {
    void runSelfTest((p) => openPath(p), () => canvas.current);
  }, [openPath]);

  // ---- render --------------------------------------------------------------------------------
  const noticeEl = notice && <div className="notice" onClick={() => setNotice(null)}>{notice}</div>;

  if (!doc) {
    return (
      <div className="start">
        <h1>Moodboard</h1>
        <div className="row">
          <button className="primary" onClick={newBoard}>New board</button>
          <button onClick={openDialog}>Open board…</button>
        </div>
        {recent.length > 0 && (
          <div className="recent">
            <h2>Recent</h2>
            {recent.map((p) => (
              <button key={p} onClick={() => openPath(p)} title={p}>
                <strong>{basename(p).replace(/\.mb$/, "")}</strong>
                <span>{dirname(p)}</span>
              </button>
            ))}
          </div>
        )}
        {noticeEl}
      </div>
    );
  }

  const { board } = doc;
  const themeLabel = themePref === "auto" ? "Auto" : themePref === "light" ? "Light" : "Dark";
  return (
    <div className="app">
      <header className="topbar">
        <button onClick={() => setSidebar((s) => !s)} title="Toggle browser (Tab)">☰</button>
        <input className="name" value={board.name} onChange={(e) => mutate((b) => ({ ...b, name: e.target.value }))} spellCheck={false} />
        <span className={`status ${status.kind}`} title={status.kind === "error" ? status.msg : undefined}>
          {status.kind === "saved" ? "Saved" : status.kind === "saving" ? "Saving…" : "Couldn't save"}
        </span>

        <div className="seg" role="group" aria-label="Tool">
          <button className={tool === "select" ? "on" : ""} onClick={() => setTool("select")} title="Select (V)">Select</button>
          <button className={tool === "pen" ? "on" : ""} onClick={() => setTool("pen")} title="Draw (P)">Pen</button>
          <button className={tool === "eraser" ? "on" : ""} onClick={() => setTool("eraser")} title="Erase strokes (E)">Eraser</button>
        </div>
        {tool === "pen" && (
          <div className="pen-opts">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${pen.color === c ? "on" : ""} ${c === "ink" ? "ink" : ""}`}
                style={c === "ink" ? undefined : { background: c }}
                onClick={() => setPen({ ...pen, color: c })}
                title={c === "ink" ? "Ink (follows theme)" : c}
              />
            ))}
            {PEN_SIZES.map((s) => (
              <button key={s} className={`dot ${pen.size === s ? "on" : ""}`} onClick={() => setPen({ ...pen, size: s })} title={`${s}px`}>
                <i style={{ width: s + 2, height: s + 2 }} />
              </button>
            ))}
          </div>
        )}

        {selectedTexts.length > 0 && (
          <div className="font-size" title="Text size">
            <button onClick={() => setFontSize(selectedTexts[0].fontSize - 2)}>A−</button>
            <input
              key={selectedTexts.map((t) => t.fontSize).join()}
              type="number"
              defaultValue={selectedTexts[0].fontSize}
              onBlur={(e) => setFontSize(Number(e.target.value) || selectedTexts[0].fontSize)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <button onClick={() => setFontSize(selectedTexts[0].fontSize + 2)}>A+</button>
          </div>
        )}
        {missingSelected.length > 0 && <button onClick={() => void relinkSelected()}>Relink…</button>}
        {missing.size > 0 && (
          <button className="warn" onClick={relinkByName} title="Look for files with the same name elsewhere in the folder">
            {missing.size} missing · Find
          </button>
        )}

        <span className="spacer" />
        <button onClick={undo} disabled={!undoStack.current.length} title="Undo (⌘Z)">↶</button>
        <button onClick={redo} disabled={!redoStack.current.length} title="Redo (⇧⌘Z)">↷</button>
        <button onClick={() => { setTool("select"); canvas.current?.ctl.createText(); }} title="Add text (T)">Text</button>
        <button onClick={() => canvas.current?.ctl.fit()} title="Fit to content (Shift+1)">Fit</button>
        <button onClick={() => canvas.current?.ctl.zoomTo(1)} title="Reset to 100% (⌘0)">{Math.round(board.viewport.zoom * 100)}%</button>
        <button onClick={cycleTheme} title="Theme: Auto / Light / Dark">{themeLabel}</button>
        <button onClick={() => void openDialog()} title="Open another board (⌘O)">Open</button>
      </header>
      <div className="main">
        {sidebar && (
          <Browser
            entries={entries}
            scanned={scanned}
            rootAbs={doc.rootAbs}
            rootMissing={rootMissing}
            onAdd={(p) => void addMedia(p)}
            onRefresh={() => void rescan(doc.rootAbs)}
            onChangeFolder={() => void changeFolder()}
          />
        )}
        <CanvasHost
          apiRef={canvas}
          docKey={docKey}
          viewport={board.viewport}
          items={board.items}
          selection={selection}
          tool={tool}
          pen={pen}
          theme={theme}
          rootAbs={doc.rootAbs}
          sizes={sizes}
          missing={missing}
          onCommit={setItems}
          onViewport={onViewport}
          onSelect={setSelection}
          onDropAsset={(p, x, y) => void addMedia(p, { x, y })}
        />
      </div>
      {noticeEl}
    </div>
  );
}
