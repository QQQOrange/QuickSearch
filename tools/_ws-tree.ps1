# 打印一棵进程树的常驻内存合计（MB）。
#
# 为什么需要它：QuickSearch 是 Tauri（Rust 主进程 + 一窝 WebView2 子进程），
# 光看主进程的 WorkingSet 会漏掉真正吃内存的渲染/GPU 进程。这里按父子关系把
# 整棵树找齐再求和 —— A/B 对比时两边的口径必须完全一样。
#
# 用法：powershell -NoProfile -File tools\_ws-tree.ps1 <rootPid>
param([Parameter(Mandatory = $true)][int]$RootPid)

$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize, PrivatePageCount, Name

$byParent = @{}
foreach ($p in $all) { 
    $k = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($k)) { $byParent[$k] = New-Object System.Collections.ArrayList }
    [void]$byParent[$k].Add($p)
}

$stack = New-Object System.Collections.Stack
$stack.Push($RootPid)
$seen = @{}
$ws = 0L
$priv = 0L
$count = 0
$names = @()
while ($stack.Count -gt 0) {
    $cur = [int]$stack.Pop()
    if ($seen.ContainsKey($cur)) { continue }
    $seen[$cur] = $true
    $self = $all | Where-Object { [int]$_.ProcessId -eq $cur } | Select-Object -First 1
    if ($self) {
        # 只统计本案相关的进程名（QuickSearch 自己 + WebView2 那一窝）
        $n = [string]$self.Name
        if ($n -match '^(QuickSearch|msedgewebview2)') {
            $ws += [int64]$self.WorkingSetSize
            $priv += [int64]$self.PrivatePageCount
            $count++
            $names += $n
        }
    }
    if ($byParent.ContainsKey($cur)) {
        foreach ($c in $byParent[$cur]) { $stack.Push([int]$c.ProcessId) }
    }
}

'{0:N1} {1:N1} {2}' -f ($ws / 1MB), ($priv / 1MB), $count