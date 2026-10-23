# Plan — Local-First Anime Moodboard

Companion to [local_first_anime_moodboard_spec.md](local_first_anime_moodboard_spec.md). The spec is the full product brief; this file is what we are actually building, in what order, and the decisions that shape it. Where they disagree, this plan wins.

## 1. What we're building

A small, fast macOS desktop app: an infinite Figma-style canvas where you arrange images, GIFs, videos and text notes that live in your existing folders. A board is a tiny file that remembers the layout. **Double-click a board file in Finder and the app opens that board.** Everything autosaves. Source media is never copied, moved or modified.

Inspiration only: [kanvaz](https://github.com/p4inz-code/kanvaz) is a similar idea. We do not copy its code or structure.

## 2. Folder layout (one folder per anime)

```
Anime/
  Project Name/
    world.mb          <- board file, double-click to open
    characters.mb     <- as many boards as you want per anime
    locations.mb
    assets/                  <- your existing images, any subfolder depth
      characters/
      locations/
      ...
    .cache/           <- app-owned cache (thumbnails); safe to delete
```

- A board's `assetRoot` defaults to `./assets` **relative to the board file**, so you can move or back up the whole anime folder and every board still works.
- A board can point elsewhere (another folder, another drive). Stored as relative when possible, else absolute, with a relink fallback.
- "New Anime" action scaffolds this structure, or you can open a board against any existing folder.

## 3. Opening a board by double-click

This is feasible and standard, not a hack.

- Define a custom file type: extension `.mb` (plain JSON inside), with its own icon and a registered UTI.
- Register it as a document type in the macOS app bundle (`CFBundleDocumentTypes` / `UTExportedTypeDeclarations`). Tauri exposes this through `bundle.fileAssociations` in `tauri.conf.json`.
- macOS delivers the file to the app as an "open document" event: cold start (app not running) and warm (already running → opens in a new tab/window or switches to it). In Tauri this arrives as `RunEvent::Opened`.
- One caveat: the association only exists once the app is **built and installed** (copied to `/Applications`). During development we use fallbacks, which we want anyway:
  - File → Open… (Cmd+O)
  - Drag a `.mb` file onto the app window or Dock icon
  - Recent boards list on the start screen
- If we later decide the custom extension is a problem, fallback is `.json` plus an "Open with" choice. Not planned.

## 4. Autosave

- Save is never a user action. Every edit marks the board dirty; a debounced write (~500 ms after the last change, plus on blur/quit) persists it.
- **Atomic writes**: write to `world.mb.tmp`, fsync, rename over the original. A crash can never leave a half-written board.
- Keep one rolling backup (`world.mb.bak`) of the last good state, plus a few timestamped snapshots on a slow interval, so a bad edit is recoverable.
- Viewport (pan/zoom) is saved too, but with a longer debounce so panning does not thrash the disk.
- Subtle status in the top bar: "Saved" / "Saving…" / "Couldn't save" (the last one is loud).
- Undo/redo is in-memory history and independent of saving. Cmd+Z works across autosaves.
- If the file changes on disk while open (e.g., iCloud/Dropbox sync), detect it and offer reload instead of overwriting.

## 5. File format

Human-readable JSON, versioned, small even with hundreds of items. Based on the spec's example schema.

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "name": "World",
  "assetRoot": "./assets",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "items": [
    { "id": "…", "type": "media", "path": "locations/old-town.png",
      "x": 120, "y": 180, "width": 420, "height": 280, "rotation": 0, "zIndex": 1 },
    { "id": "…", "type": "text", "text": "Beautiful but slightly abandoned.",
      "x": 600, "y": 190, "width": 300, "height": 150, "fontSize": 18, "zIndex": 2 }
  ]
}
```

Rules: forward-compatible (unknown fields preserved on save), `schemaVersion` migrations, paths stored with `/` and NFC-normalized (macOS gives NFD filenames), spaces and Unicode must work, missing files render a placeholder and never crash.

## 6. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Small, fast, native file associations, explicit filesystem scope, no Electron weight |
| UI | **React + TypeScript + Vite** | Fast iteration, easy to mock up |
| Canvas | **PixiJS (WebGL)** for rendering, own selection/transform layer | DOM with hundreds of large images gets janky; we need smooth pan/zoom. See spike below |
| State | Zustand (or similar) with an operation-based undo stack | Simple, testable |
| Thumbnails | Rust side, `image` crate, cached in `.cache/` | Never decode full-res just to browse |
| Video/GIF | Native `<video>` / `<img>` overlay for the on-screen items, thumbnails otherwise | Animate on demand only |

**Spike first (before committing):** build a throwaway canvas with ~300 mixed images and compare (a) PixiJS, (b) Konva, (c) plain DOM with CSS transforms, on pan/zoom smoothness and drag/resize feel. Pick the winner on measured results. tldraw is an alternative worth evaluating, but check its license terms for a desktop app before using it.

Local file access: use Tauri's `asset:` protocol scoped to the chosen folders only. No network permissions in the capability config.

## 7. UI (minimal, canvas-first)

- Canvas fills the window. Light chrome, dark neutral canvas, single accent colour.
- **Left panel (collapsible, Tab to toggle):** folder browser, thumbnail grid, filename search, type filter. Drag from here onto the board.
- **Top bar:** board name (editable), saved status, zoom %, fit-to-content.
- **Inspector (hidden unless something is selected):** position, size, lock aspect, z-order, path, "Reveal in Finder", "Relink".
- Start screen: recent boards, New Anime, Open board.
- Figma-like controls: Space+drag / middle-drag / two-finger scroll to pan, pinch or Cmd+scroll to zoom, Shift+1 fit, Cmd+0 100%, handles to resize (aspect locked by default, Shift to free), Cmd+[ / ] for z-order, T for text, Delete to remove from board.

**Mockups:** before building UI, make 3 screens as static HTML/Figma mockups (start screen, board with browser open, board with item selected) and agree on them.

## 8. Milestones

**M0 — Spike + mockups (1–2 days)**
- Canvas library comparison with 300 images
- Static mockups for the three screens
- Prove double-click-to-open with a trivial Tauri app and a dummy `.mb` file (de-risks the scariest unknown first)

**M1 — Usable core**
- Tauri app scaffold, `.mb` file association, open via double-click / Cmd+O / drag
- New Anime scaffold; choose asset folder
- Recursive scan + thumbnail browser (images)
- Drag onto canvas; pan, zoom, move, resize, z-order
- Text boxes
- **Autosave with atomic writes**, reopen restores everything

**M2 — Reliable**
- GIF animation, video preview with play/pause
- Rescan, missing-file placeholders, relink
- Undo/redo, multi-select and group move
- Multiple boards per anime, recent list, backup/snapshots
- External-change detection

**M3 — Polish**
- Search/filters, crop/fit modes, rotation
- Thumbnail cache tuning, large-board performance pass
- Export board to PNG/PDF
- App icon, `.mb` document icon, signed + notarized build

## 9. Out of scope (for now)

Cloud sync, accounts, collaboration, AI features, image editing, tagging/database library, asset copying or reorganizing. Same non-goals as the spec.

## 10. Acceptance (condensed from spec §10)

1. Double-clicking a `.mb` file in Finder opens that board
2. Edits autosave; force-quitting mid-edit loses at most ~1 second of work and never corrupts the file
3. Images, GIFs and videos from the folder appear in a visual browser and can be dragged onto an infinite canvas
4. Move, resize, overlap, reorder, and text notes all work, with 60 fps pan/zoom on a board of several hundred items
5. Board file is small JSON with relative paths; moving the whole anime folder keeps boards working
6. Missing files show a placeholder, not a crash; source files are never modified
7. Fully offline

## 11. Decisions made

- **Extension:** `.mb`.
- **Asset location:** `assets/` next to the board by default; a shared library elsewhere is optional and supported (stored relative if within two levels up, absolute otherwise).
- **Video (v1):** play/pause, scrubbing and volume via the native video controls, shown when a video is selected. No custom player.

## 12. Still open

1. One window per board or tabs? Barebones build is one window; opening another board replaces the current one.
2. HEIC / PSD / other formats you actually use? These need extra decoding work.
3. Windows/Linux someday? Tauri keeps that open; the plan targets macOS only.

## 13. Status

**Done:** Tauri 2 + React/TypeScript shell; PixiJS (WebGL) canvas with render-on-demand, viewport culling and tiered level-of-detail textures (256 / 1024 / 2560 / original) under a 512 MB LRU budget; disk-cached thumbnails in the app cache dir (never in your folders); GIFs decoded in Rust to one sprite sheet; video poster frames + native controls when selected; virtualized asset browser grouped by subfolder; multi-select (marquee, shift-click, group move/delete/order); undo/redo; relink (pick a file, plus automatic prefix and by-name matching); pen and eraser; resizable text (corner = scale, side = reflow, A-/A+ field); light/dark/auto theme; `.mb` file association; autosave.

**Drawing design:** a stroke is an ordinary board item (`type: "stroke"`, points relative to its box, colour, width in world units), so it moves, resizes, layers, undoes and autosaves like everything else. Eraser deletes whole strokes. Not yet: pressure/tablet width, eraser that trims partway through a stroke, shapes/arrows.

**Measured (468 items, 400 large JPEGs, release build, 980x727 @2x):** pan 60 fps, no frame over 20 ms; zoom sweep with level-of-detail swaps mostly 60 fps, worst frames ~50-115 ms (GPU texture uploads); idle = 0 frames rendered. Re-run: `python3 scripts/make-bench.py /tmp/mb-bench && MB_SELFTEST=/tmp/mb-bench/bench.mb src-tauri/target/release/moodboard` (also runs 18 scripted interaction checks).

**Next:** mipmaps / smaller upload slices to remove the remaining zoom hitches, rotation UI, snapshots, external-change detection, tabs vs windows, UI mockup pass (browser panel readability).
