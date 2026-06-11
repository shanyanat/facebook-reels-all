"""
create_icons.py — Generate PNG icon files for the FB Reels Multi Analyze extension.
Run once: python create_icons.py
No external dependencies (pure stdlib).
"""
import struct
import zlib
import os
import math


def make_png_rgba(w, h, get_pixel):
    """Build a minimal valid RGBA PNG from a per-pixel callback."""
    def chunk(ctype, data):
        crc = zlib.crc32(ctype + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + ctype + data + struct.pack('>I', crc)

    raw = b''
    for y in range(h):
        raw += b'\x00'               # filter type: None
        for x in range(w):
            r, g, b, a = get_pixel(x, y, w, h)
            raw += bytes([
                max(0, min(255, r)),
                max(0, min(255, g)),
                max(0, min(255, b)),
                max(0, min(255, a)),
            ])

    sig  = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))  # 8-bit RGBA
    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend


def icon_pixel(x, y, w, h):
    """
    Draw a dark-blue circular icon with a stylised film-strip + play-triangle motif.
    """
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    r_outer = cx                     # outer radius
    r_inner = cx * 0.92              # inner edge of circle

    nx = (x - cx) / cx
    ny = (y - cy) / cy
    dist = math.sqrt(nx * nx + ny * ny)

    # Outside circle → transparent
    if dist > 1.0:
        return (0, 0, 0, 0)

    # ── Background gradient (dark navy → deep blue) ─────────────────────────
    t = (y / h)
    bg_r = int(8  + t * 18)
    bg_g = int(12 + t * 22)
    bg_b = int(45 + t * 90)

    # ── Thin rim highlight ───────────────────────────────────────────────────
    rim_width = 0.06
    if dist > (1.0 - rim_width):
        rim_t = (dist - (1.0 - rim_width)) / rim_width
        rim_r = int(60  + rim_t * 80)
        rim_g = int(100 + rim_t * 80)
        rim_b = int(200 + rim_t * 40)
        alpha = int(255 * (1.0 - rim_t * 0.5))
        return (rim_r, rim_g, rim_b, alpha)

    # ── Play triangle (centred) ──────────────────────────────────────────────
    # Triangle vertices in normalised coords: tip right, base left
    # Scale to ~55% of radius
    scale = 0.55
    # Point right: tip = (0.3, 0),  top-left = (-0.25, -0.38),  bot-left = (-0.25, 0.38)
    tx, ty = nx / scale, ny / scale

    # Three half-plane tests for the triangle
    def side(ax, ay, bx, by, px, py):
        return (bx - ax) * (py - ay) - (by - ay) * (px - ax)

    v1x, v1y =  0.32,  0.0
    v2x, v2y = -0.28, -0.40
    v3x, v3y = -0.28,  0.40

    d1 = side(v1x, v1y, v2x, v2y, tx, ty)
    d2 = side(v2x, v2y, v3x, v3y, tx, ty)
    d3 = side(v3x, v3y, v1x, v1y, tx, ty)

    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    in_triangle = not (has_neg and has_pos)

    if in_triangle:
        # Bright white-blue play button
        play_t = 1.0 - dist * 0.3
        pr = int(160 + play_t * 80)
        pg = int(200 + play_t * 50)
        pb = 255
        return (pr, pg, pb, 255)

    # ── Two film-strip rectangles (top and bottom edge bands) ────────────────
    band_h = 0.12   # normalised height
    band_w = 0.70   # normalised half-width
    notch_w = 0.10  # width of each notch
    notch_gap = 0.28

    for sign in (-1, 1):
        band_cy = sign * 0.68
        if abs(ny - band_cy) < band_h and abs(nx) < band_w:
            # Punch notches into band
            in_notch = False
            for npos in (-notch_gap, 0, notch_gap):
                if abs(nx - npos) < notch_w * 0.5 and abs(ny - band_cy) < band_h * 0.55:
                    in_notch = True
                    break
            if not in_notch:
                return (80, 130, 230, 220)

    return (bg_r, bg_g, bg_b, 255)


def main():
    out_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(out_dir, exist_ok=True)

    for size in (16, 32, 48, 128):
        data = make_png_rgba(size, size, icon_pixel)
        path = os.path.join(out_dir, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(data)
        print(f'  Created {path}  ({size}x{size}, {len(data)} bytes)')

    print('Done.')


if __name__ == '__main__':
    main()
