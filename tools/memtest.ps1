# ============================================================================
#  内存泄漏采样器
#  跟踪 QuickSearch.exe 主进程 + 它拉起来的全部子进程（WebView2 渲染进程等），
#  按固定间隔记录 WorkingSet / PrivateBytes / 句柄数 / 线程数，最后给出趋势判定。
#
#  用法:
#    powershell -ExecutionPolicy Bypass -File memtest.ps1 -TotalSeconds 60 -IntervalSec 2
# ============================================================================
param(
    [int]$TotalSeconds = 60,
    [int]$IntervalSec  = 2,
    [string]$OutCsv    = "memtest.csv",
    [string]$RootName  = "QuickSearch"
)

$ErrorActionPreference = "SilentlyContinue"

function Get-ProcessTree {
    param([int]$RootPid)
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $ids = New-Object System.Collections.ArrayList
    [void]$ids.Add($RootPid)
    $again = $true
    while ($again) {
        $again = $false
        foreach ($p in $all) {
            $ppid = [int]$p.ParentProcessId
            $pid_ = [int]$p.ProcessId
            if ($ids -contains $ppid -and -not ($ids -contains $pid_)) {
                [void]$ids.Add($pid_)
                $again = $true
            }
        }
    }
    return $ids
}

$rows = @()
$n = [int]($TotalSeconds / $IntervalSec)
$t0 = Get-Date

for ($i = 0; $i -le $n; $i++) {
    $root = Get-Process -Name $RootName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $root) {
        Write-Host "[$i] QuickSearch 未在运行，结束采样"
        break
    }

    $ids   = Get-ProcessTree -RootPid $root.Id
    $procs = Get-Process -Id $ids -ErrorAction SilentlyContinue

    $ws = 0; $pv = 0; $hd = 0; $th = 0; $cnt = 0
    foreach ($p in $procs) {
        $ws += $p.WorkingSet64
        $pv += $p.PrivateMemorySize64
        $hd += $p.HandleCount
        $th += $p.Threads.Count
        $cnt++
    }

    $elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    $row = [pscustomobject]@{
        t_sec      = $elapsed
        procs      = $cnt
        workingSet = [math]::Round($ws / 1MB, 1)
        privateMB  = [math]::Round($pv / 1MB, 1)
        handles    = $hd
        threads    = $th
    }
    $rows += $row
    Write-Host ("[{0,6:N1}s] procs={1} WS={2,8:N1}MB Priv={3,8:N1}MB Handles={4,5} Threads={5,4}" -f `
        $row.t_sec, $row.procs, $row.workingSet, $row.privateMB, $row.handles, $row.threads)

    if ($i -lt $n) { Start-Sleep -Seconds $IntervalSec }
}

if ($rows.Count -eq 0) { Write-Host "没有采到数据"; exit 1 }

$rows | Export-Csv -Path $OutCsv -NoTypeInformation -Encoding UTF8

# --------------------------- 趋势判定 ---------------------------
$f = $rows[0]
$l = $rows[-1]
$dWs = $l.workingSet - $f.workingSet
$dPv = $l.privateMB  - $f.privateMB
$dHd = $l.handles    - $f.handles
$dTh = $l.threads    - $f.threads

Write-Host ""
Write-Host "=================== 汇总 ==================="
Write-Host ("样本数        : {0}  (历时 {1}s)" -f $rows.Count, $l.t_sec)
Write-Host ("WorkingSet    : {0,8:N1} MB -> {1,8:N1} MB    Δ {2,+7:N1} MB" -f $f.workingSet, $l.workingSet, $dWs)
Write-Host ("PrivateBytes  : {0,8:N1} MB -> {1,8:N1} MB    Δ {2,+7:N1} MB" -f $f.privateMB, $l.privateMB, $dPv)
Write-Host ("句柄数        : {0,8}    -> {1,8}       Δ {2,+7}"   -f $f.handles, $l.handles, $dHd)
Write-Host ("线程数        : {0,8}    -> {1,8}       Δ {2,+7}"   -f $f.threads, $l.threads, $dTh)
Write-Host ""

$verdict = "PASS"
$notes = @()
if ($dWs -gt 40)  { $verdict = "WARN"; $notes += "WorkingSet 增长偏大" }
if ($dPv -gt 40)  { $verdict = "WARN"; $notes += "PrivateBytes 增长偏大" }
if ($dHd -gt 200) { $verdict = "WARN"; $notes += "句柄数持续增长" }
if ($dTh -gt 20)  { $verdict = "WARN"; $notes += "线程数持续增长" }

if ($verdict -eq "PASS") {
    Write-Host "结论: PASS —— 整个压测周期内内存/句柄/线程均无持续增长趋势"
} else {
    Write-Host ("结论: WARN —— " + ($notes -join " / "))
}

