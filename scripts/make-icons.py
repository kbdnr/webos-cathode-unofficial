#!/usr/bin/env python3
"""Generate placeholder app icons (a glowing CRT screen) with no third-party deps."""
import struct
import sys
import zlib
from pathlib import Path


def png(width, height, pixel):
    rows = b''.join(
        b'\x00' + b''.join(bytes(pixel(x, y, width, height)) for x in range(width))
        for y in range(height)
    )

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows, 9))
            + chunk(b'IEND', b''))


def crt(x, y, w, h):
    # Rounded screen inset by 14%, amber glow fading toward the edges, with scanlines.
    m = 0.14
    nx, ny = (x + 0.5) / w, (y + 0.5) / h
    dx = max(0.0, abs(nx - 0.5) - (0.5 - m - 0.08)) / 0.08
    dy = max(0.0, abs(ny - 0.5) - (0.5 - m - 0.08)) / 0.08
    if dx * dx + dy * dy > 1.0:
        return (10, 10, 10)
    d = ((nx - 0.5) ** 2 + (ny - 0.5) ** 2) ** 0.5
    glow = max(0.0, 1.0 - d * 1.6)
    scan = 0.75 if (y % 3 == 0) else 1.0
    return tuple(int(min(255, c * (0.35 + 0.65 * glow) * scan)) for c in (255, 154, 31))


out = Path(sys.argv[1] if len(sys.argv) > 1 else 'app')
for name, size in (('icon.png', 80), ('largeIcon.png', 130)):
    (out / name).write_bytes(png(size, size, crt))
    print('wrote', out / name)
