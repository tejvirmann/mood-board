use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
const VIDEO_EXT: &[&str] = &["mp4", "mov", "m4v", "webm"];
const BACKUP_MIN_AGE: Duration = Duration::from_secs(30);

#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

#[derive(Serialize)]
struct Entry {
    path: String,
    kind: &'static str,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Thumb {
    /// Absolute path to a file the webview can load (the cached thumbnail, or the source if it is already small).
    path: String,
    /// Source dimensions after EXIF orientation.
    w: u32,
    h: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedBoard {
    json: String,
    root_abs: String,
}

/// Lexically resolve `.` and `..` so paths compare and display cleanly.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn board_dir(board_path: &str) -> Result<PathBuf, String> {
    Path::new(board_path)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "board path has no parent folder".to_string())
}

fn resolve_root(board_path: &str, asset_root: &str) -> Result<PathBuf, String> {
    let root = Path::new(asset_root);
    if root.is_absolute() {
        Ok(normalize(root))
    } else {
        Ok(normalize(&board_dir(board_path)?.join(root)))
    }
}

/// Grant the webview's asset protocol read access to this folder only.
fn allow_dir(app: &AppHandle, dir: &Path) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|e| e.to_string())
}

/// Read a board file, resolve its asset root, and allow the webview to read that root.
#[tauri::command]
fn load_board(app: AppHandle, board_path: String) -> Result<LoadedBoard, String> {
    let json = fs::read_to_string(&board_path).map_err(|e| format!("{board_path}: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("not a valid board file: {e}"))?;
    let asset_root = value.get("assetRoot").and_then(|v| v.as_str()).unwrap_or("./assets");
    let root = resolve_root(&board_path, asset_root)?;
    if root.is_dir() {
        allow_dir(&app, &root)?;
    }
    Ok(LoadedBoard { json, root_abs: root.to_string_lossy().into_owned() })
}

/// Store the asset root relative to the board file when it is nearby, absolute otherwise.
#[tauri::command]
fn set_root(app: AppHandle, board_path: String, root_abs: String) -> Result<String, String> {
    let root = PathBuf::from(&root_abs);
    allow_dir(&app, &root)?;
    let dir = board_dir(&board_path)?;
    let stored = match pathdiff::diff_paths(&root, &dir) {
        Some(rel) if rel.components().filter(|c| matches!(c, Component::ParentDir)).count() <= 2 => {
            let rel = rel.to_string_lossy().into_owned();
            if rel.is_empty() {
                ".".to_string()
            } else if rel.starts_with("..") {
                rel
            } else {
                format!("./{rel}")
            }
        }
        _ => root_abs,
    };
    Ok(stored)
}

/// Recursively list supported media. Paths are relative to `root`, use `/`, and are NFC-normalized.
#[tauri::command]
fn scan_dir(root: String) -> Result<Vec<Entry>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut out = Vec::new();
    for e in WalkDir::new(&root).follow_links(false).into_iter().filter_entry(|e| {
        // skip hidden files/folders (.DS_Store, our own cache, etc.)
        e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.')
    }) {
        let Ok(e) = e else { continue };
        if !e.file_type().is_file() {
            continue;
        }
        let ext = e.path().extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        let kind = if IMAGE_EXT.contains(&ext.as_str()) {
            "image"
        } else if VIDEO_EXT.contains(&ext.as_str()) {
            "video"
        } else {
            continue;
        };
        let Ok(rel) = e.path().strip_prefix(&root) else { continue };
        let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(Entry { path: rel.nfc().collect(), kind, size });
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(out)
}

/// Atomic save: write a temp file, fsync, rename over the original.
/// Keeps a `.bak` of the previous contents, refreshed at most every 30s.
#[tauri::command]
fn save_board(board_path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(&board_path);
    let tmp = path.with_extension("mb.tmp");
    let bak = path.with_extension("mb.bak");

    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);

    if path.exists() {
        let stale = fs::metadata(&bak)
            .and_then(|m| m.modified())
            .map(|t| SystemTime::now().duration_since(t).unwrap_or_default() > BACKUP_MIN_AGE)
            .unwrap_or(true);
        if stale {
            let _ = fs::copy(&path, &bak);
        }
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn fnv1a(s: &str) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn make_thumb(cache: &Path, source: &str, size: u32) -> Result<Thumb, String> {
    use image::{ImageDecoder, ImageReader};
    let meta = fs::metadata(source).map_err(|e| e.to_string())?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);

    let reader = ImageReader::open(source).and_then(|r| r.with_guessed_format()).map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let (mut w, mut h) = decoder.dimensions();
    if matches!(orientation, image::metadata::Orientation::Rotate90 | image::metadata::Orientation::Rotate270 | image::metadata::Orientation::Rotate90FlipH | image::metadata::Orientation::Rotate270FlipH) {
        std::mem::swap(&mut w, &mut h);
    }
    if w.max(h) <= size {
        return Ok(Thumb { path: source.to_string(), w, h });
    }

    let has_alpha = decoder.color_type().has_alpha();
    let ext = if has_alpha { "png" } else { "jpg" };
    let key = fnv1a(&format!("{source}|{}|{mtime}|{size}", meta.len()));
    let out = cache.join(format!("{key:016x}.{ext}"));
    if out.exists() {
        return Ok(Thumb { path: out.to_string_lossy().into_owned(), w, h });
    }

    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    let thumb = img.thumbnail(size, size);

    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let tmp = cache.join(format!("{key:016x}.{:?}.tmp", std::thread::current().id()));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        if has_alpha {
            thumb.write_to(&mut f, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        } else {
            let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 85);
            thumb.to_rgb8().write_with_encoder(enc).map_err(|e| e.to_string())?;
        }
    }
    fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(Thumb { path: out.to_string_lossy().into_owned(), w, h })
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GifAtlas {
    /// Absolute path of a PNG sprite sheet holding every frame in a grid.
    path: String,
    cols: u32,
    frame_w: u32,
    frame_h: u32,
    /// Per-frame display time in milliseconds.
    delays: Vec<u32>,
}

/// Decode an animated GIF once, off the UI thread, into one sprite-sheet PNG (a single GPU texture).
/// Frames are scaled down so the sheet stays under `max_pixels`.
fn make_gif_atlas(cache: &Path, source: &str, max_pixels: u64) -> Result<GifAtlas, String> {
    use image::{codecs::gif::GifDecoder, imageops, AnimationDecoder, RgbaImage};
    let meta = fs::metadata(source).map_err(|e| e.to_string())?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    let key = fnv1a(&format!("{source}|{}|{mtime}|gif|{max_pixels}", meta.len()));
    let png = cache.join(format!("{key:016x}.gif.png"));
    let sidecar = cache.join(format!("{key:016x}.gif.json"));
    if png.exists() {
        if let Ok(j) = fs::read_to_string(&sidecar) {
            if let Ok(a) = serde_json::from_str::<GifAtlas>(&j) {
                return Ok(GifAtlas { path: png.to_string_lossy().into_owned(), ..a });
            }
        }
    }

    let file = std::io::BufReader::new(fs::File::open(source).map_err(|e| e.to_string())?);
    let frames = GifDecoder::new(file).map_err(|e| e.to_string())?.into_frames().collect_frames().map_err(|e| e.to_string())?;
    let n = frames.len() as u32;
    if n == 0 {
        return Err("empty gif".into());
    }
    let (w, h) = frames[0].buffer().dimensions();
    let total = w as u64 * h as u64 * n as u64;
    let scale = if total > max_pixels { (max_pixels as f64 / total as f64).sqrt() } else { 1.0 };
    let fw = ((w as f64 * scale) as u32).max(1);
    let fh = ((h as f64 * scale) as u32).max(1);
    let cols = ((n as f64 * fh as f64 / fw as f64).sqrt().ceil() as u32).clamp(1, n);
    let rows = n.div_ceil(cols);
    if cols * fw > 8192 || rows * fh > 8192 {
        return Err("gif too large for an atlas".into());
    }

    let mut atlas = RgbaImage::new(cols * fw, rows * fh);
    let mut delays = Vec::with_capacity(n as usize);
    for (i, f) in frames.into_iter().enumerate() {
        let (num, den) = f.delay().numer_denom_ms();
        let ms = if den == 0 { 100 } else { num / den };
        delays.push(if ms < 20 { 100 } else { ms }); // browsers treat tiny delays as 100ms
        let buf = f.into_buffer();
        let buf = if scale < 1.0 { imageops::resize(&buf, fw, fh, imageops::FilterType::Triangle) } else { buf };
        imageops::replace(&mut atlas, &buf, ((i as u32 % cols) * fw) as i64, ((i as u32 / cols) * fh) as i64);
    }

    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let tmp = cache.join(format!("{key:016x}.{:?}.tmp", std::thread::current().id()));
    atlas.save_with_format(&tmp, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &png).map_err(|e| e.to_string())?;
    let out = GifAtlas { path: png.to_string_lossy().into_owned(), cols, frame_w: fw, frame_h: fh, delays };
    let _ = fs::write(&sidecar, serde_json::to_string(&out).unwrap_or_default());
    Ok(out)
}

#[tauri::command]
async fn gif_atlas(app: AppHandle, source: String, max_pixels: u64) -> Result<GifAtlas, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    tauri::async_runtime::spawn_blocking(move || make_gif_atlas(&cache, &source, max_pixels))
        .await
        .map_err(|e| e.to_string())?
}

/// Cached thumbnail (longest side <= `size`) in the app cache dir; never touches the user's folders.
#[tauri::command]
async fn thumbnail(app: AppHandle, source: String, size: u32) -> Result<Thumb, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    tauri::async_runtime::spawn_blocking(move || make_thumb(&cache, &source, size))
        .await
        .map_err(|e| e.to_string())?
}

/// Frontend diagnostics go to stderr (used by the self-test benchmark).
#[tauri::command]
fn log_line(msg: String) {
    eprintln!("[ui] {msg}");
}

/// Set MB_SELFTEST=/path/to/board.mb to run the scripted benchmark on launch.
#[tauri::command]
fn selftest_arg() -> Option<String> {
    std::env::var("MB_SELFTEST").ok()
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// A board path handed to us by Finder (or argv) before the UI was ready.
#[tauri::command]
fn take_pending_open(state: State<PendingOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

fn handle_open(app: &AppHandle, path: String) {
    *app.state::<PendingOpen>().0.lock().unwrap() = Some(path.clone());
    let _ = app.emit("open-file", path);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpen::default())
        .setup(|app| {
            if let Ok(cache) = app.path().app_cache_dir() {
                let thumbs = cache.join("thumbs");
                let _ = fs::create_dir_all(&thumbs);
                allow_dir(app.handle(), &thumbs)?;
            }
            // Useful for dev and non-macOS: `moodboard path/to/world.mb`
            if let Some(arg) = std::env::args().skip(1).find(|a| a.ends_with(".mb")) {
                *app.state::<PendingOpen>().0.lock().unwrap() = Some(arg);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![load_board, set_root, scan_dir, save_board, take_pending_open, thumbnail, gif_atlas, log_line, selftest_arg, quit])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // Finder double-click / "Open With" on macOS arrives as an Opened event.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                handle_open(_app, path.to_string_lossy().into_owned());
            }
        }
    });
}
