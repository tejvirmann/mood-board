#!/usr/bin/env python3
"""Pull `[ui] PNG <label> data:image/png;base64,…` lines out of a self-test log and write <label>.png files.

    MB_SELFTEST=bench.mb src-tauri/target/release/moodboard 2> run.log
    python3 scripts/extract-snaps.py run.log outdir
"""
import base64, os, re, sys

log, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for line in open(log, errors="replace"):
    m = re.match(r"\[ui\] PNG (\S+) data:image/png;base64,(.*)", line.strip())
    if m:
        path = os.path.join(out, m.group(1) + ".png")
        open(path, "wb").write(base64.b64decode(m.group(2)))
        print("wrote", path)
