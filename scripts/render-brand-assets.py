#!/usr/bin/env python3
"""Render StampStack extension icons + store promo from store/brand/stampstack-source.png."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "store" / "brand" / "stampstack-source.png"
ICONS_OUT = ROOT / "src" / "icons"
STORE_OUT = ROOT / "store"

# Blue BLOCK stamp region (sampled from source art).
STAMP_CX, STAMP_CY = 629, 629
STAMP_HALF = 340
FULL_PAD = 24


def load_source() -> Image.Image:
    if not SOURCE.is_file():
        raise SystemExit(f"Missing brand source: {SOURCE}")
    return Image.open(SOURCE).convert("RGBA")


def square_crop(img: Image.Image, cx: float, cy: float, half: float) -> Image.Image:
    w, h = img.size
    half = min(half, cx, cy, w - cx, h - cy)
    left = int(round(cx - half))
    top = int(round(cy - half))
    right = int(round(cx + half))
    bottom = int(round(cy + half))
    return img.crop((left, top, right, bottom))


def fit_square(img: Image.Image, size: int, *, pad_ratio: float = 0.06) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = max(1, int(size * (1 - 2 * pad_ratio)))
    scaled = img.copy()
    scaled.thumbnail((inner, inner), Image.Resampling.LANCZOS)
    x = (size - scaled.width) // 2
    y = (size - scaled.height) // 2
    canvas.paste(scaled, (x, y), scaled)
    return canvas


def render_icon(src: Image.Image, size: int) -> Image.Image:
    if size <= 48:
        crop = square_crop(src, STAMP_CX, STAMP_CY, STAMP_HALF)
        pad = 0.04 if size >= 32 else 0.02
        return fit_square(crop, size, pad_ratio=pad)
    w, h = src.size
    inset = FULL_PAD
    crop = src.crop((inset, inset, w - inset, h - inset))
    return fit_square(crop, size, pad_ratio=0.04)


def render_promo(src: Image.Image) -> Image.Image:
    W, H = 440, 280
    bg = (246, 244, 239, 255)
    out = Image.new("RGBA", (W, H), bg)
    draw = ImageDraw.Draw(out)
    draw.rectangle((0, 0, 7, H), fill=(30, 70, 150, 255))

    art = square_crop(src, 520, 520, 480)
    art = art.resize((200, 200), Image.Resampling.LANCZOS)
    out.paste(art, (36, 40), art)

    try:
        font = ImageFont.truetype("arialbd.ttf", 34)
        font_sm = ImageFont.truetype("arial.ttf", 14)
    except OSError:
        font = ImageFont.load_default()
        font_sm = font

    text_x = 250
    draw.text((text_x, 100), "StampStack", fill=(28, 32, 40, 255), font=font)
    draw.text((text_x, 150), "Block ads & trackers", fill=(90, 96, 104, 255), font=font_sm)
    return out


def main() -> int:
    src = load_source()
    ICONS_OUT.mkdir(parents=True, exist_ok=True)
    STORE_OUT.mkdir(parents=True, exist_ok=True)

    for size in (16, 32, 48, 128):
        icon = render_icon(src, size)
        path = ICONS_OUT / f"icon-{size}.png"
        icon.save(path, optimize=True)
        print(f"  ok {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")

    promo = render_promo(src)
    promo_path = STORE_OUT / "promo-small.png"
    promo.convert("RGBA").save(promo_path, optimize=True)
    print(f"  ok {promo_path.relative_to(ROOT)} ({promo_path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
