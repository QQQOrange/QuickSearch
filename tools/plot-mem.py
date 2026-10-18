# -*- coding: utf-8 -*-
"""把 memtest.ps1 采到的 CSV 画成内存趋势图（截图证据用）。

用法: python plot-mem.py memtest.csv memtest.png "标题"
"""
import sys, csv, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

csv_path = sys.argv[1] if len(sys.argv) > 1 else "memtest.csv"
out_path = sys.argv[2] if len(sys.argv) > 2 else "memtest.png"
title = sys.argv[3] if len(sys.argv) > 3 else "QuickSearch 内存泄漏压测"
warmup = float(sys.argv[4]) if len(sys.argv) > 4 else 30.0
churn_end = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0

t, ws, pv, hd, th, np_ = [], [], [], [], [], []
with open(csv_path, "r", encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        t.append(float(row["t_sec"]))
        ws.append(float(row["workingSet"]))
        pv.append(float(row["privateMB"]))
        hd.append(float(row["handles"]))
        th.append(float(row["threads"]))
        np_.append(float(row["procs"]))

fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8.4), sharex=True)
fig.suptitle(title, fontsize=15, fontweight="bold")

# --- 上：内存 ---
ax1.plot(t, ws, "-o", ms=3, lw=2, color="#d9480f", label="WorkingSet (MB)")
ax1.plot(t, pv, "-s", ms=3, lw=2, color="#1c7ed6", label="PrivateBytes (MB)")
ax1.set_ylabel("内存 / MB", fontsize=11)
ax1.grid(True, alpha=.3)
ax1.legend(loc="upper left", fontsize=10)
ax1.set_title("内存占用", fontsize=12)

# --- 下：句柄 / 线程 ---
ax2.plot(t, hd, "-^", ms=3, lw=2, color="#2f9e44", label="句柄数")
ax2.plot(t, th, "-v", ms=3, lw=2, color="#7048e8", label="线程数")
ax2.plot(t, np_, "--", lw=1.4, color="#868e96", label="进程数")
ax2.set_xlabel("运行时间 / 秒", fontsize=11)
ax2.set_ylabel("数量", fontsize=11)
ax2.grid(True, alpha=.3)
ax2.legend(loc="upper left", fontsize=10)
ax2.set_title("句柄 / 线程 / 进程", fontsize=12)

# --- 分区标注：热身 / 压测churn / 空闲稳态 ---
for ax in (ax1, ax2):
    if t[-1] > warmup > 0:
        ax.axvspan(t[0], warmup, color="#adb5bd", alpha=.22, zorder=0)
    if churn_end > warmup:
        ax.axvspan(warmup, churn_end, color="#ffd43b", alpha=.16, zorder=0)
        ax.axvline(churn_end, color="#f59f00", lw=1.2, ls=":", zorder=1)
if t[-1] > warmup > 0:
    ax1.text(warmup / 2, ax1.get_ylim()[1], " 冷启动热身\n (不计入判定)",
             fontsize=9, color="#495057", va="top")

# --- 稳态段首尾差值（判定依据） ---
st = [i for i, x in enumerate(t) if x >= warmup]
if len(st) >= 2:
    i0, i1 = st[0], st[-1]
    ds = [
        f"稳态区间 {t[i0]:.0f}s–{t[i1]:.0f}s",
        f"WorkingSet Δ {ws[i1]-ws[i0]:+.1f} MB",
        f"PrivateBytes Δ {pv[i1]-pv[i0]:+.1f} MB",
        f"句柄 Δ {hd[i1]-hd[i0]:+.0f}",
        f"线程 Δ {th[i1]-th[i0]:+.0f}",
    ]
    bad = (ws[i1] - ws[i0] > 40) or (pv[i1] - pv[i0] > 30) or (hd[i1] - hd[i0] > 150)
    verdict = "判定: WARN —— 存在持续增长" if bad else "判定: PASS —— 无持续增长趋势"
    fig.text(0.5, 0.005, "   |   ".join(ds) + "\n" + verdict, ha="center", fontsize=10.5,
             color="#c92a2a" if bad else "#2b8a3e", linespacing=1.6)

fig.tight_layout(rect=[0, 0.055, 1, 0.96])
fig.savefig(out_path, dpi=110)
print("saved", out_path)
print("  " + "\n  ".join(ds))
