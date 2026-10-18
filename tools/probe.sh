#!/bin/bash
# 一键诊断：启动一个配置组合 → 抓 PrintWindow → 截屏采样 → 退出
# 用法: ./probe.sh <标签> [KEY=VAL ...]
cd "C:/Users/64381/WorkBuddy/2026-10-10-16-56-30/QuickSearch-Win" || exit 1
ROOT="C:/Users/64381/WorkBuddy/2026-10-10-16-56-30"
NODE="C:/Users/64381/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PY="D:/Local AI/image/python_embeded/python.exe"

taskkill //IM QuickSearch.exe //F >/dev/null 2>&1
sleep 1

LABEL="$1"; shift

env QS_DEBUG=1 QS_NO_ELEVATE=1 QS_STATIC_POS=1 QS_T_POS=200,300 "$@" \
    ./target/release/QuickSearch.exe --no-elevate --hold >/dev/null 2>&1 &
PID=$!
sleep 7

echo "=== [$LABEL] ==="
"$NODE" tools/diag-child.js 2>&1 | grep -E '"(tag|cls|vis|rect|displayAffinity|pwNonBlack|pwAvgBright|pwAvgAlpha|pwMinAlpha|WS_EX_LAYERED)"|children' | sed 's/^/  /'
"$PY" "$ROOT/px.py" "$LABEL"
echo "  --- webview2 procs ---"
tasklist //FI "IMAGENAME eq msedgewebview2.exe" //FO CSV //NH 2>/dev/null | head -12 | sed 's/^/  /'

kill $PID >/dev/null 2>&1
sleep 1
taskkill //IM QuickSearch.exe //F >/dev/null 2>&1
