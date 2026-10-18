# -*- coding: utf-8 -*-
"""QuickSearch 内存泄漏采样器（psutil + ctypes 版）。

跟踪 QuickSearch.exe 主进程 + 它拉起的全部子进程（WebView2 渲染/GPU 进程），
按固定间隔记录 WorkingSet / PrivateBytes / 句柄 / 线程 / GDI 对象 / USER 对象，
最后给出「是否有持续增长趋势」的判定。

用法:
    python memtest.py [采样总秒数] [采样间隔秒] [输出csv] [标题] [热身排除秒数]
例:
    python memtest.py 100 2 tools/memtest.csv "300 次弹出/关闭" 30

「热身排除秒数」：WebView2 冷启动那几秒会一次性申请几百 MB 和上千个句柄，
那是**一次性预热**不是泄漏。判定只取热身结束之后的样本，否则会被误判成 WARN。
"""
import sys, os, csv, time, ctypes
from ctypes import wintypes
import psutil

ROOT_NAME = "QuickSearch.exe"
total = float(sys.argv[1]) if len(sys.argv) > 1 else 90.0
interval = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
out_csv = sys.argv[3] if len(sys.argv) > 3 else "memtest.csv"
label = sys.argv[4] if len(sys.argv) > 4 else ""
warmup = float(sys.argv[5]) if len(sys.argv) > 5 else 30.0

# ---------------- GDI / USER 对象计数（C 侧同样调用，避免托管计数误差） ----------------
user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

GR_GDIOBJECTS = 0
GR_USEROBJECTS = 1
user32.GetGuiResources.argtypes = [wintypes.HANDLE, wintypes.DWORD]
user32.GetGuiResources.restype = wintypes.DWORD
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def gui_objects(pid):
    """返回 (gdi, user)；取不到时返回 (None, None)。"""
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
    if not h:
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None, None
    try:
        return (user32.GetGuiResources(h, GR_GDIOBJECTS),
                user32.GetGuiResources(h, GR_USEROBJECTS))
    finally:
        kernel32.CloseHandle(h)


def find_roots():
    out = []
    for p in psutil.process_iter(["name"]):
        if (p.info["name"] or "").lower() == ROOT_NAME.lower():
            out.append(p)
    return out


def tree(root):
    ps = [root]
    try:
        ps.extend(root.children(recursive=True))
    except Exception:
        pass
    return ps


def run():
    t0 = time.time()
    rows = []
    while True:
        el = time.time() - t0
        if el > total:
            break
        roots = find_roots()
        if not roots:
            print("[%6.1fs] QuickSearch 未在运行，结束采样" % el, flush=True)
            break
        root = roots[0]
        ps = tree(root)
        ws = pv = 0
        hd = th = cnt = 0
        for p in ps:
            try:
                mi = p.memory_info()
                ws += mi.rss
                pv += getattr(mi, "private", mi.vms)
                hd += p.num_handles()
                th += p.num_threads()
                cnt += 1
            except Exception:
                pass
        gdi, usr = gui_objects(root.pid)
        rows.append({
            "t_sec": round(el, 1),
            "procs": cnt,
            "workingSet": round(ws / 1048576, 1),
            "privateMB": round(pv / 1048576, 1),
            "handles": hd,
            "threads": th,
            "gdi": gdi if gdi is not None else "",
            "user": usr if usr is not None else "",
        })
        print("[%6.1fs] procs=%d WS=%8.1fMB Priv=%8.1fMB Handles=%5d Threads=%4d GDI=%s USER=%s"
              % (el, cnt, ws / 1048576, pv / 1048576, hd, th, gdi, usr), flush=True)
        time.sleep(interval)

    if not rows:
        print("没有采到数据", flush=True)
        return 1

    with open(out_csv, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    f0, l0 = rows[0], rows[-1]
    d = {k: l0[k] - f0[k] for k in ("workingSet", "privateMB", "handles", "threads")}
    if f0["gdi"] != "" and l0["gdi"] != "":
        d["gdi"] = l0["gdi"] - f0["gdi"]
    if f0["user"] != "" and l0["user"] != "":
        d["user"] = l0["user"] - f0["user"]

    print("", flush=True)
    print("=================== 汇总 %s ===================" % label, flush=True)
    print("样本数        : %d  (历时 %.1fs)" % (len(rows), l0["t_sec"]), flush=True)
    print("WorkingSet    : %8.1f MB -> %8.1f MB   Δ %+7.1f MB" % (f0["workingSet"], l0["workingSet"], d["workingSet"]), flush=True)
    print("PrivateBytes  : %8.1f MB -> %8.1f MB   Δ %+7.1f MB" % (f0["privateMB"], l0["privateMB"], d["privateMB"]), flush=True)
    print("句柄数        : %8d    -> %8d      Δ %+7d" % (f0["handles"], l0["handles"], d["handles"]), flush=True)
    print("线程数        : %8d    -> %8d      Δ %+7d" % (f0["threads"], l0["threads"], d["threads"]), flush=True)
    if "gdi" in d:
        print("GDI 对象      : %8d    -> %8d      Δ %+7d" % (f0["gdi"], l0["gdi"], d["gdi"]), flush=True)
    if "user" in d:
        print("USER 对象     : %8d    -> %8d      Δ %+7d" % (f0["user"], l0["user"], d["user"]), flush=True)

    # ---------------- 判定只取热身之后的稳态样本 ----------------
    steady = [r for r in rows if r["t_sec"] >= warmup]
    if len(steady) < 3:
        steady = rows[-max(3, len(rows) // 3):]
    s0, s1 = steady[0], steady[-1]
    sd = {k: s1[k] - s0[k] for k in ("workingSet", "privateMB", "handles", "threads")}
    if s0["gdi"] != "" and s1["gdi"] != "":
        sd["gdi"] = s1["gdi"] - s0["gdi"]
    if s0["user"] != "" and s1["user"] != "":
        sd["user"] = s1["user"] - s0["user"]

    span = s1["t_sec"] - s0["t_sec"]
    print("", flush=True)
    print("--- 稳态区间 %.1fs ~ %.1fs（共 %.1fs，已排除前 %.0fs 冷启动热身）---"
          % (s0["t_sec"], s1["t_sec"], span, warmup), flush=True)
    print("WorkingSet    : %8.1f MB -> %8.1f MB   Δ %+7.1f MB" % (s0["workingSet"], s1["workingSet"], sd["workingSet"]), flush=True)
    print("PrivateBytes  : %8.1f MB -> %8.1f MB   Δ %+7.1f MB" % (s0["privateMB"], s1["privateMB"], sd["privateMB"]), flush=True)
    print("句柄数        : %8d    -> %8d      Δ %+7d" % (s0["handles"], s1["handles"], sd["handles"]), flush=True)
    print("线程数        : %8d    -> %8d      Δ %+7d" % (s0["threads"], s1["threads"], sd["threads"]), flush=True)
    if "gdi" in sd:
        print("GDI 对象      : %8d    -> %8d      Δ %+7d" % (s0["gdi"], s1["gdi"], sd["gdi"]), flush=True)
    if "user" in sd:
        print("USER 对象     : %8d    -> %8d      Δ %+7d" % (s0["user"], s1["user"], sd["user"]), flush=True)

    notes = []
    if sd["workingSet"] > 40: notes.append("WorkingSet 增长偏大")
    if sd["privateMB"] > 30: notes.append("PrivateBytes 增长偏大")
    if sd["handles"] > 150: notes.append("句柄数持续增长")
    if sd["threads"] > 15: notes.append("线程数持续增长")
    if sd.get("gdi", 0) > 40: notes.append("GDI 对象持续增长")
    if sd.get("user", 0) > 40: notes.append("USER 对象持续增长")

    if notes:
        print("结论: WARN —— " + " / ".join(notes), flush=True)
    else:
        print("结论: PASS —— 稳态区间内内存/句柄/线程/GDI/USER 均无持续增长趋势", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(run())
