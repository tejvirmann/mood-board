import { useEffect, useRef, type MutableRefObject } from "react";
import { BoardController } from "./board/controller";
import { BoardRenderer } from "./board/renderer";
import { readPalette, type ThemeName } from "./board/theme";
import type { Item, Pen, Tool, Viewport } from "./types";

export interface CanvasApi {
  ctl: BoardController;
  renderer: BoardRenderer;
}

interface Props {
  apiRef: MutableRefObject<CanvasApi | null>;
  /** Bumps whenever a different board is shown; the viewport is (re)loaded then. */
  docKey: number;
  viewport: Viewport;
  items: Item[];
  selection: string[];
  tool: Tool;
  pen: Pen;
  theme: ThemeName;
  rootAbs: string;
  sizes: Map<string, number>;
  missing: Set<string>;
  onCommit: (items: Item[]) => void;
  onViewport: (vp: Viewport) => void;
  onSelect: (ids: string[]) => void;
  onDropAsset: (path: string, wx: number, wy: number) => void;
}

/** Thin React shell around the imperative WebGL scene + interaction controller. */
export default function CanvasHost(props: Props) {
  const div = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const api = useRef<CanvasApi | null>(null);

  const push = () => {
    const a = api.current;
    if (!a) return;
    const p = latest.current;
    a.renderer.setScene(p.rootAbs, p.sizes, p.missing);
    a.ctl.setProps({ items: p.items, selection: p.selection, tool: p.tool, pen: p.pen });
  };

  useEffect(() => {
    let dead = false;
    const r = new BoardRenderer();
    let ctl: BoardController | null = null;
    void r.init(div.current!, readPalette(latest.current.theme)).then(() => {
      if (dead) return;
      ctl = new BoardController(div.current!, r, {
        onCommit: (i) => latest.current.onCommit(i),
        onViewport: (v) => latest.current.onViewport(v),
        onSelect: (ids) => latest.current.onSelect(ids),
        onDropAsset: (p, x, y) => latest.current.onDropAsset(p, x, y),
      });
      api.current = { ctl, renderer: r };
      props.apiRef.current = api.current;
      ctl.loadViewport(latest.current.viewport);
      push();
    });
    return () => {
      dead = true;
      ctl?.destroy();
      r.destroy();
      api.current = null;
      props.apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(push, [props.items, props.selection, props.tool, props.pen, props.rootAbs, props.sizes, props.missing]);

  useEffect(() => {
    api.current?.ctl.loadViewport(latest.current.viewport);
  }, [props.docKey]);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.renderer.setPalette(readPalette(props.theme));
    a.ctl.refresh();
  }, [props.theme]);

  return <div ref={div} className="canvas" />;
}
