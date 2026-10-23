# mood-board

A local-first infinite-canvas moodboard for anime reference art. Boards are small `.mb` JSON files that point at images, GIFs and videos where they already live; nothing is copied or modified. Edits autosave.

See [plan.md](plan.md) for the roadmap and [local_first_anime_moodboard_spec.md](local_first_anime_moodboard_spec.md) for the product brief.

## Run

Requires Node and Rust (`brew install rust`).

```sh
npm install
npm run tauri dev
```

Build an installable app (this is what registers double-click-to-open for `.mb` files):

```sh
npm run tauri build -- --bundles app   # output: src-tauri/target/release/bundle/macos/Moodboard.app
```

Copy `Moodboard.app` to `/Applications`, then double-clicking any `.mb` file opens it. In dev you can also pass a board on the command line: `src-tauri/target/debug/moodboard path/to/world.mb`.

## Use

| Action            | How                                                |
| ----------------- | -------------------------------------------------- |
| New / open board  | ⌘N / ⌘O                                          |
| Add media         | Drag from the left browser, or double-click a tile |
| Pan / zoom        | Scroll or drag empty space / pinch or ⌘+scroll    |
| Fit / 100%        | Shift+1 / ⌘0                                      |
| Resize            | Corner handles (Shift = free aspect)               |
| Text              | `T`, double-click to edit                        |
| Z-order           | ⌘] front, ⌘[ back                                |
| Delete from board | Delete                                             |
| Toggle browser    | Tab                                                |

Videos show native play/pause, scrub and volume controls when selected; drag them by the bar above the video.

Similar idea (reference only, not copied): [kanvaz](https://github.com/p4inz-code/kanvaz)
