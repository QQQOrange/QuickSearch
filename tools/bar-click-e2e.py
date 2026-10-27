# -*- coding: utf-8 -*-
"""横条 @trans 按钮真点击联调（修「选中文字点翻译没反应」专用）。

背景：用户实测「选中文字 → 点翻译 → 什么都没发生」。部署版日志证明：
  · 点击确实落在横条内容区（up-check 的 from=None = 按下时在横条上）；
  · 19ms 后有一次 dismiss_bar（trans_start 里那句的签名）；
  · 但从来没有 `trans win: built` —— 窗口压根没建出来。

为什么不用 CDP：隔离实例带 QS_T_WV_ARGS（调试端口）时，WebView2 会以不同的
browser args 去抢生产实例正占着的 EBWebView 用户数据目录，直接
0x8007139F「组或资源的状态不是执行请求操作的正确状态」，整个 app 在 setup
阶段 panic（日志实测过）。所以这里走项目现成的路：
  · `--bar` 启动参数直接把横条摆出来（不注入任何全局输入，不打扰生产实例）；
  · ctypes 驱**真鼠标**点真按钮（和 tools/click.js 同款机制，只是 koffi 装
    不上时用 Python ctypes 直调 user32）；
  · Plain click（按下抬起同点）不会触发生产实例的划词取词 —— Ev::Up 的
    was=false 分支直接跳过 schedule_capture，两边互不干扰。

几何算法：横条名单只放 ['@trans'] 一颗 → 引擎区第一个按钮就是它。
窗口矩形/缩放从日志的 `layout: win=(X,Y,W,H)` + `layout_bar css=… scale=N` 读；
按钮位置按 bar.css 现算：stage 边距 24 CSS + .bar 横向 padding 7 + 半颗按钮。

用法: python tools/bar-click-e2e.py
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get("QS_E2E_EXE") or os.path.join(ROOT, "target", "release", "QuickSearch.exe")
SCRATCH = os.path.join(ROOT, "tools", ".bar-click-data")
LOG = os.path.join(SCRATCH, "log.txt")

RESULTS = []


def ok(cond, name, extra=""):
    line = ("OK  " if cond else "NO  ") + name + ((" → " + str(extra)) if extra else "")
    RESULTS.append(line)
    print(line, flush=True)


def say(s):
    print("    " + s, flush=True)


# ---------------------------------------------------------------- Win32
user32 = ctypes.windll.user32
try:  # per-monitor v2：让绝对坐标换算用物理像素
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


def screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def click(x, y):
    sw, sh = screen_size()
    ax = round(x * 65535 / (sw - 1))
    ay = round(y * 65535 / (sh - 1))
    user32.mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay, 0, 0)
    time.sleep(0.16)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.09)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    say("已点击 (%d,%d)" % (x, y))


EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def list_windows():
    out = []

    def cb(h, _):
        buf = ctypes.create_unicode_buffer(400)
        n = user32.GetWindowTextW(h, buf, 400)
        r = wt.RECT()
        user32.GetWindowRect(h, ctypes.byref(r))
        out.append({
            "t": buf.value if n else "",
            "vis": bool(user32.IsWindowVisible(h)),
            "l": r.left, "tp": r.top, "r": r.right, "b": r.bottom,
        })
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


# ---------------------------------------------------------------- 日志
def log_text():
    try:
        with open(LOG, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def log_len():
    try:
        return os.path.getsize(LOG)
    except OSError:
        return 0


def read_from(pos):
    try:
        with open(LOG, "rb") as f:
            f.seek(pos)
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def wait_log(sub, ms):
    t0 = time.time()
    while (time.time() - t0) * 1000 < ms:
        t = log_text()
        if sub in t:
            return t
        time.sleep(0.12)
    return None


def bar_geometry():
    """从日志最后一次 layout 行拿窗口矩形 + scale + barH。"""
    win, scale, barH = None, 2.0, 33.0
    for l in reversed(log_text().split("\n")):
        if win is None:
            m = re.search(r"layout: win=\((\d+),(\d+),(\d+),(\d+)\)", l)
            if m:
                win = {"x": int(m.group(1)), "y": int(m.group(2)),
                       "w": int(m.group(3)), "h": int(m.group(4))}
        if scale == 2.0 or barH == 33.0:
            ms = re.search(r"scale=([\d.]+)", l)
            if ms:
                scale = float(ms.group(1))
            mh = re.search(r"barH=([\d.]+)", l)
            if mh:
                barH = float(mh.group(1))
        if win is not None and scale != 2.0 and barH != 33.0:
            break
    if win is None:
        return None
    return {"win": win, "scale": scale, "barH": barH}


def finish(proc):
    try:
        proc.kill()
    except Exception:
        pass
    subprocess.run(["taskkill", "/IM", "QuickSearch.exe", "/FI", "PID eq %d" % proc.pid, "/T", "/F"],
                   capture_output=True)
    with open(os.path.join(ROOT, "tools", "_bar-click.result.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(RESULTS) + "\n")
    bad = sum(1 for r in RESULTS if r.startswith("NO"))
    print("==== %d/%d 通过 ====" % (len(RESULTS) - bad, len(RESULTS)), flush=True)
    sys.exit(1 if bad else 0)


CONF = {
    "trans_enable": True,
    "trans_engine": "deepseek",
    "trans_multi": [],
    "trans_target": "en",
    "trans_keys": {"deepseek": "sk-bar-click-test"},
    "bar_list": ["@trans"],
    "bar_idle_sec": 0,
    "bar_away_px": 0,
    "shadow": False,
    "bar_need_text": False,
}


def main():
    shutil.rmtree(SCRATCH, ignore_errors=True)
    os.makedirs(SCRATCH, exist_ok=True)
    with open(os.path.join(SCRATCH, "config.json"), "w", encoding="utf-8") as f:
        json.dump(CONF, f, ensure_ascii=False, indent=2)

    # 先把鼠标挪到主屏中央偏左上：--bar 会把横条摆在光标处，
    # 这样横条一定落在主屏内（绝对坐标映射只覆盖主屏）。
    sw, sh = screen_size()
    click(int(sw * 0.35), int(sh * 0.3))
    time.sleep(0.2)

    env = dict(os.environ)
    env.update({
        "QS_INSTANCE_TAG": "bar-click-e2e",
        "QS_DATA_DIR": SCRATCH,
        "QS_NO_CLOUD": "1",
        "QS_DEBUG": "1",
        # 钩子默认丢弃注入的鼠标事件（LLMHF_INJECTED）—— 真点击联调必须放开，
        # 否则 ctypes 发的事件应用侧一概看不见（见 hook.rs allow_injected）。
        "QS_ALLOW_INJECTED": "1",
    })
    # ⚠ 绝不带 QS_T_WV_ARGS：那会让 WebView2 换一套 browser args 去抢生产实例
    #    正占着的用户数据目录，直接 0x8007139F，app 在 setup 就 panic。
    proc = subprocess.Popen([EXE, "--no-elevate", "--bar"], env=env, cwd=ROOT)
    say("已启动 PID=%d（无 CDP，走 --bar + 真鼠标）" % proc.pid)

    # ① 等横条真弹出来
    t = wait_log("layout: win=", 40000)
    ok(t is not None, "横条弹出来了（日志出现 layout: win=）")
    if t is None:
        finish(proc)
        return
    time.sleep(0.6)  # 等 layout_bar / after-show 打完

    geo = bar_geometry()
    if geo is None:
        ok(False, "读到横条窗口几何")
        finish(proc)
        return
    win, scale, barH = geo["win"], geo["scale"], geo["barH"]
    say("窗口矩形=%s scale=%s barH=%s" % (win, scale, barH))

    # ② 算 @trans 按钮中心（bar_list 只有它一颗 → 引擎区第一个）
    btn_css = barH - 10                       # .bar 纵向 padding 5+5
    cx_css = 24 + 7 + btn_css / 2.0           # stage 边距 24 + .bar 横 padding 7 + 半颗
    cy_css = 24 + 5 + btn_css / 2.0
    px = int(round(win["x"] + cx_css * scale))
    py = int(round(win["y"] + cy_css * scale))
    say("按钮中心 CSS=(%.1f,%.1f) → 物理 (%d,%d)" % (cx_css, cy_css, px, py))

    # ③ 真点它
    before = log_len()
    click(px, py)
    time.sleep(2.5)

    fresh = read_from(before)
    trans_lines = [l for l in fresh.split("\n") if re.search(r"trans|dismiss|panic|PANIC", l)]
    say("点击后的日志片段：")
    for l in trans_lines[-8:]:
        say("  " + l)

    built = "trans win: built" in fresh
    build_failed = "trans win: build failed" in fresh
    disabled = "功能已关闭" in fresh
    dismissed = "dismiss_bar:" in fresh
    ready_fallback = "ready 超时" in fresh
    panicked = bool(re.search(r"panicked|PANIC", fresh))

    ok(dismissed, "横条按设计收起（trans_start 里的 dismiss_bar）")
    ok(built, "点 @trans → 日志出现 `trans win: built`",
       "" if built else ("（但出现了 build failed）" if build_failed else "（没有 trans win 行）"))
    ok(not build_failed, "翻译窗没有构建失败",
       [l for l in trans_lines if "build failed" in l][-1] if build_failed else "")
    ok(not disabled, "翻译功能没有被判成已关闭")
    ok(not panicked, "没有 panic")

    # ④ 翻译窗真的在屏幕上吗（按标题找窗口）
    wins = list_windows()
    trans_win = next((w for w in wins if "翻译" in w["t"] and w["vis"]), None)
    ok(trans_win is not None, "屏幕上出现了标题带「翻译」的窗口",
       ("%s @(%d,%d) %dx%d" % (trans_win["t"], trans_win["l"], trans_win["tp"],
                              trans_win["r"] - trans_win["l"], trans_win["b"] - trans_win["tp"]))
       if trans_win else
       ("（枚举到的窗口：" + " | ".join(w["t"] for w in wins if w["t"])[:300] + "）"))

    # ⑤ 顺手确认死区行为没被这次改动带坏（点透明边距应收横条）
    finish(proc)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print("NO 联调脚本异常：" + str(e), flush=True)
        RESULTS.append("NO 联调脚本异常：" + str(e))
        sys.exit(1)
