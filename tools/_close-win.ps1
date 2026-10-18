# 给"指定进程的、标题以某个前缀开头的"顶层窗口发 WM_CLOSE
# （等价于用户点右上角的 X）。
#
# 为什么需要它：验证「设置页关掉一段时间后真正销毁」这条链路时，必须走**和用户
# 完全一样**的关闭路径（WM_CLOSE → Tauri CloseRequested → prevent_close + hide），
# 而不是用 CDP 去改 DOM —— CDP 里 window.close() 在 Tauri 的窗口模型下语义不同。
#
# 为什么按 PID + 标题前缀：机器上可能同时开着**用户自己的实例**（管理员权限、
# 脚本杀不掉），它的设置窗标题一模一样。只按标题找会点到别人家的窗口。
# 标题里那半个中文（"设置"）不参与匹配：Windows PowerShell 5.1 读没有 BOM 的
# .ps1 时按 ANSI 解码，中文会变乱码，索性只用 ASCII 前缀 "Quick Search"。
#
# 用法：powershell -NoProfile -File tools\_close-win.ps1 -RootPid 1234 [-Match settings]
param(
    [Parameter(Mandatory = $true)][int]$RootPid,
    [string]$Match = 'settings'
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class QsWin {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);

    public static List<string> Find(uint wantPid) {
        var found = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != wantPid) return true;
            int len = GetWindowTextLengthW(h);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 2);
            GetWindowTextW(h, sb, sb.Capacity);
            var t = sb.ToString();
            if (t.StartsWith("Quick Search", StringComparison.Ordinal)) {
                // 记成 hWnd|标题，交给外面筛
                found.Add(h.ToInt64().ToString() + "|" + t);
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool Close(long hwnd) {
        return PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}
"@

# 收集目标进程整棵树的 PID（设置窗可能由子进程持有，稳妥起见都算上）
$pids = New-Object System.Collections.Generic.HashSet[uint32]
[void]$pids.Add([uint32]$RootPid)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$changed = $true
while ($changed) {
    $changed = $false
    foreach ($p in $all) {
        if ($pids.Contains([uint32]$p.ParentProcessId) -and -not $pids.Contains([uint32]$p.ProcessId)) {
            [void]$pids.Add([uint32]$p.ProcessId)
            $changed = $true
        }
    }
}

$hits = @()
foreach ($id in $pids) {
    foreach ($w in [QsWin]::Find($id)) { $hits += $w }
}

if ($hits.Count -eq 0) { 'notfound'; exit 2 }

# 只关标题带指定关键字的那一个（ASCII 判定：标题尾部的中文不参与）
$target = $null
foreach ($h in $hits) {
    $parts = $h.Split('|')
    # 设置窗标题 = "Quick Search 设置"（ASCII 去掉后只剩 "Quick Search "）；
    # 横条窗标题不含 ASCII 之外的词。用"标题比横条窗长"来区分太脆，
    # 这里换成外部传入的 Match：settings 表示"标题里有非 ASCII 字符"。
    $title = $parts[1]
    $hasNonAscii = $false
    foreach ($ch in $title.ToCharArray()) { if ([int]$ch -gt 127) { $hasNonAscii = $true; break } }
    if (($Match -eq 'settings' -and $hasNonAscii) -or ($Match -eq 'any')) { $target = $parts[0]; break }
}

if (-not $target) { 'nontarget'; exit 3 }
[void][QsWin]::Close([int64]$target)
'closed'