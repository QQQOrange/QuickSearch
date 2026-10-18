# -*- coding: utf-8 -*-
"""跑回归之前先把残留的 QuickSearch 进程清干净。

为什么需要它：QuickSearch 是单例（靠命名互斥体），而它默认**会自提权**。
上一轮测试如果没正常退出，留下的就是管理员权限的进程 —— 普通
OpenProcess(PROCESS_TERMINATE) 会静默失败（返回 0），脚本看不出来，
于是下一轮每一句「another instance is running, exit」都被误判成
「我的新代码有 bug」。

这个坑踩过一次：OCR 结果窗口回归连挂两次，日志里根本没有新一轮的
「=== start」，只有一个孤零零的 "another instance is running"。

所以：先开 SeTerminatePrivilege，再杀，杀完复查，打印还剩几个。
"""
import ctypes
import ctypes.wintypes as w
import sys
import time

k32 = ctypes.windll.kernel32
adv = ctypes.windll.advapi32


def enable_terminate_privilege():
    class LUID(ctypes.Structure):
        _fields_ = [("LowPart", w.DWORD), ("HighPart", ctypes.c_long)]

    class LAA(ctypes.Structure):
        _fields_ = [("Luid", LUID), ("Attributes", w.DWORD)]

    adv.OpenProcessToken.restype = w.HANDLE
    tok = w.HANDLE()
    if not adv.OpenProcessToken(
        k32.GetCurrentProcess(), 0x0008 | 0x0020, ctypes.byref(tok)
    ):
        return False
    la = LAA()
    if not adv.LookupPrivilegeValueW(None, "SeTerminatePrivilege", ctypes.byref(la.Luid)):
        return False
    return bool(adv.AdjustTokenPrivileges(tok, False, ctypes.byref(la), 0, None, None))


class PE(ctypes.Structure):
    _fields_ = [
        ("dwSize", w.DWORD),
        ("cntUsage", w.DWORD),
        ("th32ProcessID", w.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", w.DWORD),
        ("cntThreads", w.DWORD),
        ("th32ParentProcessID", w.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", w.DWORD),
        ("szExeFile", w.WCHAR * 260),
    ]


def find_quicksearch():
    pe = PE()
    pe.dwSize = ctypes.sizeof(PE)
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    out = []
    if k32.Process32FirstW(snap, ctypes.byref(pe)):
        while True:
            if pe.szExeFile.lower() == "quicksearch.exe":
                out.append(pe.th32ProcessID)
            if not k32.Process32NextW(snap, ctypes.byref(pe)):
                break
    k32.CloseHandle(snap)
    return out


def kill(pids):
    killed = []
    for pid in pids:
        h = k32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
        if not h:
            print("  pid %d: OpenProcess 失败（权限不足？）" % pid)
            continue
        ok = k32.TerminateProcess(h, 1)
        k32.CloseHandle(h)
        print("  pid %d: terminate=%s" % (pid, ok))
        if ok:
            killed.append(pid)
    return killed


def main():
    if "--no-elevate" not in sys.argv:
        enable_terminate_privilege()
    before = find_quicksearch()
    if not before:
        print("没有残留进程")
        return 0
    print("发现残留 QuickSearch：%s" % before)
    kill(before)
    # 等它真的消失：TerminateProcess 是异步的，立刻启动新实例仍可能撞上互斥体
    for _ in range(30):
        time.sleep(0.1)
        if not find_quicksearch():
            break
    left = find_quicksearch()
    if left:
        print("!! 仍然存活：%s —— 后续测试会误报，先手动结束任务管理器里的它" % left)
        return 1
    print("已全部清理")
    return 0


if __name__ == "__main__":
    sys.exit(main())