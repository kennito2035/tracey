#!/usr/bin/env python3
"""Generate tracey tray icons (no third-party deps).

Mark: a rounded tile in the state colour with a glyph cut through it.

EACH STATE HAS ITS OWN GLYPH, not just its own colour. The three tiles used to
carry the same wave and differ only in hue, which meant the one signal
distinguishing "steadying" from "paused" was colour: unusable for a colour-blind
user, and directly contrary to ACCESSIBILITY.md's promise that colour is never
the only signal. Measured before this change: the active and paused ink masks
were pixel-identical at every size.

  active  the wave, shaky on the left and smoothed toward the right, which is
          the product in one mark
  paused  two upright bars, the universal pause symbol
  off     one flat line: nothing is being steadied

Read at 16px, which is what the Windows notification area actually uses, so the
shapes have to survive that. They are deliberately coarse for that reason.
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")

STATES = {
    "active": (0x4F, 0xD1, 0xC5),   # teal  - filtering
    "paused": (0xF2, 0xA6, 0x5A),   # amber - core up, filtering off
    "off":    (0x6B, 0x7B, 0x8D),   # slate - core not running
}

SS = 4  # supersample factor for anti-aliasing


def rounded_rect(x, y, w, h, r):
    def inside(px, py):
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def wave_points(size, n=200):
    """Smooth wave across the tile, flattening toward the right edge."""
    pts = []
    for i in range(n):
        t = i / (n - 1)
        px = 0.18 * size + t * 0.64 * size
        damp = 1.0 - t * 0.85
        py = 0.5 * size + math.sin(t * math.pi * 2.4) * 0.17 * size * damp
        pts.append((px, py))
    return pts


def pause_bars(size):
    """Two upright bars. Separation is generous because at 16px the gap between
    them is about 2px, and anything tighter closes up under anti-aliasing."""
    return [
        [(0.35 * size, 0.30 * size), (0.35 * size, 0.70 * size)],
        [(0.65 * size, 0.30 * size), (0.65 * size, 0.70 * size)],
    ]


def flat_line(size):
    """One straight line: no stroke is being steadied because nothing is running."""
    return [[(0.18 * size, 0.5 * size), (0.82 * size, 0.5 * size)]]


def glyph_for(state, size):
    """(polylines, stroke radius) for a state. Drawn ink is 2 * stroke wide."""
    if state == "paused":
        return pause_bars(size), max(1.1, size * 0.075)
    if state == "off":
        return flat_line(size), max(1.15, size * 0.085)
    return [wave_points(size)], max(1.15, size * 0.085)


def dist_to_polyline(px, py, pts):
    best = 1e9
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        qx, qy = ax + t * dx, ay + t * dy
        d = (px - qx) ** 2 + (py - qy) ** 2
        if d < best:
            best = d
    return math.sqrt(best)


def dist_to_glyph(px, py, polys):
    return min(dist_to_polyline(px, py, p) for p in polys)


def render(size, rgb, state="active"):
    tile = rounded_rect(size * 0.06, size * 0.06, size * 0.88, size * 0.88, size * 0.26)
    polys, stroke = glyph_for(state, size)
    px = bytearray()
    for y in range(size):
        px.append(0)  # filter byte
        for x in range(size):
            cov_tile = 0
            cov_wave = 0
            for sy in range(SS):
                for sx in range(SS):
                    fx = x + (sx + 0.5) / SS
                    fy = y + (sy + 0.5) / SS
                    if tile(fx, fy):
                        cov_tile += 1
                        if dist_to_glyph(fx, fy, polys) <= stroke:
                            cov_wave += 1
            n = SS * SS
            a_tile = cov_tile / n
            a_wave = cov_wave / n
            if a_tile == 0:
                px += bytes((0, 0, 0, 0))
                continue
            mix = a_wave / a_tile if a_tile else 0
            r = round(rgb[0] * (1 - mix) + 0x0E * mix)
            g = round(rgb[1] * (1 - mix) + 0x16 * mix)
            b = round(rgb[2] * (1 - mix) + 0x20 * mix)
            px += bytes((r, g, b, round(a_tile * 255)))
    return bytes(px)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size, raw):
    hdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    blob = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", hdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(blob)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, rgb in STATES.items():
        for size in (16, 24, 32, 48):
            write_png(os.path.join(OUT, f"tray-{name}-{size}.png"), size,
                      render(size, rgb, name))
    # The app icon stays the wave: it is the product mark, not a state.
    write_png(os.path.join(OUT, "icon.png"), 256, render(256, STATES["active"], "active"))
    print("wrote icons to", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
