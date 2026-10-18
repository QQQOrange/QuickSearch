# -*- coding: utf-8 -*-
"""生成一张写着已知文字的 PNG，用来验证 OCR 全链路。

识别结果要和这里的 EXPECTED 对得上 —— 图是本机生成的，文字完全已知，
所以「识别出来对不对」这件事有客观答案，不靠人眼判断。

用法：
    python make-ocr-sample.py [输出路径]
产物：
    _ocr-sample.png      图
    _ocr-sample.txt      图里写的是什么（UTF-8）
"""
import io
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
LINES = [
    '快捷搜索验证专用文本 ABC123',
    '这段文字由本机生成，用来验证百度文字识别全链路是否可用。',
]
# 断言用的两个锚点：一个中文串、一个英数串，两边都能抓住才算识别对了
EXPECT = ['快捷搜索验证专用文本', 'ABC123']

FONT_CANDIDATES = [
    r'C:/Windows/Fonts/msyh.ttc',     # 微软雅黑
    r'C:/Windows/Fonts/simhei.ttf',   # 黑体
    r'C:/Windows/Fonts/simsun.ttc',   # 宋体
]


def main():
    out_png = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '_ocr-sample.png')
    out_txt = os.path.splitext(out_png)[0] + '.txt'

    size = 64
    font = None
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                font = ImageFont.truetype(p, size)
                break
            except Exception:
                continue
    if font is None:
        raise SystemExit('没找到可用的中文字体')

    pad = 40
    # 先量一遍再开画布，免得文字被裁掉
    probe = ImageDraw.Draw(Image.new('RGB', (10, 10), 'white'))
    widths = [probe.textbbox((0, 0), s, font=font)[2] for s in LINES]
    w = max(widths) + pad * 2
    h = size * len(LINES) + 24 * (len(LINES) - 1) + pad * 2

    img = Image.new('RGB', (w, h), 'white')
    d = ImageDraw.Draw(img)
    y = pad
    for s in LINES:
        d.text((pad, y), s, font=font, fill='black')
        y += size + 24

    img.save(out_png, 'PNG')
    io.open(out_txt, 'w', encoding='utf-8', newline='').write('\n'.join(LINES))
    print('已生成 %s  （%dx%d）' % (out_png, w, h))
    print('图上的文字：')
    for s in LINES:
        print('  ' + s)
    print('断言锚点：%s' % EXPECT)


if __name__ == '__main__':
    main()
