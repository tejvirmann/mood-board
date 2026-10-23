import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Board, Entry, MediaKind } from "./types";

export const loadBoard = (boardPath: string) =>
  invoke<{ json: string; rootAbs: string }>("load_board", { boardPath });

export const setRoot = (boardPath: string, rootAbs: string) =>
  invoke<string>("set_root", { boardPath, rootAbs });

export const logLine = (msg: string) => invoke<void>("log_line", { msg }).catch(() => {});
export const selftestArg = () => invoke<string | null>("selftest_arg");
export const quit = () => invoke<void>("quit");

export const pickMediaFile = async (defaultPath: string) => {
  const p = await open({
    multiple: false,
    defaultPath,
    filters: [{ name: "Images and video", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "mp4", "mov", "m4v", "webm"] }],
  });
  return typeof p === "string" ? p : null;
};

export const scanDir = (root: string) => invoke<Entry[]>("scan_dir", { root });

export const saveBoard = (boardPath: string, board: Board) =>
  invoke<void>("save_board", { boardPath, contents: JSON.stringify(board, null, 2) });

export const takePendingOpen = () => invoke<string | null>("take_pending_open");

export const pickBoardToOpen = async () => {
  const p = await open({ multiple: false, filters: [{ name: "Moodboard", extensions: ["mb"] }] });
  return typeof p === "string" ? p : null;
};

export const pickBoardToCreate = async () => {
  const p = await save({ title: "New board", defaultPath: "Untitled.mb", filters: [{ name: "Moodboard", extensions: ["mb"] }] });
  if (!p) return null;
  return p.endsWith(".mb") ? p : `${p}.mb`;
};

export const pickFolder = async (defaultPath?: string) => {
  const p = await open({ directory: true, multiple: false, title: "Choose the folder with your images", defaultPath });
  return typeof p === "string" ? p : null;
};

export const fileUrl = (abs: string) => convertFileSrc(abs);
export const assetUrl = (rootAbs: string, path: string) => fileUrl(`${rootAbs}/${path}`);

const VIDEO_EXT = ["mp4", "mov", "m4v", "webm"];
export const kindOf = (path: string): MediaKind =>
  VIDEO_EXT.includes(path.split(".").pop()?.toLowerCase() ?? "") ? "video" : "image";

export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Natural size of a media file; falls back to 4:3 if it cannot be read. */
export function probe(url: string, kind: MediaKind): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const fallback = () => resolve({ w: 400, h: 300 });
    if (kind === "image") {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
      img.onerror = fallback;
      img.src = url;
    } else {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ w: v.videoWidth || 400, h: v.videoHeight || 300 });
      v.onerror = fallback;
      v.src = url;
    }
  });
}
