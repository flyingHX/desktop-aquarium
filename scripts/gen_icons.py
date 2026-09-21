#!/usr/bin/env python3
"""生成应用图标：纯 Python 实现（无第三方依赖）。
输出：
  icons/icon.png    128x128
  icons/32x32.png   32x32（托盘用）
  icons/icon.ico    含 32/48/128 三个尺寸（PNG-in-ICO）
图标内容：深蓝渐变背景 + 橙色小丑鱼剪影（椭圆鱼身 + 三角尾鳍 + 白色条纹 + 眼睛）
"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def pixel(x: int, y: int, size: int) -> tuple[int, int, int]:
    """计算 (x, y) 处的像素颜色。"""
    t = y / size
    r = int(12 + 18 * (1 - t))
    g = int(72 + 60 * (1 - t))
    b = int(112 + 78 * (1 - t))

    # 鱼身：椭圆
    fx = (x - 0.58 * size) / (0.30 * size)
    fy = (y - 0.50 * size) / (0.16 * size)
    body = fx * fx + fy * fy <= 1.0
    # 尾鳍：左侧三角形
    tail = (0.06 * size <= x <= 0.26 * size) and abs(y - 0.5 * size) <= (0.26 * size - x) * 0.85

    if body or tail:
        u = (x - 0.28 * size) / (0.62 * size)
        stripe = abs(u - 0.32) < 0.05 or abs(u - 0.64) < 0.05
        if stripe:
            r, g, b = 248, 250, 252
        else:
            r, g, b = 255, 138, 22
        # 眼睛
        ex = (x - 0.74 * size) / (0.035 * size)
        ey = (y - 0.44 * size) / (0.045 * size)
        if ex * ex + ey * ey <= 1:
            r, g, b = 18, 20, 26
    return r, g, b


def png_bytes(size: int) -> bytes:
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")
        for x in range(size):
            row += bytes(pixel(x, y, size))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico_bytes(sizes: list[int]) -> bytes:
    out = struct.pack("<HHH", 0, 1, len(sizes))
    entries = b""
    imgs = b""
    offset = 6 + 16 * len(sizes)
    for s in sizes:
        data = png_bytes(s)
        entries += struct.pack(
            "<BBBBHHII",
            s if s < 256 else 0,
            s if s < 256 else 0,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        imgs += data
        offset += len(data)
    return out + entries + imgs


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, size in [("icon.png", 128), ("32x32.png", 32)]:
        path = os.path.join(OUT_DIR, name)
        with open(path, "wb") as f:
            f.write(png_bytes(size))
        print(f"已生成 {path}（{size}x{size}）")
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    with open(ico_path, "wb") as f:
        f.write(ico_bytes([32, 48, 128]))
    print(f"已生成 {ico_path}")


if __name__ == "__main__":
    main()
