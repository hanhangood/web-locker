"""生成扩展图标：Smartisan 风格的蓝色圆角块 + 白色挂锁。

用法：python tools/make_icons.py
输出：icons/icon16.png icon32.png icon48.png icon128.png
"""

from PIL import Image, ImageDraw
from pathlib import Path

SS = 4                      # 超采样倍数
BASE = 512                  # 设计尺寸
TOP = (0x5B, 0x87, 0xEB)    # 主蓝渐变起点（来自 smartisan.css --s-grad-primary）
BOTTOM = (0x58, 0x83, 0xEB) # 渐变终点
STROKE = (0x3F, 0x68, 0xE2) # 主蓝描边（--s-blue-500）
WHITE = (255, 255, 255, 255)
RADIUS = 116                # 圆角，约为边长的 22.6%

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=color)
    return img


def build():
    size = BASE * SS
    k = SS  # 把所有坐标乘上来，画完再缩小 = 干净的抗锯齿

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    gradient = vertical_gradient(size, TOP, BOTTOM)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=RADIUS * k, fill=255
    )
    canvas.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)

    # 锁梁（先画上半圆，再补两条竖腿，下半截会被锁体盖住）
    bow = [168 * k, 96 * k, 344 * k, 272 * k]
    draw.arc(bow, start=180, end=360, fill=WHITE, width=40 * k)
    for x in (188 * k, 324 * k):
        draw.line([(x, 184 * k), (x, 258 * k)], fill=WHITE, width=40 * k)

    # 锁体
    body = [128 * k, 240 * k, 384 * k, 404 * k]
    draw.rounded_rectangle(body, radius=54 * k, fill=WHITE)

    # 钥匙孔：圆 + 短柄
    hole_cx, hole_cy, hole_r = 256 * k, 300 * k, 23 * k
    draw.ellipse(
        [hole_cx - hole_r, hole_cy - hole_r, hole_cx + hole_r, hole_cy + hole_r],
        fill=STROKE,
    )
    draw.rounded_rectangle(
        [hole_cx - 10 * k, hole_cy, hole_cx + 10 * k, hole_cy + 52 * k],
        radius=10 * k,
        fill=STROKE,
    )

    # 一圈极细描边，符合锤子的"极细边"语言
    ImageDraw.Draw(canvas).rounded_rectangle(
        [0, 0, size - 1, size - 1],
        radius=RADIUS * k,
        outline=STROKE,
        width=6 * k,
    )

    return canvas


def main():
    master = build()
    for px in (16, 32, 48, 128):
        icon = master.resize((px, px), Image.LANCZOS)
        icon.save(OUT / f"icon{px}.png")
        print("saved", OUT / f"icon{px}.png")
    master.resize((256, 256), Image.LANCZOS).save(OUT / "icon256.png")


if __name__ == "__main__":
    main()
