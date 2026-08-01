"""Colour-independent shape comparison of the tray icons.

Binarises each icon into an ink mask (glyph pixels vs tile pixels) by distance
from the tile's dominant colour, then compares masks BETWEEN states. Colour
differences cancel out, so any remaining difference is shape.

This is the check that caught the original defect: active vs paused differed by
exactly 0 pixels at every size.
"""
import os
from PIL import Image

ASSETS = r"C:\Users\Admin\Documents\tracey\ui\assets"
STATES = ("active", "paused", "off")
SIZES = (16, 24, 32, 48)


def ink_mask(path):
    im = Image.open(path).convert("RGBA")
    px = list(im.getdata())
    opaque = [p for p in px if p[3] > 200]
    if not opaque:
        return None, 0
    # Dominant opaque colour is the tile; everything far from it is glyph ink.
    counts = {}
    for p in opaque:
        k = (p[0] // 16, p[1] // 16, p[2] // 16)
        counts[k] = counts.get(k, 0) + 1
    domk = max(counts, key=counts.get)
    dom = (domk[0] * 16 + 8, domk[1] * 16 + 8, domk[2] * 16 + 8)
    mask = []
    for p in px:
        if p[3] < 128:
            mask.append(0)
            continue
        d = abs(p[0] - dom[0]) + abs(p[1] - dom[1]) + abs(p[2] - dom[2])
        mask.append(1 if d > 90 else 0)
    return mask, im.size[0]


print("pairwise ink-mask differences (0 = identical SHAPE, colour ignored)\n")
worst_pair = None
for size in SIZES:
    masks = {}
    for s in STATES:
        m, _ = ink_mask(os.path.join(ASSETS, "tray-%s-%d.png" % (s, size)))
        masks[s] = m
    row = []
    for i, a in enumerate(STATES):
        for b in STATES[i + 1:]:
            diff = sum(1 for x, y in zip(masks[a], masks[b]) if x != y)
            total = size * size
            row.append("%s/%s %4d px (%.1f%%)" % (a, b, diff, 100.0 * diff / total))
            if worst_pair is None or diff < worst_pair[0]:
                worst_pair = (diff, "%s vs %s at %d" % (a, b, size))
    print("  %2dpx: %s" % (size, "   ".join(row)))

print("\nweakest distinction anywhere: %d px (%s)" % worst_pair)
print("VERDICT:", "PASS, every state pair differs in shape at every size"
      if worst_pair[0] > 0 else "FAIL, some pair is shape-identical")

# Positive control: an icon compared with itself must diff by exactly 0.
m1, _ = ink_mask(os.path.join(ASSETS, "tray-active-16.png"))
m2, _ = ink_mask(os.path.join(ASSETS, "tray-active-16.png"))
same = sum(1 for x, y in zip(m1, m2) if x != y)
print("control (active-16 vs itself, must be 0): %d" % same)
