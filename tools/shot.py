# -*- coding: utf-8 -*-
"""整屏截图（支持多显示器）。

用 PIL 的 ImageGrab 而不是 PowerShell + System.Drawing：
后者要先 Add-Type 编译一遍，慢且偶发被安全策略挡；PIL 这边一次调用就完事。

用法：
    python shot.py 输出.png
    python shot.py 输出.png 800,200,1400,900     # 可选：只裁某块区域 x,y,w,h
"""
import sys
from PIL import ImageGrab

out = sys.argv[1] if len(sys.argv) > 1 else 'shot.png'
img = ImageGrab.grab(all_screens=True)
print('虚拟屏尺寸:', img.size)

if len(sys.argv) > 3:
    x, y, w, h = (int(v) for v in sys.argv[2].split(','))
    img = img.crop((x, y, x + w, y + h))
    print('裁剪为:', img.size)

img.save(out)
print('已保存:', out)
