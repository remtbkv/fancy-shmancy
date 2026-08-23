#!/usr/bin/env python3
"""Measure our own home screenshot the same way the reference was measured, and
print the two side by side.

The browser can report box geometry, but not where the ink actually lands — and
the reference numbers in MEASUREMENTS.md are ink measurements. So this reads the
PNG.

Native (2x) coordinates throughout; halve for CSS.
"""

import glob
import sys

from PIL import Image

REF = glob.glob(
    "/Users/remtbkv/handy-review/ui-survey/official/wispr-flow/Screenshot*1.36.58*.png"
)[0]
OURS = "/Users/remtbkv/handy-review/ui-port/home-light.png"


def luma(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def ink_bands(px, x0, x1, y0, y1, thresh=150):
    out, prev, start = [], False, None
    for y in range(y0, y1):
        dark = any(luma(px[x, y]) < thresh for x in range(x0, x1))
        if dark and not prev:
            start = y
        elif prev and not dark:
            out.append((start, y - 1))
        prev = dark
    if prev:
        out.append((start, y1 - 1))
    return out


def hairlines(px, x0, x1, y0, y1, min_run):
    found = []
    for y in range(y0, y1):
        run = sum(
            1
            for x in range(x0, x1, 4)
            if 228 < luma(px[x, y]) < 248 and abs(px[x, y][0] - px[x, y][2]) < 16
        )
        if run > min_run:
            found.append(y)
    return found


def collapse(ys):
    """1..2px thick lines -> one y each."""
    out = []
    for y in ys:
        if not out or y - out[-1][-1] > 3:
            out.append([y])
        else:
            out[-1].append(y)
    return [group[0] for group in out]


def measure(path, card_left, eyebrow_window, row_window, x_probe):
    px = Image.open(path).convert("RGB").load()
    eyebrow = ink_bands(px, x_probe[0], x_probe[1], *eyebrow_window)
    lines = collapse(hairlines(px, x_probe[0], x_probe[1] + 1400, *row_window, 300))
    # first ink column in the eyebrow band = the left content edge
    left = next(
        (
            x
            for x in range(card_left, card_left + 200)
            if any(luma(px[x, y]) < 150 for y in range(*eyebrow_window))
        ),
        None,
    )
    # timestamp vs text column on the row under the first divider
    row_top = lines[0] if lines else row_window[0]
    cols = [
        x
        for x in range(card_left, card_left + 1400)
        if any(luma(px[x, y]) < 150 for y in range(row_top + 20, row_top + 70))
    ]
    clusters = []
    if cols:
        start = prev = cols[0]
        for x in cols[1:]:
            if x - prev > 30:
                clusters.append((start, prev))
                start = x
            prev = x
        clusters.append((start, prev))
    return {
        "eyebrow ink": eyebrow[0] if eyebrow else None,
        "content left inset": (left - card_left) if left else None,
        "dividers": lines[:5],
        "row pitch": (lines[1] - lines[0]) if len(lines) > 1 else None,
        "eyebrow ink bottom -> first divider": (
            lines[0] - eyebrow[0][1] if eyebrow and lines else None
        ),
        "timestamp -> text column": (
            clusters[1][0] - clusters[0][0] if len(clusters) > 1 else None
        ),
    }


def main():
    ref = measure(
        REF,
        card_left=596,
        eyebrow_window=(820, 960),
        row_window=(900, 1400),
        x_probe=(676, 900),
    )
    # Ours: the card starts at the sidebar edge (216) + nothing, and the list
    # begins below the header row rather than below a promo banner, so the
    # windows differ; the numbers being compared do not.
    ours = measure(
        OURS,
        card_left=432,
        eyebrow_window=(300, 420),
        row_window=(330, 900),
        x_probe=(512, 800),
    )
    width = max(len(k) for k in ref)
    print(f"{'':{width}}  {'reference':>28}  {'ours':>28}")
    for key in ref:
        print(f"{key:{width}}  {str(ref[key]):>28}  {str(ours.get(key)):>28}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
