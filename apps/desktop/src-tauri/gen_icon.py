import struct, zlib

def png(w, h, pixel_fn):
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter: none
        for x in range(w):
            raw += bytes(pixel_fn(x, y))
    idat = zlib.compress(bytes(raw))
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

def pixel(x, y):
    # dark background #131416 (opaque), accent square #586df3 in the center
    if 180 <= x < 332 and 180 <= y < 332:
        return (0x58, 0x6d, 0xf3, 0xff)
    return (0x13, 0x14, 0x16, 0xff)

with open('icons/icon.png', 'wb') as f:
    f.write(png(512, 512, pixel))
print('wrote RGBA icons/icon.png')
