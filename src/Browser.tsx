import { memo, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, basename, fileUrl } from "./api";
import { getThumb, peekThumb } from "./board/thumbs";
import type { Entry } from "./types";

interface Props {
  entries: Entry[];
  scanned: boolean;
  rootAbs: string;
  rootMissing: boolean;
  onAdd: (path: string) => void;
  onRefresh: () => void;
  onChangeFolder: () => void;
}

type Filter = "all" | "image" | "video";
type Row =
  | { kind: "head"; key: string; label: string; count: number; top: number; h: number }
  | { kind: "tiles"; key: string; items: Entry[]; top: number; h: number };

const COLS = 3;
const GAP = 6;
const PAD = 8;
const HEAD_H = 30;
const OVERSCAN = 400;
const THUMB = 256;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export default function Browser({ entries, scanned, rootAbs, rootMissing, onAdd, onRefresh, onChangeFolder }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [box, setBox] = useState({ w: 280, h: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => (filter === "all" || e.kind === filter) && (!q || e.path.toLowerCase().includes(q)));
  }, [entries, query, filter]);

  const tile = Math.max(40, (box.w - PAD * 2 - GAP * (COLS - 1)) / COLS);

  // One flat list of rows (folder headers + rows of tiles) so only what's on screen is ever mounted.
  const { rows, total } = useMemo(() => {
    const rows: Row[] = [];
    let top = PAD;
    let i = 0;
    while (i < shown.length) {
      const dir = dirOf(shown[i].path);
      let j = i;
      while (j < shown.length && dirOf(shown[j].path) === dir) j++;
      rows.push({ kind: "head", key: `h:${dir}`, label: dir || basename(rootAbs) || "Top level", count: j - i, top, h: HEAD_H });
      top += HEAD_H;
      for (let k = i; k < j; k += COLS) {
        const h = tile + GAP;
        rows.push({ kind: "tiles", key: `t:${shown[k].path}`, items: shown.slice(k, Math.min(k + COLS, j)), top, h });
        top += h;
      }
      i = j;
    }
    return { rows, total: top + PAD };
  }, [shown, tile, rootAbs]);

  const visible = rows.filter((r) => r.top + r.h > scrollTop - OVERSCAN && r.top < scrollTop + box.h + OVERSCAN);
  const folders = new Set(shown.map((e) => dirOf(e.path))).size;

  return (
    <aside className="browser">
      <div className="browser-head">
        <button className="folder" onClick={onChangeFolder} title={`${rootAbs}\nClick to change folder`}>
          {basename(rootAbs) || rootAbs}
        </button>
        <button onClick={onRefresh} title="Rescan folder">↻</button>
      </div>
      <div className="browser-tools">
        <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">All</option>
          <option value="image">Images</option>
          <option value="video">Video</option>
        </select>
      </div>
      {rootMissing ? (
        <div className="empty">
          Folder not found.
          <button onClick={onChangeFolder}>Choose folder</button>
        </div>
      ) : (
        <>
          <div className="count">
            {scanned ? `${shown.length}${shown.length !== entries.length ? ` of ${entries.length}` : ""} files · ${folders} ${folders === 1 ? "folder" : "folders"}` : "Scanning…"}
          </div>
          <div className="scroller" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <div style={{ height: total, position: "relative" }}>
              {visible.map((r) =>
                r.kind === "head" ? (
                  <div key={r.key} className="folder-head" style={{ top: r.top, height: r.h }}>
                    <span>{r.label}</span>
                    <em>{r.count}</em>
                  </div>
                ) : (
                  <div key={r.key} className="tile-row" style={{ top: r.top, height: tile, gridTemplateColumns: `repeat(${COLS}, ${tile}px)` }}>
                    {r.items.map((e) => (
                      <Tile key={e.path} entry={e} rootAbs={rootAbs} onAdd={onAdd} />
                    ))}
                  </div>
                ),
              )}
            </div>
            {scanned && entries.length === 0 && <div className="empty">No images or videos in this folder.</div>}
          </div>
        </>
      )}
    </aside>
  );
}

const Tile = memo(function Tile({ entry, rootAbs, onAdd }: { entry: Entry; rootAbs: string; onAdd: (p: string) => void }) {
  const initial = entry.kind === "image" ? peekThumb(rootAbs, entry.path, THUMB) : undefined;
  const [src, setSrc] = useState<string | null>(initial ? fileUrl(initial.path) : null);

  useEffect(() => {
    if (entry.kind !== "image") return;
    let live = true;
    void getThumb(rootAbs, entry.path, THUMB).then((t) => live && setSrc(t ? fileUrl(t.path) : assetUrl(rootAbs, entry.path)));
    return () => {
      live = false;
    };
  }, [entry, rootAbs]);

  return (
    <div
      className={`tile ${entry.kind}`}
      title={entry.path}
      draggable
      onDragStart={(ev) => {
        ev.dataTransfer.setData("application/x-mb-asset", entry.path);
        ev.dataTransfer.effectAllowed = "copy";
      }}
      onDoubleClick={() => onAdd(entry.path)}
    >
      {entry.kind === "image" ? src && <img src={src} decoding="async" draggable={false} /> : <span className="vid">▶</span>}
      <span className="name">{basename(entry.path)}</span>
    </div>
  );
});
