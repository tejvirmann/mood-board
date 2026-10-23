#!/usr/bin/env python3
"""Generate a synthetic benchmark board: many large images, a few GIFs/videos, notes and pen strokes.

    python3 scripts/make-bench.py /tmp/mb-bench [count]
    MB_SELFTEST=/tmp/mb-bench/bench.mb src-tauri/target/release/moodboard

Needs ffmpeg. Images are copies of a dozen generated sources, so decode cost is real but disk use is modest.
"""
import json, math, os, random, shutil, subprocess, sys

out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/mb-bench"
count = int(sys.argv[2]) if len(sys.argv) > 2 else 400
assets = os.path.join(out, "assets")
shutil.rmtree(out, ignore_errors=True)
os.makedirs(assets)

def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)

# (lavfi source, w, h)
sources = [
    ("testsrc2", 4000, 2500), ("mandelbrot", 3000, 2000), ("gradients", 5000, 3000), ("life", 2400, 3200),
    ("cellauto", 3200, 2400), ("smptebars", 4096, 2304), ("rgbtestsrc", 3000, 3000), ("testsrc", 6000, 4000),
    ("sierpinski", 2000, 3000), ("yuvtestsrc", 3840, 2160), ("mandelbrot", 1600, 900), ("testsrc2", 800, 600),
]
base = []
for n, (src, w, h) in enumerate(sources):
    f = os.path.join(out, f"base{n}.jpg")
    ff("-f", "lavfi", "-i", f"{src}=size={w}x{h}", "-frames:v", "1", "-q:v", "3", f)
    base.append((f, w, h))

random.seed(7)
folders = ["characters", "locations/city", "locations/forest", "props", "palettes", "screens/ep01", "screens/ep02"]
items, z = [], 0
cols = int(math.sqrt(count * 1.6))
cell = 520
for i in range(count):
    f, w, h = base[i % len(base)]
    folder = folders[i % len(folders)]
    os.makedirs(os.path.join(assets, folder), exist_ok=True)
    rel = f"{folder}/img_{i:04d}.jpg"
    shutil.copy(f, os.path.join(assets, rel))
    width = random.choice([260, 320, 400, 480])
    height = round(width * h / w)
    z += 1
    items.append({"id": f"m{i}", "type": "media", "path": rel, "x": (i % cols) * cell + random.randint(0, 40),
                  "y": (i // cols) * cell + random.randint(0, 40), "width": width, "height": height, "rotation": 0, "zIndex": z})

# animated GIFs + videos
os.makedirs(os.path.join(assets, "motion"))
ff("-f", "lavfi", "-i", "testsrc2=size=480x270:rate=15", "-t", "3", os.path.join(assets, "motion/a.gif"))
ff("-f", "lavfi", "-i", "mandelbrot=size=320x240:rate=12", "-t", "3", os.path.join(assets, "motion/b.gif"))
ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "4", "-pix_fmt", "yuv420p", os.path.join(assets, "motion/c.mp4"))
for k, (rel, w, h) in enumerate([("motion/a.gif", 480, 270), ("motion/b.gif", 320, 240), ("motion/c.mp4", 1280, 720)]):
    z += 1
    items.append({"id": f"v{k}", "type": "media", "path": rel, "x": k * 600, "y": -400, "width": 480, "height": round(480 * h / w), "rotation": 0, "zIndex": z})

# notes
for k in range(25):
    z += 1
    items.append({"id": f"t{k}", "type": "text", "text": f"Note {k}: the old district should feel beautiful but slightly abandoned.",
                  "fontSize": 20, "x": (k % cols) * cell, "y": (k // cols) * cell - 80, "width": 320, "height": 90, "rotation": 0, "zIndex": z})

# pen strokes (wobbly lines)
for k in range(40):
    z += 1
    pts, x, y = [], 0.0, 0.0
    for s in range(60):
        pts += [round(x, 1), round(y, 1)]
        x += random.uniform(2, 12); y += random.uniform(-8, 8)
    w, h = max(1, max(pts[0::2])), max(1, max(abs(v) for v in pts[1::2]) * 2)
    pts[1::2] = [round(v + h / 2, 1) for v in pts[1::2]]
    items.append({"id": f"s{k}", "type": "stroke", "x": random.randint(0, cols * cell), "y": random.randint(0, (count // cols) * cell),
                  "width": w, "height": h, "bw": w, "bh": h, "points": pts, "color": random.choice(["ink", "#ff5c5c", "#4da3ff"]),
                  "size": 4, "rotation": 0, "zIndex": z})

board = {"schemaVersion": 1, "id": "bench", "name": "Bench", "assetRoot": "./assets", "viewport": {"x": 0, "y": 0, "zoom": 0.1}, "items": items}
with open(os.path.join(out, "bench.mb"), "w") as fh:
    json.dump(board, fh)
print(f"wrote {out}/bench.mb with {len(items)} items")
