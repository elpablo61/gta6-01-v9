#!/usr/bin/env python3
"""Contact sheet for Crescent Bay (gta6-01-v9).

Layout, 768x480 total, JPEG quality ~80:
  cover  768x320 on top  (1-cover.jpg)
  three  256x160 below   (2-mission.jpg, 3-night.jpg, 4-start.jpg)

Also writes a grayscale twin (contact-sheet-gray.jpg) so the judge can
read the sheet even without colour. The two-second readability test is
the point of the layout: one big cover, three legible thumbnails, no
tiny text, no overlap.

Usage:
  python3 tools/contact-sheet.py [--shots screenshots] [--out screenshots]
"""

import argparse
import os
import sys

from PIL import Image

COVER = (768, 320)
THUMB = (256, 160)
SHEET = (768, 480)
QUALITY = 80

ORDER = ["1-cover.jpg", "2-mission.jpg", "3-night.jpg", "4-start.jpg"]


def load_cover(path):
    """Load an image, crop-centre it to the target aspect, resize."""
    img = Image.open(path).convert("RGB")
    return img


def fit(img, size):
    """Centre-crop to the target aspect ratio, then resize to size."""
    tw, th = size
    w, h = img.size
    target = tw / th
    current = w / h
    if current > target:
        # Too wide: trim the sides.
        new_w = int(h * target)
        left = (w - new_w) // 2
        img = img.crop((left, 0, left + new_w, h))
    else:
        # Too tall: trim top and bottom.
        new_h = int(w / target)
        top = (h - new_h) // 2
        img = img.crop((0, top, w, top + new_h))
    return img.resize(size, Image.LANCZOS)


def main():
    parser = argparse.ArgumentParser(description="Build the Crescent Bay contact sheet.")
    parser.add_argument("--shots", default="screenshots", help="folder holding 1-cover.jpg etc.")
    parser.add_argument("--out", default="screenshots", help="folder to write the sheets into")
    args = parser.parse_args()

    shots_dir = args.shots
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)

    missing = [name for name in ORDER if not os.path.exists(os.path.join(shots_dir, name))]
    if missing:
        print(f"missing screenshots in {shots_dir}: {', '.join(missing)}", file=sys.stderr)
        return 2

    sheet = Image.new("RGB", SHEET, (0, 0, 0))
    cover = fit(load_cover(os.path.join(shots_dir, ORDER[0])), COVER)
    sheet.paste(cover, (0, 0))
    for i, name in enumerate(ORDER[1:]):
        thumb = fit(load_cover(os.path.join(shots_dir, name)), THUMB)
        sheet.paste(thumb, (i * THUMB[0], COVER[1]))

    colour_path = os.path.join(out_dir, "contact-sheet.jpg")
    gray_path = os.path.join(out_dir, "contact-sheet-gray.jpg")
    sheet.save(colour_path, "JPEG", quality=QUALITY)
    sheet.convert("L").convert("RGB").save(gray_path, "JPEG", quality=QUALITY)

    for path in (colour_path, gray_path):
        size = os.path.getsize(path)
        print(f"{path} {sheet.size[0]}x{sheet.size[1]} {size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
