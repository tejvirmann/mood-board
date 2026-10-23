# Local-First Anime Moodboard — Product Brief for an AI Coding Agent

## 1. Product concept

Build a lightweight, local-first visual workspace for developing the visual universe of an anime.

The app should feel like a combination of **PureRef, a visual file browser, and a minimal Figma-style infinite canvas**. Instead of opening images, GIFs, and videos one at a time in Finder, the user points the app at an existing folder and explores that media on a canvas.

The user can place assets freely, move and resize them, layer them, and add text notes. Saving should preserve the board layout—not duplicate the underlying media.

**Core principle:** the media files remain where they already live. The board is a lightweight description of how to display and arrange them.

## 2. Primary use case

I am developing an anime and want to build a visual reference universe over time. I may have folders of:

- Character designs and expressions
- Anime screenshots and animation references
- Animated GIFs and short video clips
- Landscapes, architecture, interiors, and city references
- Clothing, props, weapons, vehicles, and other objects
- Color palettes, textures, lighting, and atmosphere references
- Inspiration images and visual research
- Text notes about characters, locations, themes, and worldbuilding

I want to put related material together visually, compare references, overlap them, and annotate them with ideas. I might have separate boards for the overall world, individual characters, locations, visual style, or a specific scene.

## 3. Product goals

1. **Local-first and private:** all core features work without an internet connection. No account, cloud service, analytics, or required network access.
2. **Folder-based:** choose an existing directory containing assets. Browse its contents visually without manually importing or duplicating everything.
3. **Freeform canvas:** arrange media and text spatially, rather than being forced into a grid or document layout.
4. **Lightweight saves:** persist only the board's structure and references to the source files.
5. **Fast visual browsing:** show useful thumbnails/previews so Finder's file-by-file workflow is unnecessary.
6. **Durable project files:** board data should be understandable, portable, and easy to back up.
7. **Simple before sophisticated:** prioritize a responsive, polished canvas over advanced collaboration, AI, or project-management features.

## 4. Core workflow

1. Launch the app.
2. Create a board or open an existing board file.
3. Choose an existing media folder as the board's asset source.
4. Browse a thumbnail/contact-sheet-style view of files in that folder and its subfolders.
5. Drag assets from the browser onto the canvas.
6. Move, resize, overlap, and arrange assets.
7. Add text boxes for labels, thoughts, questions, scene ideas, and worldbuilding notes.
8. Save the board.
9. Reopen it later with the same positions, sizes, notes, zoom, and arrangement.

The app should make it easy to add more media to the source folder later and refresh/rescan the folder without losing the existing board layout.

## 5. Functional requirements

### 5.1 Local folder and asset browser

- Let the user choose a root folder through a native folder picker.
- Scan the folder recursively, with an option to include or exclude subfolders.
- Show a visual browser of supported files, preferably with thumbnails.
- Provide filename search and basic filters by file type.
- Support common image formats such as PNG, JPEG, WebP, GIF, and HEIC where the platform/runtime permits.
- Support common video formats such as MP4 and MOV where the platform/runtime permits.
- Animated GIFs should remain animated when viewed on the board.
- Videos should have a useful preview and a simple play/pause control.
- Display a filename or path on demand, without permanently cluttering every card.
- Rescanning the source folder should discover new files and notice missing files.
- Do not move, rename, modify, or delete source assets as part of normal board editing.
- Make it clear when an asset is missing or its path can no longer be resolved.

### 5.2 Canvas

- Infinite or very large pannable canvas.
- Smooth zoom in/out, with a “fit board/content” action and a way to return to 100%.
- Drag assets from the folder browser onto the canvas.
- Select an item and drag it to reposition it.
- Resize items using visible handles.
- Preserve aspect ratio by default; allow an intentional crop or alternate fit mode only if easy to implement.
- Support multi-select and moving multiple selected items together if practical.
- Basic undo/redo for canvas edits.
- Keyboard shortcuts for save, undo/redo, delete-from-board, zoom, and fit-to-view.
- Provide a clear selection outline and sensible hover states.
- Avoid heavy UI chrome: the canvas and references should dominate the screen.

### 5.3 Text boxes and notes

- Add text boxes anywhere on the canvas.
- Edit text in place or through a simple editor.
- Resize text boxes; text should wrap within the box.
- Support basic formatting if straightforward: font size, bold, text color, background color, and alignment.
- Notes are board objects, not separate files unless the user explicitly exports them.
- Useful examples: “Character silhouette,” “late-afternoon lighting,” “old city district,” or a paragraph about a scene's mood.

### 5.4 Position, size, and layers

Every canvas item should store at least:

- A stable item ID
- Asset reference or text content
- X and Y position
- Width and height
- Rotation, if straightforward
- Z-order / stacking order

Support bring-to-front and send-to-back actions. A dedicated complex layer panel is not required for the first version; basic stacking order is enough.

### 5.5 Boards and projects

- Support multiple boards.
- Each board can reference a chosen source folder.
- Board names should be editable.
- Reopening a board restores its saved view and layout.
- It should be possible to keep separate boards for characters, locations, mood, props, and scenes.
- Keep board files separate from the source media by default.

## 6. Persistence and file format

The saved board should be small. **Do not embed or copy the media into the board file by default.**

Use a human-readable JSON format (or another similarly portable format) containing:

- Board metadata: ID, name, schema version, and source folder path
- Canvas/view state: zoom and viewport position
- Item list
- For media items: stable item ID, relative path from the source folder when possible, x/y, width/height, rotation, and z-order
- For text items: text, geometry, styling, and z-order

Prefer relative paths when the board and assets have a stable folder relationship. If the chosen source folder is elsewhere, store a path strategy that can be resolved robustly. Explain the trade-offs and handle missing assets gracefully.

Example conceptual schema (adapt as needed):

```json
{
  "schemaVersion": 1,
  "name": "Anime — World Moodboard",
  "assetRoot": "../reference-assets",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "items": [
    {
      "id": "asset-001",
      "type": "media",
      "path": "locations/old-town.png",
      "x": 120,
      "y": 180,
      "width": 420,
      "height": 280,
      "rotation": 0,
      "zIndex": 1
    },
    {
      "id": "note-001",
      "type": "text",
      "text": "The old district should feel beautiful but slightly abandoned.",
      "x": 600,
      "y": 190,
      "width": 300,
      "height": 150,
      "fontSize": 18,
      "zIndex": 2
    }
  ]
}
```

This is an illustrative schema, not a mandate. Ensure the actual implementation handles spaces and Unicode in paths, and documents what happens if files move.

### Missing files and folder changes

- If an asset is moved or renamed, show a missing-file placeholder instead of crashing.
- Provide a simple “relink asset” action if practical.
- Rescanning a folder must not reset or reorder board objects.
- Never silently rewrite or delete the user's source files.

### Thumbnails and performance

- Generate/cache thumbnails locally if needed, but keep the cache separate from board structure.
- Avoid loading every full-resolution image or decoding every video at once.
- Virtualize the asset browser and canvas rendering if needed for large folders.
- Keep the board file small even when it references hundreds of assets.
- Be careful with large GIFs and video files; load/play them on demand.

## 7. Suggested UI layout

A simple desktop layout:

- **Left sidebar:** board list and asset-folder browser.
- **Main area:** pannable/zoomable canvas.
- **Optional inspector:** selected item's path, dimensions, and basic properties.
- **Top bar:** board name, source folder, save status, undo/redo, zoom and fit controls.

The folder browser should be collapsible to maximize canvas space. Prefer drag-and-drop over complicated import dialogs.

## 8. Non-goals for the first version

Do not build these unless the core experience is already solid:

- Cloud storage, accounts, collaboration, or remote sync
- AI image generation or AI tagging
- A full image editor
- Complex layer hierarchies or animation timelines
- A full project-management/wiki system
- Asset duplication or automatic reorganization of the user's folders
- Mandatory export or conversion of original files
- A complicated database-backed library

The app is a visual arrangement layer on top of the user's own media collection.

## 9. Implementation guidance

First inspect the existing repository and its conventions before choosing a stack. If starting from scratch, prioritize a native-feeling macOS desktop app or a local desktop shell that can reliably access arbitrary local folders.

Potential approaches include:

- **Tauri + a web UI:** lightweight desktop shell, with explicit filesystem permissions and native folder selection.
- **Electron + a web UI:** familiar ecosystem and broad media-preview support, at the cost of a heavier app.
- **Native macOS implementation:** strongest platform integration, but potentially more implementation effort.

Choose a canvas/rendering library only after verifying that it supports smooth pan/zoom, selection, resizing, z-order, and media elements. Do not assume a normal HTML page with absolutely positioned elements will remain responsive for large boards.

Keep file access explicit and local. No external API calls are needed for the core product.

## 10. Acceptance criteria

The first version is successful when:

1. I can choose an existing folder on my Mac and see its images in a visual browser.
2. I can drag an image from that browser onto a canvas.
3. I can move and resize the image freely.
4. I can place two images so they overlap and control which is in front.
5. I can add, edit, move, and resize a text box.
6. GIFs animate on the board, and supported videos can be previewed.
7. Saving creates a small board file that stores paths and layout rather than media contents.
8. Closing and reopening the app restores the board's item positions, sizes, stacking order, text, and viewport.
9. Adding a new file to the source folder and rescanning makes it available without disturbing the board.
10. A missing source asset is reported gracefully.
11. The app can perform the core workflow fully offline.
12. Normal board operations never alter the original media files.

## 11. Recommended development order

### Milestone 1 — Usable canvas
- Open a folder.
- Display image thumbnails.
- Drag images onto canvas.
- Pan, zoom, move, resize, and reorder.
- Add text boxes.
- Save and reopen JSON board files.

### Milestone 2 — Mixed media and reliability
- Animated GIF previews.
- Video previews.
- Folder rescan and missing-file handling.
- Undo/redo.
- Multiple boards.
- Better keyboard shortcuts and selection behavior.

### Milestone 3 — Quality of life
- Search and type filters.
- Multi-select and group movement.
- Crop/fit options.
- Local thumbnail cache and performance tuning.
- Export a board snapshot to PNG/PDF, if useful.

## 12. Product philosophy

This should feel like **opening a folder of ideas and spreading them across a desk**.

It should not force the user to upload, import, tag, or reorganize everything before starting. The canvas is the creative workspace; the folder remains the source of truth for the media; the board file remembers the composition.

Optimize for speed, simplicity, local ownership, and the feeling of freely building a visual world.
