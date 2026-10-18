# -*- coding: utf-8 -*-
"""把浅底 / 深底两张横条实拍拼成一张对照图，作为「自动取色」的取证截图。"""
import os, statistics, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
WIN = os.path.abspath(os.path.join(HERE, '..'))

FONT_R = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"
f_title = ImageFont.truetype(FONT_B, 34)
f_sub   = ImageFont.truetype(FONT_R, 21)
f_cap   = ImageFont.truetype(FONT_B, 24)
f_small = ImageFont.truetype(FONT_R, 19)
f_mono  = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 19)


def bar_bg(path):
    """量横条本体（避开图标、边框、圆角）的代表色。
    裁剪图比横条矩形外扩 24px，横条本体大致落在 y 48..140、x 40..700。"""
    im = Image.open(path).convert("RGB")
    px = [im.getpixel((x, y)) for x in range(40, 700, 3) for y in range(56, 132, 2)]
    med = tuple(int(statistics.median([p[i] for p in px])) for i in range(3))
    lum = (0.2126 * med[0] + 0.7152 * med[1] + 0.0722 * med[2]) / 255
    return im, med, lum


light_p = os.path.join(WIN, "_ev-barcrop-light.png")
dark_p = os.path.join(WIN, "_ev-barcrop-dark.png")
imL, cL, lumL = bar_bg(light_p)
imD, cD, lumD = bar_bg(dark_p)

PW, PH = imL.size
GAP, PAD, TOP = 28, 34, 132
W = PAD * 2 + PW * 2 + GAP
H = TOP + PH + 110
canvas = Image.new("RGB", (W, H), (250, 250, 252))
d = ImageDraw.Draw(canvas)

d.text((PAD, 30), "Quick Search 桌面版 · 横条自动取色验证", font=f_title, fill=(24, 26, 30))
d.text((PAD, 76), "在两种截然不同的软件背景上选中同一段文字，横条取用其背后的屏幕颜色自适配深浅",
       font=f_sub, fill=(96, 102, 112))

for i, (im, c, lum, name) in enumerate(
        [(imL, cL, lumL, "浅色背景"), (imD, cD, lumD, "深色背景")]):
    x = PAD + i * (PW + GAP)
    canvas.paste(im, (x, TOP))
    d.rectangle([x - 1, TOP - 1, x + PW, TOP + PH], outline=(198, 202, 210), width=1)
    yy = TOP + PH + 16
    d.text((x, yy), "%s  →  横条取色 rgb%s   亮度 %.2f   判定 %s"
           % (name, c, lum, "深色" if lum < 0.5 else "浅色"),
           font=f_cap, fill=(24, 26, 30))
    d.text((x, yy + 34),
           "（%s，与横条底色一致，所以横条和背景自然融为一体）"
           % ("实测：横条本体明显偏暗" if lum < 0.5 else "实测：横条本体明显偏亮"),
           font=f_small, fill=(110, 116, 126))

out = os.path.join(WIN, "_证据1-自动取色.png")
canvas.save(out)
print("saved", out, canvas.size)
print("  浅底横条色:", cL, "亮度", round(lumL, 2))
print("  深底横条色:", cD, "亮度", round(lumD, 2))
