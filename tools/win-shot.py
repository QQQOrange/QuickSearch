# -*- coding: utf-8 -*-
"""抓横条窗口在**真实屏幕上**的那一块（不是 PrintWindow —— 透明窗 PrintWindow 是全黑）。

多显示器 + DPI 缩放下坐标会错位：这里按「进程不感知 DPI → 拿到逻辑坐标」，
再按虚拟屏逻辑尺寸 vs 截图物理尺寸的比例换算成物理坐标去裁。

用法：python win-shot.py 输出.png
"""
import sys
import ctypes
import ctypes.wintypes as wt
from PIL import ImageGrab, Image

u = ctypes.windll.user32

CB = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def find_bar():
    out = []
    def cb(h, l):
        n = u.GetWindowTextLengthW(h)
        if n:
            b = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, b, n + 1)
            if b.value == 'QuickSearchBar' and u.IsWindowVisible(h):
                r = wt.RECT()
                u.GetWindowRect(h, ctypes.byref(r))
                if r.left > -5000:
                    out.append((r.left, r.top, r.right - r.left, r.bottom - r.top))
        return True
    u.EnumWindows(CB(cb), 0)
    return out


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'win.png'
    bars = find_bar()
    print('可见横条窗口：', bars)
    if not bars:
        sys.exit(1)
    x, y, w, h = bars[0]

    img = ImageGrab.grab(all_screens=True)
    vw = u.GetSystemMetrics(78)   # 虚拟屏逻辑宽
    vh = u.GetSystemMetrics(79)
    sx = img.size[0] / float(vw)
    sy = img.size[1] / float(vh)
    print('截图尺寸', img.size, '逻辑虚拟屏', (vw, vh), '比例', (sx, sy))

    pad = 20
    box = (int(x * sx) - pad, int(y * sy) - pad,
           int((x + w) * sx) + pad, int((y + h) * sy) + pad)
    crop = img.crop(box)
    crop = crop.resize((crop.size[0] * 2, crop.size[1] * 2), Image.LANCZOS)
    crop.save(out)
    print('已保存:', out, crop.size)
