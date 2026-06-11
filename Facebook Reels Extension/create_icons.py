"""Run once to generate extension icons: python create_icons.py"""
import struct, zlib, os

def make_png(size, r, g, b):
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes([r, g, b] * size) for _ in range(size))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))

os.makedirs('icons', exist_ok=True)
for size in [16, 48, 128]:
    path = os.path.join('icons', f'icon{size}.png')
    with open(path, 'wb') as f:
        f.write(make_png(size, 26, 115, 232))  # Google blue
    print(f'Created {path}')
print('Icons ready.')
