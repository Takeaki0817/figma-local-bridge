#!/usr/bin/env python3
"""Compare a Figma frame export with the browser screenshot of the same screen.

Usage: python3 -I scripts/visual-diff.py <reference.png> <figma.png> <side-by-side.png> [--scale 0.5]
Prints JSON: sizes, share of pixels that differ noticeably, and the worst horizontal bands.
"""
import json
import sys

from PIL import Image, ImageChops

ref_path, fig_path, out_path = sys.argv[1:4]
scale = float(sys.argv[sys.argv.index("--scale") + 1]) if "--scale" in sys.argv else 0.5

ref = Image.open(ref_path).convert("RGB")
fig = Image.open(fig_path).convert("RGB")
w = max(ref.width, fig.width)
h = max(ref.height, fig.height)
canvas_ref = Image.new("RGB", (w, h), (255, 0, 255))
canvas_fig = Image.new("RGB", (w, h), (255, 0, 255))
canvas_ref.paste(ref, (0, 0))
canvas_fig.paste(fig, (0, 0))

diff = ImageChops.difference(canvas_ref, canvas_fig).convert("L")
mask = diff.point(lambda v: 255 if v > 40 else 0)
hist = mask.histogram()
changed = hist[255]
total = w * h

band = 40
bands = []
for top in range(0, h, band):
    box = (0, top, w, min(h, top + band))
    region = mask.crop(box)
    c = region.histogram()[255]
    if c:
        bands.append({"y": top, "share": round(c / (w * (box[3] - top)), 4)})
bands.sort(key=lambda b: -b["share"])

# side by side: reference | figma | difference (red)
red = Image.new("RGB", (w, h), (255, 255, 255))
red.paste((220, 0, 0), mask=mask)
side = Image.new("RGB", (w * 3 + 40, h), (240, 240, 240))
side.paste(canvas_ref, (0, 0))
side.paste(canvas_fig, (w + 20, 0))
side.paste(red, (2 * w + 40, 0))
if scale != 1:
    side = side.resize((int(side.width * scale), int(side.height * scale)), Image.LANCZOS)
side.save(out_path)

print(json.dumps({
    "reference": [ref.width, ref.height],
    "figma": [fig.width, fig.height],
    "changedShare": round(changed / total, 4),
    "worstBands": bands[:6],
}))
